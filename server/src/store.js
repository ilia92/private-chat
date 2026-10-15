import { DatabaseSync } from 'node:sqlite';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

// Persistence for "logged" rooms. Everything stored here is opaque to the server:
// rooms are keyed by a hash of their ID, and messages and files are AES-GCM ciphertext.
export class Store {
  constructor(dataDir) {
    this.filesDir = path.join(dataDir, 'files');
    mkdirSync(this.filesDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'pchat.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS rooms (
        ref           TEXT PRIMARY KEY,
        auth_hash     TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        last_active   INTEGER NOT NULL,
        inactive_days INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        ref  TEXT NOT NULL REFERENCES rooms (ref) ON DELETE CASCADE,
        ts   INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        id         TEXT NOT NULL,
        ref        TEXT NOT NULL REFERENCES rooms (ref) ON DELETE CASCADE,
        size       INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (ref, id)
      );
    `);
    this.migrate();

    const q = (sql) => this.db.prepare(sql);
    this.q = {
      getRoom: q('SELECT auth_hash, inactive_days FROM rooms WHERE ref = ?'),
      createRoom: q(
        'INSERT INTO rooms (ref, auth_hash, created_at, last_active, inactive_days) VALUES (?, ?, ?, ?, ?)',
      ),
      touch: q('UPDATE rooms SET last_active = ? WHERE ref = ?'),
      deleteRoom: q('DELETE FROM rooms WHERE ref = ?'),
      addMessage: q('INSERT INTO messages (ref, seq, ts, data) VALUES (?, ?, ?, ?)'),
      maxSeq: q('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE ref = ?'),
      history: q(
        'SELECT seq AS id, ts, data FROM (SELECT seq, ts, data FROM messages WHERE ref = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq',
      ),
      idleRooms: q('SELECT ref FROM rooms WHERE inactive_days > 0 AND last_active < ? - inactive_days * 86400000'),
      allRefs: q('SELECT ref FROM rooms'),
      addFile: q('INSERT INTO files (ref, id, size, created_at) VALUES (?, ?, ?, ?)'),
      fileSize: q('SELECT size FROM files WHERE ref = ? AND id = ?'),
      roomFileBytes: q('SELECT COALESCE(SUM(size), 0) AS bytes FROM files WHERE ref = ?'),
    };
  }

  // Messages are numbered per room (`seq`) so ids stay stable when a private
  // room's RAM history is moved to disk. Older databases numbered them globally;
  // those ids still increase within each room, so they are reused as seq.
  migrate() {
    const columns = this.db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    if (!columns.includes('seq')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN seq INTEGER; UPDATE messages SET seq = id;');
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS messages_by_room_seq ON messages (ref, seq);');
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getRoom(ref) {
    return this.q.getRoom.get(ref);
  }

  createRoom(ref, authHash, inactiveDays) {
    const now = Date.now();
    this.q.createRoom.run(ref, authHash, now, now, inactiveDays);
  }

  touch(ref) {
    this.q.touch.run(Date.now(), ref);
  }

  deleteRoom(ref) {
    this.q.deleteRoom.run(ref);
    rmSync(this.roomDir(ref), { recursive: true, force: true });
  }

  maxSeq(ref) {
    return this.q.maxSeq.get(ref).seq;
  }

  addMessage(ref, { id, ts, data }) {
    this.q.addMessage.run(ref, id, ts, data);
    this.q.touch.run(ts, ref);
  }

  history(ref, limit) {
    return this.q.history.all(ref, limit);
  }

  idleRooms(now) {
    return this.q.idleRooms.all(now).map((row) => row.ref);
  }

  // Turns a private room into a logged one: room row, history and files in one go.
  persistRoom(ref, authHash, inactiveDays, history, files) {
    const dir = this.roomDir(ref);
    mkdirSync(dir, { recursive: true });
    this.transaction(() => {
      this.createRoom(ref, authHash, inactiveDays);
      for (const item of history) this.q.addMessage.run(ref, item.id, item.ts, item.data);
      for (const [id, buffer] of files) {
        writeFileSync(path.join(dir, id), buffer);
        this.q.addFile.run(ref, id, buffer.length, Date.now());
      }
    });
  }

  roomDir(ref) {
    return path.join(this.filesDir, ref);
  }

  roomFileBytes(ref) {
    return this.q.roomFileBytes.get(ref).bytes;
  }

  fileSize(ref, id) {
    return this.q.fileSize.get(ref, id)?.size ?? null;
  }

  // Streams an upload to a temporary file, then publishes it atomically.
  async saveFile(ref, id, source, expectedSize) {
    const dir = this.roomDir(ref);
    mkdirSync(dir, { recursive: true });
    const partial = path.join(dir, `${id}.part`);
    try {
      let size = 0;
      source.on('data', (chunk) => (size += chunk.length));
      await pipeline(source, createWriteStream(partial));
      if (size !== expectedSize) throw new Error('incomplete upload');
      renameSync(partial, path.join(dir, id));
      this.q.addFile.run(ref, id, size, Date.now());
      return size;
    } catch (err) {
      rmSync(partial, { force: true });
      throw err;
    }
  }

  readFile(ref, id) {
    return createReadStream(path.join(this.roomDir(ref), id));
  }

  // Removes file directories whose room no longer exists (e.g. after a crash).
  cleanupOrphans() {
    const known = new Set(this.q.allRefs.all().map((row) => row.ref));
    for (const name of readdirSync(this.filesDir)) {
      if (!known.has(name)) rmSync(path.join(this.filesDir, name), { recursive: true, force: true });
    }
  }

  close() {
    this.db.close();
  }
}
