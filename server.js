'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./lib/errors');
const store = require('./lib/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 64 * 1024;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new AppError('BODY_TOO_LARGE', '请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new AppError('INVALID_JSON', '请求体必须是 JSON 对象', 400));
        }
        resolve(parsed);
      } catch {
        reject(new AppError('INVALID_JSON', '请求体不是合法 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, fileName, contentType) {
  const full = path.join(PUBLIC_DIR, fileName);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '禁止访问' } });
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '资源不存在' } });
      return;
    }
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

function createHandler() {
  const session = store.createSession();

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === 'GET /' || route === 'GET /index.html') {
        serveStatic(res, 'index.html', 'text/html; charset=utf-8');
        return;
      }
      if (route === 'GET /app.js') {
        serveStatic(res, 'app.js', 'text/javascript; charset=utf-8');
        return;
      }
      if (route === 'GET /style.css') {
        serveStatic(res, 'style.css', 'text/css; charset=utf-8');
        return;
      }
      if (route === 'GET /api/state') {
        sendJson(res, 200, store.stateOf(session));
        return;
      }
      if (route === 'POST /api/session/reset') {
        const body = await readBody(req);
        store.resetSession(session, body.seed);
        sendJson(res, 200, store.stateOf(session));
        return;
      }
      if (route === 'POST /api/followup/first') {
        const body = await readBody(req);
        if (body.seed !== undefined) store.resetSession(session, body.seed);
        const report = store.runFirstFollowup(session);
        sendJson(res, 200, { stage: session.stage, report, state: store.stateOf(session) });
        return;
      }
      if (route === 'POST /api/archive') {
        await readBody(req);
        const report = store.runArchivePass(session);
        sendJson(res, 200, { stage: session.stage, report, state: store.stateOf(session) });
        return;
      }
      if (route === 'POST /api/denominators') {
        await readBody(req);
        const denominators = store.runDenominators(session);
        sendJson(res, 200, { stage: session.stage, denominators, state: store.stateOf(session) });
        return;
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
    } catch (err) {
      if (err instanceof AppError) {
        sendJson(res, err.status, {
          error: { code: err.code, message: err.message, details: err.details || null },
        });
        return;
      }
      sendJson(res, 500, {
        error: { code: 'INTERNAL', message: err && err.message ? err.message : '服务器内部错误' },
      });
    }
  };
}

function createServer() {
  return http.createServer(createHandler());
}

function start() {
  const rawPort = process.env.PORT;
  const port = rawPort === undefined || rawPort === '' ? 3000 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT 无效：${rawPort}`);
    process.exit(1);
  }
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    const { port: actual } = server.address();
    console.log(`托盘随访演示已启动：http://127.0.0.1:${actual}`);
  });
  return server;
}

if (require.main === module) start();

module.exports = { createServer, createHandler, start };
