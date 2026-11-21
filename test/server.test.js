'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createServer } = require('../server');

async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function req(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

test('GET / serves the page and the data-evidence-result hook', async () => {
  await withServer(async (base) => {
    const res = await req(base, 'GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.text, /data-evidence-result/);
    assert.match(res.text, /生成第一版随访/);
    assert.match(res.text, /补录托盘清点/);
    assert.match(res.text, /查看出芽分母/);
  });
});

test('static assets are served and unknown routes 404 as JSON', async () => {
  await withServer(async (base) => {
    assert.equal((await req(base, 'GET', '/app.js')).status, 200);
    assert.equal((await req(base, 'GET', '/style.css')).status, 200);
    const missing = await req(base, 'GET', '/api/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'NOT_FOUND');
  });
});

test('archive before first follow-up returns 409', async () => {
  await withServer(async (base) => {
    const res = await req(base, 'POST', '/api/archive');
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'FIRST_RUN_REQUIRED');
  });
});

test('denominators before any follow-up returns 409', async () => {
  await withServer(async (base) => {
    const res = await req(base, 'POST', '/api/denominators');
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'FIRST_RUN_REQUIRED');
  });
});

test('full happy path: first -> archive -> denominators', async () => {
  await withServer(async (base) => {
    const first = await req(base, 'POST', '/api/followup/first', { seed: 'tray-2026' });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.report.looks.map((l) => l.lookId), ['R1']);
    assert.equal(first.json.stage, 'first');

    const archive = await req(base, 'POST', '/api/archive', {});
    assert.equal(archive.status, 200);
    assert.deepEqual(archive.json.report.looks.map((l) => l.lookId), ['R1', 'R2']);
    assert.ok(archive.json.report.changedCount > 0);
    assert.equal(archive.json.stage, 'archive');

    const denom = await req(base, 'POST', '/api/denominators', {});
    assert.equal(denom.status, 200);
    assert.ok(denom.json.denominators.notObserved.length > 0);
    assert.ok(denom.json.denominators.looks.every((l) => l.evaluable === l.sprouted + l.noSprout));
  });
});

test('same seed returns byte-identical reports across requests', async () => {
  await withServer(async (base) => {
    await req(base, 'POST', '/api/followup/first', { seed: 'repeatable' });
    const a = await req(base, 'POST', '/api/archive', {});
    await req(base, 'POST', '/api/session/reset', { seed: 'repeatable' });
    await req(base, 'POST', '/api/followup/first', { seed: 'repeatable' });
    const b = await req(base, 'POST', '/api/archive', {});
    assert.deepEqual(a.json.report.byLook, b.json.report.byLook);
    assert.deepEqual(a.json.report.changeList, b.json.report.changeList);
  });
});

test('invalid seed is rejected with 400', async () => {
  await withServer(async (base) => {
    const res = await req(base, 'POST', '/api/followup/first', { seed: 42 });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'INVALID_SEED');
  });
});

test('malformed JSON is rejected with 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/followup/first', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_JSON');
  });
});

test('reset returns to idle state and clears reports', async () => {
  await withServer(async (base) => {
    await req(base, 'POST', '/api/followup/first', { seed: 'tray-2026' });
    await req(base, 'POST', '/api/archive', {});
    const reset = await req(base, 'POST', '/api/session/reset', { seed: 'tray-2026' });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.stage, 'idle');
    assert.equal(reset.json.reports.first, null);
    assert.equal(reset.json.reports.archive, null);
    const again = await req(base, 'GET', '/api/state');
    assert.equal(again.json.stage, 'idle');
  });
});

test('static file serving cannot escape the public directory', async () => {
  await withServer(async (base) => {
    // Only three literal file names are routed; everything else is JSON 404.
    for (const target of ['/../server.js', '/..%2fserver.js', '/public/../server.js', '/%2e%2e/server.js']) {
      const res = await fetch(base + target);
      const text = await res.text();
      assert.equal(res.status, 404, `${target} should not be served`);
      assert.ok(!text.includes('createHandler'), `${target} must not leak server source`);
      const body = JSON.parse(text);
      assert.equal(body.error.code, 'NOT_FOUND');
    }
  });
});
