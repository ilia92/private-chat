import { readFileSync } from 'node:fs';

const MB = 1024 * 1024;

const DEFAULTS = {
  privateRooms: {
    // Private rooms keep files in server RAM only, so these limits protect memory.
    maxFileMB: 10,
    maxRoomFilesMB: 50,
    // Across all private rooms together.
    maxTotalFilesMB: 512,
  },
  loggedRooms: {
    maxFileMB: 100,
    maxRoomFilesMB: 1024,
  },
  invites: {
    // Single-use join links stop working after this many minutes.
    ttlMinutes: 5,
  },
};

function positive(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`config: ${name} must be a positive number`);
  }
  return value;
}

// Reads a JSON config file. Whole-line // comments are allowed so the file can
// document itself. A missing file means defaults.
export function loadConfig(file) {
  let raw = {};
  try {
    const text = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    raw = JSON.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`config: cannot read ${file}: ${err.message}`);
    console.log(`config: ${file} not found, using defaults`);
  }

  const priv = raw.privateRooms ?? {};
  const logged = raw.loggedRooms ?? {};
  const invites = raw.invites ?? {};
  const d = DEFAULTS;
  return {
    privateRooms: {
      maxFileBytes: positive(priv.maxFileMB, d.privateRooms.maxFileMB, 'privateRooms.maxFileMB') * MB,
      maxRoomBytes: positive(priv.maxRoomFilesMB, d.privateRooms.maxRoomFilesMB, 'privateRooms.maxRoomFilesMB') * MB,
      maxTotalBytes:
        positive(priv.maxTotalFilesMB, d.privateRooms.maxTotalFilesMB, 'privateRooms.maxTotalFilesMB') * MB,
    },
    loggedRooms: {
      maxFileBytes: positive(logged.maxFileMB, d.loggedRooms.maxFileMB, 'loggedRooms.maxFileMB') * MB,
      maxRoomBytes: positive(logged.maxRoomFilesMB, d.loggedRooms.maxRoomFilesMB, 'loggedRooms.maxRoomFilesMB') * MB,
    },
    invites: {
      ttlMs: positive(invites.ttlMinutes, d.invites.ttlMinutes, 'invites.ttlMinutes') * 60_000,
    },
  };
}
