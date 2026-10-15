// End-to-end protocol check against a running server, using the real browser crypto code.
// Usage: node scripts/smoke-test.mjs [ws://localhost:8085/ws]
import { deriveKeys, encryptJSON, decryptJSON } from '../web/crypto.js';

const URL = process.argv[2] || 'ws://localhost:8085/ws';
let failures = 0;

function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
}

// Minimal client: buffers incoming messages so tests can await them in order.
function client() {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const waiter = waiters.shift();
    waiter ? waiter(msg) : inbox.push(msg);
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return {
    ws,
    async send(msg) {
      await opened;
      ws.send(JSON.stringify(msg));
    },
    next(timeout = 3000) {
      if (inbox.length) return Promise.resolve(inbox.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeout);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    close: () => ws.close(),
  };
}

async function entry(t, roomId, pin, nick, extra = {}) {
  const keys = await deriveKeys(roomId, pin);
  const c = client();
  await c.send({ t, room: keys.ref, auth: keys.auth, nick: await encryptJSON(keys.encKey, keys.ref, nick), ...extra });
  return { c, keys, reply: await c.next() };
}

const roomId = `smoke-${crypto.randomUUID()}`;

// Private room: create, join, chat, wrong PIN, destroy.
const a = await entry('create', roomId, '1234-pin', 'alice', { mode: 'private', ttl: 60_000 });
check('create private room', a.reply.t === 'joined' && a.reply.created && a.reply.mode === 'private');

const dup = await entry('create', roomId, 'other', 'mallory', { mode: 'private' });
check('duplicate create rejected', dup.reply.t === 'error' && dup.reply.code === 'exists');
dup.c.close();

const wrong = await entry('join', roomId, 'wrong-pin', 'mallory');
check('wrong PIN rejected', wrong.reply.t === 'error' && wrong.reply.code === 'bad_pin');
wrong.c.close();

const b = await entry('join', roomId, '1234-pin', 'bob');
check('join with correct PIN', b.reply.t === 'joined' && b.reply.members.length === 2);
const presence = await a.c.next();
check(
  'presence event carries encrypted nick',
  presence.t === 'presence' && (await decryptJSON(a.keys.encKey, a.keys.ref, presence.event.nick)) === 'bob',
);

await a.c.send({ t: 'msg', data: await encryptJSON(a.keys.encKey, a.keys.ref, { n: 'alice', s: 'x', m: 'hello bob' }) });
const echoed = await a.c.next();
const received = await b.c.next();
check('message relayed to both', echoed.t === 'msg' && received.t === 'msg');
check('message decrypts for bob', (await decryptJSON(b.keys.encKey, b.keys.ref, received.data)).m === 'hello bob');
check('message has a server id', echoed.id === 1 && received.id === 1);

await a.c.send({ t: 'eph', data: await encryptJSON(a.keys.encKey, a.keys.ref, { k: 'typing', n: 'alice' }) });
const eph = await b.c.next();
check('typing event relayed to others', eph.t === 'eph' && eph.from === a.reply.you);

// Alice must not get her own typing event back: her next message is the ICE reply.
await a.c.send({ t: 'ice' });
const ice = await a.c.next();
check('ICE reply includes TURN credentials', ice.t === 'ice' && ice.servers.some((s) => s.username && s.credential));

await a.c.send({ t: 'call', on: true });
const callA = await a.c.next();
const callB = await b.c.next();
check(
  'call join broadcast to everyone',
  callA.event?.kind === 'call-join' && callB.members.find((m) => m.id === a.reply.you)?.inCall === true,
);
await a.c.send({ t: 'signal', to: b.reply.you, data: await encryptJSON(a.keys.encKey, a.keys.ref, { type: 'offer' }) });
const signal = await b.c.next();
check('signal relayed to its target', signal.t === 'signal' && signal.from === a.reply.you);
await a.c.send({ t: 'call', on: false });
await a.c.next();
await b.c.next();

const late = await entry('join', roomId, '1234-pin', 'carol');
check('late joiner gets RAM history', late.reply.history.length === 1);
late.c.close();

await b.c.send({ t: 'destroy' });
let destroyedA;
do destroyedA = await a.c.next();
while (destroyedA.t === 'presence');
check('destroy reaches everyone', destroyedA.t === 'destroyed' && destroyedA.reason === 'deleted');
const gone = await entry('join', roomId, '1234-pin', 'alice');
check('destroyed room is gone', gone.reply.code === 'not_found');
gone.c.close();

// Logged room: history survives everyone leaving.
const loggedId = `smoke-logged-${crypto.randomUUID()}`;
const l1 = await entry('create', loggedId, 'pin', 'alice', { mode: 'logged' });
check('create logged room', l1.reply.mode === 'logged');
await l1.c.send({ t: 'msg', data: await encryptJSON(l1.keys.encKey, l1.keys.ref, { n: 'alice', s: 'x', m: 'saved' }) });
await l1.c.next();
l1.c.close();
await new Promise((r) => setTimeout(r, 200));
const l2 = await entry('join', loggedId, 'pin', 'alice');
check(
  'logged history persists after everyone left',
  l2.reply.history.length === 1 && (await decryptJSON(l2.keys.encKey, l2.keys.ref, l2.reply.history[0].data)).m === 'saved',
);
await l2.c.send({ t: 'destroy' });
await l2.c.next();

// Room size cap.
const capId = `smoke-cap-${crypto.randomUUID()}`;
const members = [await entry('create', capId, 'p', 'm0', { mode: 'private' })];
for (let i = 1; i < 5; i++) members.push(await entry('join', capId, 'p', `m${i}`));
const sixth = await entry('join', capId, 'p', 'm5');
check('sixth member rejected', sixth.reply.code === 'room_full');
for (const m of [...members, sixth]) m.c.close();

// Files and private -> logged conversion.
const HTTP = URL.replace(/^ws/, 'http').replace(/\/ws$/, '');
const fileUrl = (ref, id) => `${HTTP}/api/files/${ref}/${id}`;
const put = (ref, auth, id, body) =>
  fetch(fileUrl(ref, id), { method: 'PUT', headers: { Authorization: `Bearer ${auth}` }, body });
const get = (ref, auth, id) => fetch(fileUrl(ref, id), { headers: { Authorization: `Bearer ${auth}` } });
const fileId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

const filesRoom = `smoke-files-${crypto.randomUUID()}`;
const f1 = await entry('create', filesRoom, 'pin', 'alice', { mode: 'private' });
check('joined reports file limits', f1.reply.files?.maxFile > 0 && f1.reply.files.used === 0);
const blob = new Uint8Array(300_000).map((_, i) => (i * 31 + (i >> 8)) & 255);
const id1 = fileId();
check('upload to private room (RAM)', (await put(f1.keys.ref, f1.keys.auth, id1, blob)).status === 201);
const back = new Uint8Array(await (await get(f1.keys.ref, f1.keys.auth, id1)).arrayBuffer());
check('download returns identical bytes', back.length === blob.length && back.every((v, i) => v === blob[i]));
const wrongAuth = 'f'.repeat(64);
check('download with wrong PIN refused', (await get(f1.keys.ref, wrongAuth, id1)).status === 403);
check('duplicate file id refused', (await put(f1.keys.ref, f1.keys.auth, id1, blob)).status === 409);
const huge = new Uint8Array(f1.reply.files.maxFile + 1024 * 1024);
check('file over the private limit refused', (await put(f1.keys.ref, f1.keys.auth, fileId(), huge)).status === 413);

await f1.c.send({ t: 'msg', data: await encryptJSON(f1.keys.encKey, f1.keys.ref, { k: 'file', id: id1 }) });
const fileMsg = await f1.c.next();
await f1.c.send({ t: 'persist', inactiveDays: 30 });
const mode = await f1.c.next();
check('persist switches room to logged', mode.t === 'mode' && mode.mode === 'logged' && mode.inactiveDays === 30);
check('logged limits apply after persist', mode.files.maxFile > f1.reply.files.maxFile && mode.files.used === blob.length);
await f1.c.send({ t: 'msg', data: await encryptJSON(f1.keys.encKey, f1.keys.ref, { m: 'after' }) });
const after = await f1.c.next();
check('message ids continue after persist', after.id === fileMsg.id + 1);
f1.c.close();
await new Promise((r) => setTimeout(r, 300));
const f2 = await entry('join', filesRoom, 'pin', 'alice');
check('converted history survives everyone leaving', f2.reply.mode === 'logged' && f2.reply.history.map((h) => h.id).join() === `${fileMsg.id},${after.id}`);
const back2 = new Uint8Array(await (await get(f2.keys.ref, f2.keys.auth, id1)).arrayBuffer());
check('RAM file moved to disk intact', back2.length === blob.length && back2.every((v, i) => v === blob[i]));
const id2 = fileId();
check('upload to logged room (disk)', (await put(f2.keys.ref, f2.keys.auth, id2, blob.subarray(0, 1000))).status === 201);
await f2.c.send({ t: 'destroy' });
await f2.c.next();
check('files gone after destroy', (await get(f2.keys.ref, f2.keys.auth, id2)).status === 404);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
