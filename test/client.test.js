'use strict';

// Loads public/app.js in a minimal fake DOM and drives the three buttons
// against a real server instance. This catches client-side wiring breakage
// (missing element ids, render crashes, evidence string not updating) that
// the JSON-only server tests cannot see.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createServer } = require('../server');

function makeElement(id, initial) {
  return {
    id,
    hidden: Boolean(initial && initial.hidden),
    disabled: Boolean(initial && initial.disabled),
    textContent: '',
    innerHTML: '',
    dataset: {},
    value: '',
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
  };
}

function readHtmlState() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const state = new Map();
  for (const match of html.matchAll(/<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const attrs = match[2];
    state.set(match[3], {
      hidden: /\bhidden\b/.test(attrs),
      disabled: /\bdisabled\b/.test(attrs),
    });
  }
  return state;
}

async function loadApp(base) {
  const initial = readHtmlState();
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id, initial.get(id)));
      return elements.get(id);
    },
  };

  const fakeFetch = (url, opts) => fetch(base + url, opts);
  const context = vm.createContext({
    document,
    console,
    JSON,
    Math,
    String,
    Number,
    Object,
    Array,
    Set,
    Map,
    Error,
    Promise,
    fetch: fakeFetch,
    setTimeout,
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'app.js' });

  const el = (id) => document.getElementById(id);
  return {
    el,
    async click(id) {
      const handler = el(id).listeners.click;
      assert.ok(handler, `${id} should have a click handler`);
      await handler();
    },
  };
}

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

test('page boots into idle with the evidence hook set', async () => {
  await withServer(async (base) => {
    const app = await loadApp(base);
    assert.equal(app.el('evidence').dataset.evidenceResult, 'stage=idle');
    assert.equal(app.el('stage-badge').textContent, '尚未生成');
    assert.equal(app.el('btn-archive').disabled, true);
  });
});

test('three buttons produce real results and update data-evidence-result', async () => {
  await withServer(async (base) => {
    const app = await loadApp(base);
    app.el('seed').value = 'client-seed';

    await app.click('btn-first');
    const firstEvidence = app.el('evidence').dataset.evidenceResult;
    assert.match(firstEvidence, /stage=first/);
    assert.match(firstEvidence, /R1 .*已出芽=\d+/);
    assert.match(app.el('summary-cards').innerHTML, /已出芽/);
    assert.equal(app.el('report-root').hidden, false);
    assert.equal(app.el('btn-archive').disabled, false);
    // First version has no R2 column and no change list.
    assert.doesNotMatch(app.el('look-table').innerHTML, /R2<\/strong>/);
    assert.equal(app.el('changes').hidden, true);

    await app.click('btn-archive');
    const archiveEvidence = app.el('evidence').dataset.evidenceResult;
    assert.match(archiveEvidence, /stage=archive/);
    assert.match(archiveEvidence, /R2 .*已出芽=\d+/);
    assert.notEqual(archiveEvidence, firstEvidence);
    assert.match(app.el('changes').innerHTML, /change-item|没有样本改变结论/);
    assert.match(app.el('changes-title').textContent, /改变结论/);
    assert.match(app.el('anomaly-table').innerHTML, /orphan-observation/);

    await app.click('btn-denominators');
    assert.equal(app.el('denominator-root').hidden, false);
    assert.match(app.el('denominator-body').innerHTML, /未观察到（不进分母）/);
    assert.match(app.el('denominator-body').innerHTML, /未出芽/);
    assert.match(app.el('denominator-body').innerHTML, /累计/);
    assert.match(app.el('denominator-body').innerHTML, /首次出芽归属当时批次/);
    // Still the archive-stage evidence, not reset by viewing denominators.
    assert.equal(app.el('evidence').dataset.evidenceResult, archiveEvidence);
  });
});

test('archive click before first shows an error and keeps stage idle', async () => {
  await withServer(async (base) => {
    const app = await loadApp(base);
    await app.click('btn-archive');
    assert.equal(app.el('error').hidden, false);
    assert.match(app.el('error').textContent, /请先生成第一版随访/);
    assert.equal(app.el('evidence').dataset.evidenceResult, 'stage=idle');
    assert.equal(app.el('report-root').hidden, true);
  });
});

test('changing the seed and resetting returns the page to idle', async () => {
  await withServer(async (base) => {
    const app = await loadApp(base);
    app.el('seed').value = 'another-seed';
    await app.click('btn-first');
    await app.click('btn-denominators');
    assert.equal(app.el('denominator-root').hidden, false);

    app.el('seed').value = 'another-seed';
    await app.click('reset');
    assert.equal(app.el('evidence').dataset.evidenceResult, 'stage=idle');
    assert.equal(app.el('stage-badge').textContent, '尚未生成');
    assert.equal(app.el('report-root').hidden, true);
    assert.equal(app.el('denominator-root').hidden, true);
    assert.equal(app.el('btn-archive').disabled, true);
    assert.equal(app.el('error').hidden, true);
  });
});
