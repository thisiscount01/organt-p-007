'use strict';
/**
 * 프론트(556002) 소유 — 로컬 개발/검증 전용 서버. server.js(백엔드 소유)는 손대지 않는다.
 *
 * server.js가 아직 public/ 정적 서빙(express.static)을 갖추지 않은 상태([리스크]로 REPORTS에 보고함)라,
 * 배포 전까지 프론트가 "실제 배포 방식과 동일한 단일 오리진"으로 눈으로 확인하려면 이 프록시가 필요하다.
 * server.js를 원본 그대로 별도 포트(BACKEND_PORT)에 띄워두고, 이 서버가:
 *   - GET 그 외 정적 파일 → public/ 에서 서빙
 *   - /api/*, /socket.io/* → BACKEND_PORT로 그대로 프록시(WS 업그레이드 포함)
 * 로 묶어 브라우저 입장에서 단일 오리진처럼 보이게 한다.
 *
 * server.js가 express.static을 갖추면(백엔드 인도분 반영 시) 이 파일은 폐기해도 된다 — 그때까지의
 * 임시 다리다. 사용법: BACKEND_PORT=3000 node server.js & 다음 DEV_PORT=8080 BACKEND_PORT=3000 node scripts/dev-server.js
 */
const path = require('path');
const http = require('http');
const express = require('express');
const httpProxy = require('http-proxy');

const DEV_PORT = process.env.DEV_PORT || 8080;
const BACKEND_PORT = process.env.BACKEND_PORT || 3000;
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`;

const app = express();
const proxy = httpProxy.createProxyServer({ target: BACKEND_ORIGIN, ws: true });
proxy.on('error', (err, req, res) => {
  console.error('[dev-server] proxy error:', err.message);
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'backend_unreachable', detail: err.message }));
  }
});

// 경로 접두사 방식(app.use('/api', fn))은 express가 req.url에서 '/api'를 잘라내 넘기므로
// 프록시 타깃에 그대로 포워드하면 백엔드가 라우트를 못 찾는다(재현 확인) — req.url을 원본 그대로
// 보존해야 하니 전체 미들웨어에서 prefix만 검사하고 실제 프록시 호출은 그대로 넘긴다.
app.use((req, res, next) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/socket.io')) {
    return proxy.web(req, res);
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use((req, res) => res.status(404).send('not_found'));

const server = http.createServer(app);
// Socket.IO는 HTTP 업그레이드(WS)로 붙는다 — 이 이벤트를 프록시로 넘겨야 room:join 등이 동작한다.
server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/socket.io')) {
    proxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(DEV_PORT, () => {
  console.log(`[dev-server] http://127.0.0.1:${DEV_PORT} (proxy → ${BACKEND_ORIGIN})`);
});
