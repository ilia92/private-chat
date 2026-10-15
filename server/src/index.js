import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { Connection, Hub } from './hub.js';
import { Store } from './store.js';

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const CONFIG_FILE = process.env.CONFIG_FILE || path.resolve('config/pchat.json');
// Set when running behind a reverse proxy (Caddy) so rate limits apply per real client.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const WEB_DIR = new URL('../../web/', import.meta.url);
const list = (value) => (value || '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = list(process.env.ALLOWED_ORIGINS);
const STUN_URLS = list(process.env.STUN_URLS);
const TURN_URLS = list(process.env.TURN_URLS);
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_CREDENTIAL_TTL = 24 * 3600;

const ROOM_PATH = /^\/[A-Za-z0-9._~-]{3,128}$/;
const FILE_PATH = /^\/api\/files\/([0-9a-f]{64})\/([0-9a-f]{32})$/;
const BEARER = /^Bearer ([0-9a-f]{64})$/;
const INVITE_PATH = /^\/api\/invites\/([0-9a-f]{64})$/;
const HOST = /^[A-Za-z0-9.-]+(:\d+)?$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Short-lived TURN credentials in coturn's "use-auth-secret" format. They are only
// handed to clients that already proved the room PIN, so strangers can't use the relay.
function iceServers() {
  const servers = [];
  if (STUN_URLS.length) servers.push({ urls: STUN_URLS });
  if (TURN_URLS.length && TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL}:pchat`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    servers.push({ urls: TURN_URLS, username, credential });
  }
  return servers;
}

// The frontend is a handful of small files, so serve them from memory.
const assets = new Map();
for (const name of readdirSync(WEB_DIR)) {
  const type = TYPES[path.extname(name)];
  if (type) assets.set(name, { type, body: readFileSync(new URL(name, WEB_DIR)) });
}
const indexPage = assets.get('index.html');

const SECURITY_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
};

function contentSecurityPolicy(req) {
  // Older Safari doesn't treat ws(s) as covered by 'self', so name the host explicitly.
  const host = HOST.test(req.headers.host ?? '') ? req.headers.host : '';
  const sockets = host ? ` wss://${host} ws://${host}` : '';
  return (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
    `connect-src 'self'${sockets}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  );
}

function respond(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function respondJson(res, status, body) {
  respond(res, status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify(body));
}

// Encrypted file blobs. Requests carry the room's PIN proof as a bearer token,
// exactly like joining over the WebSocket, so only members can read or write.
async function handleFile(req, res, ref, id) {
  const ip = clientIp(req);
  const access = hub.authorizeFiles(ip, ref, BEARER.exec(req.headers.authorization ?? '')?.[1]);
  if (access.error) {
    req.resume();
    return respondJson(res, access.status, { error: access.error });
  }
  const { room } = access;

  if (req.method === 'GET') {
    const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (room.mode === 'private') {
      const buffer = room.files.get(id);
      if (!buffer) return respondJson(res, 404, { error: 'not_found' });
      return respond(res, 200, { ...headers, 'Content-Length': buffer.length }, buffer);
    }
    const size = store.fileSize(room.ref, id);
    if (size === null) return respondJson(res, 404, { error: 'not_found' });
    res.writeHead(200, { ...SECURITY_HEADERS, ...headers, 'Content-Length': size });
    store.readFile(room.ref, id).on('error', () => res.destroy()).pipe(res);
    return;
  }

  const length = Number(req.headers['content-length']);
  const problem = hub.checkUpload(ip, room, id, length);
  if (problem) {
    req.resume();
    return respondJson(res, problem.status, { error: problem.error });
  }
  try {
    if (room.mode === 'private') {
      const chunks = [];
      let received = 0;
      for await (const chunk of req) {
        received += chunk.length;
        if (received > length) throw new Error('body longer than Content-Length');
        chunks.push(chunk);
      }
      if (received !== length) throw new Error('incomplete upload');
      const error = hub.addPrivateFile(room, id, Buffer.concat(chunks));
      if (error) return respondJson(res, 409, { error });
    } else {
      let received = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, done) {
          received += chunk.length;
          done(received > length ? new Error('body longer than Content-Length') : null, chunk);
        },
      });
      await store.saveFile(room.ref, id, req.pipe(limiter), length);
    }
    respondJson(res, 201, { id });
  } catch {
    if (!res.headersSent) respondJson(res, 400, { error: 'upload_failed' });
  }
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const invite = INVITE_PATH.exec(pathname);
  if (invite) {
    // POST, so link-preview bots and prefetchers (which GET) can't use up an invite.
    if (req.method !== 'POST') return respond(res, 405, {}, '');
    req.resume();
    const result = hub.redeemInvite(clientIp(req), invite[1]);
    return respondJson(res, result.status ?? 200, result.error ? { error: result.error } : { data: result.data });
  }
  const file = FILE_PATH.exec(pathname);
  if (file) {
    if (req.method !== 'GET' && req.method !== 'PUT') return respond(res, 405, {}, '');
    handleFile(req, res, file[1], file[2]).catch((err) => {
      console.error('file request failed', err);
      if (!res.headersSent) respondJson(res, 500, { error: 'server_error' });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return respond(res, 405, {}, '');
  if (pathname === '/healthz') return respond(res, 200, { 'Content-Type': 'text/plain' }, 'ok');

  let asset;
  if (pathname.startsWith('/static/')) {
    const name = pathname.slice('/static/'.length);
    if (name !== 'index.html') asset = assets.get(name);
  } else if (pathname === '/' || pathname === '/i' || ROOM_PATH.test(pathname)) {
    asset = indexPage;
  }
  if (!asset) return respond(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');

  respond(
    res,
    200,
    {
      'Content-Type': asset.type,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': contentSecurityPolicy(req),
    },
    req.method === 'HEAD' ? undefined : asset.body,
  );
});

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',').at(-1).trim();
  }
  return req.socket.remoteAddress;
}

// Blocks other websites from opening sockets from a visitor's browser. Non-browser
// clients send no Origin and could fake one anyway, so they are let through.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

mkdirSync(DATA_DIR, { recursive: true });
const config = loadConfig(CONFIG_FILE);
const store = new Store(DATA_DIR);
store.cleanupOrphans();
const hub = new Hub(store, iceServers, config);
// Large uploads on slow mobile connections can take a while.
server.requestTimeout = 30 * 60_000;
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws' || !originAllowed(req)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = new Connection(ws, clientIp(req));
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw, isBinary) => {
      let msg = null;
      try {
        if (!isBinary) msg = JSON.parse(raw.toString());
      } catch {}
      if (!msg || typeof msg !== 'object') return conn.error('bad_request');
      hub.handle(conn, msg);
    });
    ws.on('close', () => hub.leave(conn));
    ws.on('error', () => {});
  });
});

// Drop connections that stopped answering pings (closed laptops, dead mobile networks).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    store.close();
    process.exit(0);
  });
}

const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
server.listen(PORT, () =>
  console.log(
    `pchat listening on :${PORT} · private files ${mb(config.privateRooms.maxFileBytes)}/file, ` +
      `${mb(config.privateRooms.maxRoomBytes)}/room, ${mb(config.privateRooms.maxTotalBytes)} total RAM · ` +
      `logged files ${mb(config.loggedRooms.maxFileBytes)}/file, ${mb(config.loggedRooms.maxRoomBytes)}/room · ` +
      `invites valid ${config.invites.ttlMs / 60_000} min`,
  ),
);
