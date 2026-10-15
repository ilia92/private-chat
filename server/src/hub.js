import crypto from 'node:crypto';

export const LIMITS = {
  maxMembers: 5,
  historyLimit: 500,
  maxBlobLength: 48 * 1024,
  maxEphemeralLength: 4 * 1024,
  maxNickLength: 1024,
  ttlMin: 5 * 60_000,
  ttlMax: 7 * 24 * 3600_000,
  ttlDefault: 12 * 3600_000,
  maxRooms: 5000,
  failWindow: 10 * 60_000,
  ipFailMax: 10,
  roomFailMax: 30,
  createsPerIpPerHour: 30,
  uploadsPerIpPer10Min: 120,
  maxInviteLength: 2048,
  maxInvitesPerRoom: 20,
};

const HEX64 = /^[0-9a-f]{64}$/;
export const FILE_ID = /^[0-9a-f]{32}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sameHash = (a, b) => crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const isBlob = (value, max) => typeof value === 'string' && value.length <= max && BASE64.test(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Fixed-window counter used for brute-force and abuse limits.
class Throttle {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  hit(key) {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || now - entry.start > this.windowMs) {
      entry = { start: now, count: 0 };
      this.entries.set(key, entry);
    }
    entry.count++;
  }

  blocked(key) {
    const entry = this.entries.get(key);
    return !!entry && Date.now() - entry.start <= this.windowMs && entry.count >= this.max;
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.start > this.windowMs) this.entries.delete(key);
    }
  }
}

// Per-connection flood protection.
class TokenBucket {
  constructor(perSec, burst) {
    this.perSec = perSec;
    this.burst = burst;
    this.tokens = burst;
    this.refilledAt = Date.now();
  }

  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.refilledAt) / 1000) * this.perSec);
    this.refilledAt = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

export class Connection {
  constructor(ws, ip) {
    this.ws = ws;
    this.ip = ip;
    this.id = crypto.randomBytes(6).toString('hex');
    this.room = null;
    this.nick = null;
    this.inCall = false;
    this.messages = new TokenBucket(5, 20);
    // WebRTC setup sends bursts of ICE candidates to every peer.
    this.signals = new TokenBucket(30, 200);
  }

  send(message) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  error(code) {
    this.send({ t: 'error', code });
  }
}

class Room {
  constructor(ref, mode, authHash, { expiresAt = null, inactiveDays = 0 } = {}) {
    this.ref = ref;
    this.mode = mode;
    this.authHash = authHash;
    this.expiresAt = expiresAt;
    this.inactiveDays = inactiveDays;
    this.members = new Map();
    this.history = [];
    this.seq = 0;
    this.timer = null;
    // Private rooms only: encrypted files held in RAM, id -> Buffer.
    this.files = new Map();
    this.fileBytes = 0;
  }

  memberList() {
    return [...this.members.values()].map((c) => ({ id: c.id, nick: c.nick, inCall: c.inCall }));
  }
}

// Routes client messages to rooms. The server never sees room IDs, PINs, nicknames
// or message text: clients send a hash of the room ID (`room`), a key derived from
// the PIN (`auth`, stored only as its SHA-256), and encrypted blobs.
export class Hub {
  constructor(store, iceServers, config) {
    this.store = store;
    this.iceServers = iceServers;
    this.config = config;
    this.rooms = new Map();
    this.privateFileBytes = 0;
    // Pending invite links: hash of the link secret -> encrypted room credentials.
    this.invites = new Map();
    this.ipUploads = new Throttle(LIMITS.uploadsPerIpPer10Min, 10 * 60_000);
    this.ipFails = new Throttle(LIMITS.ipFailMax, LIMITS.failWindow);
    this.roomFails = new Throttle(LIMITS.roomFailMax, LIMITS.failWindow);
    this.ipCreates = new Throttle(LIMITS.createsPerIpPerHour, 3600_000);
    setInterval(() => this.sweep(), 60_000).unref();
  }

  handle(conn, msg) {
    if (msg.t === 'create') return this.create(conn, msg);
    if (msg.t === 'join') return this.join(conn, msg);
    if (!conn.room) return conn.error('not_joined');
    switch (msg.t) {
      case 'msg':
        return this.message(conn, msg);
      case 'eph':
        return this.ephemeral(conn, msg);
      case 'call':
        return this.call(conn, msg);
      case 'signal':
        return this.signal(conn, msg);
      case 'ice':
        return conn.send({ t: 'ice', servers: this.iceServers() });
      case 'persist':
        return this.persist(conn, msg);
      case 'invite':
        return this.createInvite(conn, msg);
      case 'destroy':
        return this.destroy(conn.room, 'deleted');
      default:
        return conn.error('bad_request');
    }
  }

  validEntry(conn, msg) {
    if (conn.room) {
      conn.error('already_joined');
      return false;
    }
    if (!HEX64.test(msg.room) || !HEX64.test(msg.auth) || !isBlob(msg.nick, LIMITS.maxNickLength)) {
      conn.error('bad_request');
      return false;
    }
    return true;
  }

  create(conn, msg) {
    if (!this.validEntry(conn, msg)) return;
    if (this.ipCreates.blocked(conn.ip)) return conn.error('rate_limited');
    if (this.rooms.has(msg.room) || this.store.getRoom(msg.room)) return conn.error('exists');
    if (this.rooms.size >= LIMITS.maxRooms) return conn.error('server_full');
    this.ipCreates.hit(conn.ip);

    const authHash = sha256(msg.auth);
    let room;
    if (msg.mode === 'logged') {
      const inactiveDays = clamp(Math.floor(Number(msg.inactiveDays)) || 0, 0, 365);
      this.store.createRoom(msg.room, authHash, inactiveDays);
      room = new Room(msg.room, 'logged', authHash, { inactiveDays });
    } else {
      const ttl = clamp(Number(msg.ttl) || LIMITS.ttlDefault, LIMITS.ttlMin, LIMITS.ttlMax);
      room = new Room(msg.room, 'private', authHash, { expiresAt: Date.now() + ttl });
      room.timer = setTimeout(() => this.destroy(room, 'expired'), ttl);
    }
    this.rooms.set(room.ref, room);
    this.admit(conn, room, msg.nick, true);
  }

  join(conn, msg) {
    if (!this.validEntry(conn, msg)) return;
    if (this.ipFails.blocked(conn.ip) || this.roomFails.blocked(msg.room)) return conn.error('rate_limited');

    let room = this.rooms.get(msg.room);
    if (!room) room = this.loadLogged(msg.room);
    if (!room) {
      this.ipFails.hit(conn.ip);
      return conn.error('not_found');
    }
    if (!sameHash(sha256(msg.auth), room.authHash)) {
      this.ipFails.hit(conn.ip);
      this.roomFails.hit(msg.room);
      return conn.error('bad_pin');
    }
    if (room.members.size >= LIMITS.maxMembers) return conn.error('room_full');

    // Logged rooms are loaded into memory only while someone is in them.
    if (!this.rooms.has(room.ref)) this.rooms.set(room.ref, room);
    this.admit(conn, room, msg.nick, false);
  }

  loadLogged(ref) {
    const row = this.store.getRoom(ref);
    if (!row) return null;
    const room = new Room(ref, 'logged', row.auth_hash, { inactiveDays: row.inactive_days });
    room.seq = this.store.maxSeq(ref);
    return room;
  }

  fileLimits(room) {
    const limits = room.mode === 'logged' ? this.config.loggedRooms : this.config.privateRooms;
    const used = room.mode === 'logged' ? this.store.roomFileBytes(room.ref) : room.fileBytes;
    return { maxFile: limits.maxFileBytes, maxRoom: limits.maxRoomBytes, used };
  }

  admit(conn, room, nick, created) {
    conn.room = room;
    conn.nick = nick;
    room.members.set(conn.id, conn);
    if (room.mode === 'logged') this.store.touch(room.ref);

    conn.send({
      t: 'joined',
      you: conn.id,
      created,
      mode: room.mode,
      expiresAt: room.expiresAt,
      inactiveDays: room.inactiveDays,
      maxMembers: LIMITS.maxMembers,
      files: this.fileLimits(room),
      members: room.memberList(),
      history: room.mode === 'logged' ? this.store.history(room.ref, LIMITS.historyLimit) : room.history,
    });
    this.broadcast(room, { t: 'presence', members: room.memberList(), event: { kind: 'join', id: conn.id, nick } }, conn);
  }

  message(conn, msg) {
    const room = conn.room;
    if (!isBlob(msg.data, LIMITS.maxBlobLength)) return conn.error('too_large');
    if (!conn.messages.take()) return conn.error('slow_down');

    const item = { id: ++room.seq, ts: Date.now(), data: msg.data };
    if (room.mode === 'logged') {
      this.store.addMessage(room.ref, item);
    } else {
      room.history.push(item);
      if (room.history.length > LIMITS.historyLimit) room.history.shift();
    }
    this.broadcast(room, { t: 'msg', ...item });
  }

  // Short-lived events such as "typing…": relayed to the others, never stored.
  ephemeral(conn, msg) {
    if (!isBlob(msg.data, LIMITS.maxEphemeralLength) || !conn.signals.take()) return;
    this.broadcast(conn.room, { t: 'eph', from: conn.id, data: msg.data }, conn);
  }

  call(conn, msg) {
    const inCall = msg.on === true;
    if (conn.inCall === inCall) return;
    conn.inCall = inCall;
    this.broadcast(conn.room, {
      t: 'presence',
      members: conn.room.memberList(),
      event: { kind: inCall ? 'call-join' : 'call-leave', id: conn.id, nick: conn.nick },
    });
  }

  // WebRTC offers, answers and ICE candidates, end-to-end encrypted, for one peer.
  signal(conn, msg) {
    if (!isBlob(msg.data, LIMITS.maxBlobLength)) return conn.error('too_large');
    if (!conn.signals.take()) return;
    const target = conn.room.members.get(msg.to);
    if (target) target.send({ t: 'signal', from: conn.id, data: msg.data });
  }

  // Turns a private room into a logged one. Its RAM history and files are written
  // to disk and the self-destruct timer stops. Everyone in the room is told.
  persist(conn, msg) {
    const room = conn.room;
    if (room.mode !== 'private') return conn.error('bad_request');
    const inactiveDays = clamp(Math.floor(Number(msg.inactiveDays)) || 0, 0, 365);
    try {
      this.store.persistRoom(room.ref, room.authHash, inactiveDays, room.history, room.files);
    } catch (err) {
      console.error('persist failed', err);
      return conn.error('server_error');
    }
    clearTimeout(room.timer);
    this.releaseFiles(room);
    room.mode = 'logged';
    room.expiresAt = null;
    room.inactiveDays = inactiveDays;
    room.history = [];
    this.broadcast(room, {
      t: 'mode',
      mode: 'logged',
      inactiveDays,
      by: conn.id,
      files: this.fileLimits(room),
    });
  }

  // Invite links. The link carries a secret in its #fragment, which never reaches
  // the server. The inviter's browser uses that secret to encrypt the room ID and
  // PIN, and registers only the ciphertext under the secret's hash. Redeeming
  // hands the ciphertext out once and forgets it.
  createInvite(conn, msg) {
    if (!HEX64.test(msg.id) || !isBlob(msg.data, LIMITS.maxInviteLength)) return conn.error('bad_request');
    if (!conn.signals.take()) return conn.error('slow_down');
    const room = conn.room;
    let active = 0;
    for (const invite of this.invites.values()) if (invite.ref === room.ref) active++;
    if (active >= LIMITS.maxInvitesPerRoom) return conn.error('too_many_invites');
    if (this.invites.has(msg.id)) return conn.error('bad_request');
    const expiresAt = Date.now() + this.config.invites.ttlMs;
    this.invites.set(msg.id, { ref: room.ref, data: msg.data, expiresAt, by: conn.id });
    conn.send({ t: 'invite-ok', id: msg.id, expiresAt });
  }

  redeemInvite(ip, id) {
    if (!HEX64.test(id ?? '')) return { error: 'bad_request', status: 400 };
    if (this.ipFails.blocked(ip)) return { error: 'rate_limited', status: 429 };
    const invite = this.invites.get(id);
    this.invites.delete(id);
    if (!invite || invite.expiresAt < Date.now()) {
      this.ipFails.hit(ip);
      return { error: 'invite_gone', status: 404 };
    }
    const room = this.rooms.get(invite.ref);
    if (room) this.broadcast(room, { t: 'invite-used', id, by: invite.by });
    return { data: invite.data };
  }

  // Checks an HTTP file request against the room's PIN proof. Returns the room
  // (loaded from disk for a logged room nobody is in) or an error code.
  authorizeFiles(ip, ref, auth) {
    if (!HEX64.test(ref ?? '') || !HEX64.test(auth ?? '')) return { error: 'bad_request', status: 400 };
    if (this.ipFails.blocked(ip) || this.roomFails.blocked(ref)) return { error: 'rate_limited', status: 429 };
    const room = this.rooms.get(ref) ?? this.loadLogged(ref);
    if (!room) {
      this.ipFails.hit(ip);
      return { error: 'not_found', status: 404 };
    }
    if (!sameHash(sha256(auth), room.authHash)) {
      this.ipFails.hit(ip);
      this.roomFails.hit(ref);
      return { error: 'bad_pin', status: 403 };
    }
    return { room };
  }

  // Validates an upload before any bytes are read. Returns null or an error.
  checkUpload(ip, room, id, length) {
    if (!FILE_ID.test(id) || !Number.isSafeInteger(length) || length <= 0) return { error: 'bad_request', status: 400 };
    if (this.ipUploads.blocked(ip)) return { error: 'rate_limited', status: 429 };
    const limits = this.fileLimits(room);
    // Ciphertext is a little larger than the file: 28 bytes per 256 KiB chunk.
    if (length > limits.maxFile * 1.001 + 1024) return { error: 'file_too_large', status: 413 };
    if (limits.used + length > limits.maxRoom) return { error: 'room_storage_full', status: 413 };
    if (room.mode === 'private' && this.privateFileBytes + length > this.config.privateRooms.maxTotalBytes) {
      return { error: 'server_storage_full', status: 507 };
    }
    const exists = room.mode === 'private' ? room.files.has(id) : this.store.fileSize(room.ref, id) !== null;
    if (exists) return { error: 'exists', status: 409 };
    this.ipUploads.hit(ip);
    return null;
  }

  addPrivateFile(room, id, buffer) {
    // The room may have expired or been made logged while the upload streamed.
    if (room.mode !== 'private' || this.rooms.get(room.ref) !== room) return 'room_changed';
    // Re-check: other uploads may have finished in the meantime.
    const { privateRooms } = this.config;
    if (room.fileBytes + buffer.length > privateRooms.maxRoomBytes) return 'room_storage_full';
    if (this.privateFileBytes + buffer.length > privateRooms.maxTotalBytes) return 'server_storage_full';
    room.files.set(id, buffer);
    room.fileBytes += buffer.length;
    this.privateFileBytes += buffer.length;
    return null;
  }

  releaseFiles(room) {
    this.privateFileBytes -= room.fileBytes;
    room.files.clear();
    room.fileBytes = 0;
  }

  leave(conn) {
    const room = conn.room;
    if (!room) return;
    conn.room = null;
    conn.inCall = false;
    room.members.delete(conn.id);
    if (this.rooms.get(room.ref) !== room) return;

    this.broadcast(room, {
      t: 'presence',
      members: room.memberList(),
      event: { kind: 'leave', id: conn.id, nick: conn.nick },
    });
    if (room.mode === 'logged' && room.members.size === 0) this.rooms.delete(room.ref);
  }

  destroy(room, reason) {
    clearTimeout(room.timer);
    if (this.rooms.get(room.ref) === room) this.rooms.delete(room.ref);
    if (room.mode === 'logged') this.store.deleteRoom(room.ref);
    this.releaseFiles(room);
    for (const conn of room.members.values()) {
      conn.room = null;
      conn.send({ t: 'destroyed', reason });
      conn.ws.close(1000);
    }
    room.members.clear();
    room.history.length = 0;
    for (const [id, invite] of this.invites) if (invite.ref === room.ref) this.invites.delete(id);
  }

  broadcast(room, message, except) {
    for (const conn of room.members.values()) {
      if (conn !== except) conn.send(message);
    }
  }

  sweep() {
    this.ipFails.sweep();
    this.roomFails.sweep();
    this.ipCreates.sweep();
    this.ipUploads.sweep();
    const now = Date.now();
    for (const [id, invite] of this.invites) if (invite.expiresAt < now) this.invites.delete(id);
    for (const ref of this.store.idleRooms(Date.now())) {
      const room = this.rooms.get(ref);
      if (room) this.destroy(room, 'inactive');
      else this.store.deleteRoom(ref);
    }
  }
}
