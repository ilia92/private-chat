import {
  decryptJSON,
  deriveKeys,
  encryptJSON,
  inviteId,
  isInviteSecret,
  newInviteSecret,
  openInvite,
  sealInvite,
} from './crypto.js';
import qrcode from './qrcode.js';
import { ROOM_RE, RESERVED, rate, randomPin } from './entropy.js';
import { EmojiPicker, QUICK_REACTIONS, convertEmoticons, isJumboEmoji } from './emoji.js';
import { hydrateIcons, setIcon } from './icons.js';
import { play, setSoundEnabled, unlockAudio } from './sound.js';
import { Call } from './call.js';
import {
  TransferError,
  decryptFile,
  downloadFile,
  encryptFile,
  encryptedSize,
  formatBytes,
  newFileId,
  prepareImage,
  uploadFile,
} from './files.js';

const $ = (selector) => document.querySelector(selector);
const MAX_TEXT = 4000;
const TITLE = 'pchat';
const GROUP_WINDOW = 5 * 60_000;
const TYPING_SEND_EVERY = 3000;
const TYPING_SHOW_FOR = 4500;
const URL_RE = /\bhttps?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g;
const FILE_ID_RE = /^[0-9a-f]{32}$/;
// Only these are ever handed to the browser as images; everything else downloads as opaque bytes.
const SAFE_IMAGES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

const ERRORS = {
  exists: 'A room with this ID already exists. Join it instead, or pick another ID.',
  not_found: 'No room with this ID exists. It may have expired or been destroyed. You can create it under "New chat".',
  bad_pin: 'Wrong PIN.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  room_full: 'This room is full.',
  server_full: 'The server is at capacity. Try again later.',
  too_large: 'That message is too large.',
  slow_down: 'You are sending messages too fast.',
  bad_request: 'The server rejected the request.',
  connection: 'Could not reach the server.',
  server_error: 'Something went wrong on the server.',
  room_storage_full: "This room's file storage is full.",
  server_storage_full: 'The server has no space for more files right now. Try again later.',
  room_changed: 'The room changed during the upload. Please send the file again.',
  file_gone: 'This file is no longer available.',
  upload_failed: 'Upload failed.',
  download_failed: 'Download failed.',
  invite_gone: 'This invite was already used or has expired. Ask for a new link.',
  invite_broken: 'This invite link is incomplete or damaged. Ask for a new one.',
  too_many_invites: 'Too many open invites for this room. Wait for some to expire.',
};

const END_REASONS = {
  expired: 'This room reached its time limit and was destroyed.',
  deleted: 'This room was destroyed. All messages are gone.',
  inactive: 'This room was deleted after being idle.',
};

const landing = $('#landing');
const roomView = $('#room');
const createForm = $('#create-form');
const joinForm = $('#join-form');
const messagesEl = $('#messages');
const membersEl = $('#members');
const typingEl = $('#typing');
const tilesEl = $('#tiles');
const stageEl = $('#stage');
const composer = $('#composer');
const input = composer.elements.text;
const picker = new EmojiPicker();

let session = null;
// Invite being redeemed on the landing page: { secret, creds } (creds once opened).
let pendingInvite = null;
let inviteTimer = null;
let unread = 0;
let toastTimer = null;
let soundOn = storageGet('localStorage', 'pchat-sound', '1') === '1';

// ---------- small helpers ----------

function storageGet(area, key, fallback) {
  try {
    return window[area].getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function storageSet(area, key, value) {
  try {
    window[area].setItem(key, value);
  } catch {}
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toast(text) {
  const node = $('#toast');
  node.textContent = text;
  node.hidden = false;
  node.classList.remove('show');
  void node.offsetWidth;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 3500);
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(ts) {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

function hue(text) {
  let h = 7;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;

function initial(text) {
  const first = segmenter ? segmenter.segment(text).containing(0)?.segment : [...text][0];
  return (first ?? '?').toUpperCase();
}

function avatar(name, className = 'avatar') {
  const node = el('span', className, initial(name));
  node.style.setProperty('--h', hue(name));
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function linkify(text) {
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    fragment.append(text.slice(last, match.index));
    const link = el('a', '', match[0]);
    link.href = match[0];
    link.target = '_blank';
    link.rel = 'noopener noreferrer nofollow';
    fragment.append(link);
    last = match.index + match[0].length;
  }
  fragment.append(text.slice(last));
  return fragment;
}

// Per-tab sender id, so your own messages still line up on the right after a reconnect.
function senderId(ref) {
  const key = `pchat-sid:${ref.slice(0, 16)}`;
  let sid = storageGet('sessionStorage', key, null);
  if (!sid) {
    sid = crypto.randomUUID();
    storageSet('sessionStorage', key, sid);
  }
  return sid;
}

// ---------- landing ----------

function selectTab(tab) {
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }
  $('.tabs').dataset.active = tab;
  createForm.hidden = tab !== 'create';
  joinForm.hidden = tab !== 'join';
}

function renderMeter(node, rating) {
  node.dataset.level = rating.level;
  node.querySelector('.hint').textContent = rating.hint;
}

function updateMeters() {
  renderMeter($('#room-meter'), rate(createForm.elements.room.value.trim(), 'room'));
  renderMeter($('#pin-meter'), rate(createForm.elements.pin.value, 'pin'));
}

function updateModeFields() {
  const logged = createForm.elements.mode.value === 'logged';
  $('#ttl-field').hidden = logged;
  $('#inactive-field').hidden = !logged;
}

function showError(form, text) {
  form.querySelector('.error').textContent = text;
}

function setBusy(form, label) {
  const button = form.querySelector('button[type=submit]');
  const text = button.querySelector('.label');
  button.dataset.label ??= text.textContent;
  button.disabled = !!label;
  button.classList.toggle('busy', !!label);
  text.textContent = label || button.dataset.label;
}

function validate(roomId, pin, nick) {
  if (!ROOM_RE.test(roomId)) return 'Room ID must be 3–128 characters: letters, digits, and . _ ~ -';
  if (RESERVED.has(roomId)) return 'That room ID is reserved. Please pick another.';
  if (!pin) return 'Enter a PIN.';
  if (!nick) return 'Enter a nickname.';
  return null;
}

function showLanding() {
  roomView.hidden = true;
  landing.hidden = false;
  document.body.classList.remove('in-room');
  document.title = TITLE;
}

function showRoom() {
  landing.hidden = true;
  roomView.hidden = false;
  document.body.classList.add('in-room');
  input.focus();
}

// Opens a socket, sends the create/join request and waits for the server's verdict.
function openSocket(request) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    let settled = false;
    ws.onopen = () => ws.send(JSON.stringify(request));
    ws.onmessage = (event) => {
      if (settled) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      settled = true;
      if (msg.t === 'joined') {
        resolve({ ws, joined: msg });
      } else {
        ws.close();
        reject(new Error(msg.code || 'bad_request'));
      }
    };
    ws.onclose = () => {
      if (!settled) {
        settled = true;
        reject(new Error('connection'));
      }
    };
  });
}

async function enter(form, extra) {
  const fields = form.elements;
  const roomId = fields.room.value.trim();
  const pin = fields.pin.value;
  const nick = fields.nick.value.trim();
  const problem = validate(roomId, pin, nick);
  showError(form, problem || '');
  if (problem) return;

  unlockAudio();
  try {
    await connectRoom(form, { roomId, pin, nick }, extra);
    fields.pin.value = '';
    updateMeters();
  } catch (err) {
    showError(form, ERRORS[err.message] || ERRORS.connection);
  } finally {
    setBusy(form, null);
  }
}

// Derives the room keys, opens the socket and enters the room. Throws an error
// whose message is a server error code.
async function connectRoom(form, { roomId, pin, nick }, extra) {
  setBusy(form, 'Deriving keys…');
  const keys = await deriveKeys(roomId, pin);
  const nickBlob = await encryptJSON(keys.encKey, keys.ref, nick);
  const joinRequest = { t: 'join', room: keys.ref, auth: keys.auth, nick: nickBlob };
  setBusy(form, 'Connecting…');
  const { ws, joined } = await openSocket({ ...joinRequest, ...extra });
  storageSet('localStorage', 'pchat-nick', nick);
  // The PIN stays in memory only, so members can create invite links.
  startSession({ roomId, pin, keys, nick, joinRequest }, ws, joined);
}

// ---------- invite links: joining ----------

function showInviteLanding(secret) {
  pendingInvite = { secret, creds: null };
  // Keep the secret out of the address bar and browser history.
  history.replaceState(null, '', '/');
  $('#main-panel').hidden = true;
  $('#invite-card').hidden = false;
  const form = $('#invite-form');
  form.elements.nick.value = storageGet('localStorage', 'pchat-nick', '');
  form.elements.nick.focus();
}

function hideInviteLanding() {
  pendingInvite = null;
  $('#invite-card').hidden = true;
  $('#main-panel').hidden = false;
}

async function joinByInvite(event) {
  event.preventDefault();
  const form = $('#invite-form');
  const nick = form.elements.nick.value.trim();
  if (!nick) return showError(form, 'Enter a nickname.');
  if (!pendingInvite) return;
  showError(form, '');
  unlockAudio();
  try {
    // Redeeming uses the invite up, so the credentials are kept for retries.
    if (!pendingInvite.creds) {
      setBusy(form, 'Opening invite…');
      const res = await fetch(`/api/invites/${await inviteId(pendingInvite.secret)}`, { method: 'POST', cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'connection');
      let creds;
      try {
        creds = await openInvite(pendingInvite.secret, body.data);
      } catch {
        throw new Error('invite_broken');
      }
      if (typeof creds?.r !== 'string' || !ROOM_RE.test(creds.r) || typeof creds.p !== 'string') throw new Error('invite_broken');
      pendingInvite.creds = { roomId: creds.r, pin: creds.p };
    }
    await connectRoom(form, { ...pendingInvite.creds, nick }, {});
    hideInviteLanding();
  } catch (err) {
    const code = ERRORS[err.message] ? err.message : 'connection';
    showError(form, ERRORS[code]);
    if (code === 'invite_gone' || code === 'invite_broken') {
      form.querySelector('button[type=submit]').hidden = true;
      $('#invite-home').hidden = false;
    }
  } finally {
    setBusy(form, null);
  }
}

// ---------- room ----------

function startSession(base, ws, joined) {
  session = {
    ...base,
    sid: senderId(base.keys.ref),
    nickCache: new Map(),
    members: [],
    msgEls: new Map(),
    reactions: new Map(),
    typing: new Map(),
    iceWaiters: [],
    inviteWaiters: new Map(),
    invite: null,
    files: null,
    fileMeta: new Map(),
    blobUrls: new Map(),
    uploads: new Set(),
    queue: Promise.resolve(),
    sendChain: Promise.resolve(),
    lastTypingSent: 0,
    call: null,
    ended: false,
  };
  history.replaceState(null, '', `/${base.roomId}`);
  $('#room-name').textContent = base.roomId;
  $('#room-name').title = base.roomId;
  const roomAvatar = $('#room-avatar');
  roomAvatar.textContent = initial(base.roomId);
  roomAvatar.style.setProperty('--h', hue(base.roomId));
  roomView.classList.remove('ended');
  setComposerEnabled(true);
  showRoom();
  attach(session, ws, joined);
}

// Server messages are handled strictly in order, even though decryption is async.
function enqueue(s, fn) {
  s.queue = s.queue.then(() => (session === s ? fn() : undefined)).catch((err) => console.error(err));
}

// Outgoing messages are encrypted and sent in order too: WebRTC needs the offer
// to arrive before its ICE candidates.
function sendEncrypted(s, build, payload) {
  s.sendChain = s.sendChain
    .then(async () => {
      if (s.ws?.readyState !== WebSocket.OPEN) return;
      const data = await encryptJSON(s.keys.encKey, s.keys.ref, payload);
      if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(build(data)));
    })
    .catch((err) => console.error(err));
}

function sendPayload(s, payload) {
  sendEncrypted(s, (data) => ({ t: 'msg', data }), { ...payload, n: s.nick, s: s.sid });
}

function attach(s, ws, joined) {
  s.ws = ws;
  s.me = joined.you;
  s.mode = joined.mode;
  s.expiresAt = joined.expiresAt;
  s.inactiveDays = joined.inactiveDays;
  s.files = joined.files ?? null;
  s.maxMembers = joined.maxMembers;
  renderStatus();

  enqueue(s, async () => {
    messagesEl.replaceChildren();
    s.msgEls.clear();
    s.reactions.clear();
    s.lastSender = null;
    s.lastDay = null;
    if (joined.created) {
      addNotice(
        '🔐 Room created. Tap Invite for a one-time link or QR code, or share the room link and send the PIN through a different channel.',
      );
    }
    const items = await Promise.all(joined.history.map((item) => decryptItem(s, item)));
    for (const item of items) addItem(s, item);
    await setMembers(s, joined.members);
    scrollToBottom();
  });

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    enqueue(s, () => onServerMessage(s, msg));
  };
  ws.onclose = () => onSocketClosed(s);
}

async function onServerMessage(s, msg) {
  switch (msg.t) {
    case 'msg': {
      const item = await decryptItem(s, msg);
      addItem(s, item);
      if (item.kind !== 'react' && !item.own) {
        clearTyping(s, item.nick);
        play('message');
        if (document.hidden) {
          unread++;
          document.title = `(${unread}) ${TITLE}`;
        }
      }
      break;
    }
    case 'eph': {
      try {
        const payload = await decryptJSON(s.keys.encKey, s.keys.ref, msg.data);
        if (payload.k === 'typing') {
          s.typing.set(msg.from, { nick: String(payload.n), until: Date.now() + TYPING_SHOW_FOR });
          renderTyping(s);
        }
      } catch {}
      break;
    }
    case 'presence':
      await setMembers(s, msg.members, msg.event);
      break;
    case 'signal': {
      if (!s.call) break;
      try {
        const payload = await decryptJSON(s.keys.encKey, s.keys.ref, msg.data);
        await s.call.handleSignal(msg.from, payload);
      } catch (err) {
        console.warn('signal', err);
      }
      break;
    }
    case 'mode': {
      s.mode = msg.mode;
      s.expiresAt = null;
      s.inactiveDays = msg.inactiveDays;
      s.files = msg.files ?? s.files;
      renderStatus();
      const who = msg.by === s.me ? 'You' : (s.members.find((m) => m.id === msg.by)?.nick ?? 'Someone');
      addNotice(`💾 ${who} turned on history. Messages and files are now kept, encrypted, until the room is destroyed.`);
      break;
    }
    case 'invite-ok':
      s.inviteWaiters.get(msg.id)?.(msg);
      s.inviteWaiters.delete(msg.id);
      break;
    case 'invite-used':
      if (s.invite?.id === msg.id) {
        s.invite.used = true;
        tickInvite();
      }
      if (msg.by === s.me) addNotice('🎟️ Your invite link was just used.');
      break;
    case 'ice':
      for (const resolve of s.iceWaiters.splice(0)) resolve(msg.servers);
      break;
    case 'destroyed':
      end(s, END_REASONS[msg.reason] || END_REASONS.deleted, true);
      break;
    case 'error':
      toast(ERRORS[msg.code] || `Error: ${msg.code}`);
      break;
  }
}

async function decryptItem(s, { id, ts, data }) {
  try {
    const p = await decryptJSON(s.keys.encKey, s.keys.ref, data);
    const base = { id, ts, nick: String(p.n ?? ''), sender: String(p.s ?? ''), own: p.s === s.sid };
    if (p.k === 'file') {
      const file = {
        id: FILE_ID_RE.test(p.id) ? p.id : null,
        name: String(p.name ?? 'file').slice(0, 200) || 'file',
        mime: String(p.mime ?? '').slice(0, 100),
        size: Math.max(0, Number(p.size) || 0),
        w: Math.max(0, Number(p.w) || 0),
        h: Math.max(0, Number(p.h) || 0),
        thumb: typeof p.thumb === 'string' && p.thumb.startsWith('data:image/jpeg;base64,') ? p.thumb : null,
      };
      return { ...base, kind: 'file', file };
    }
    if (p.k === 'react') {
      return { ...base, kind: 'react', target: Number(p.target), emoji: String(p.e).slice(0, 16), on: !!p.on };
    }
    return { ...base, kind: 'text', text: String(p.m ?? '') };
  } catch {
    return { id, ts, kind: 'text', failed: true };
  }
}

async function decryptNick(s, blob) {
  if (!s.nickCache.has(blob)) {
    let nick;
    try {
      nick = String(await decryptJSON(s.keys.encKey, s.keys.ref, blob));
    } catch {
      nick = '(unreadable)';
    }
    s.nickCache.set(blob, nick);
  }
  return s.nickCache.get(blob);
}

async function setMembers(s, list, event) {
  s.members = await Promise.all(
    list.map(async (m) => ({ id: m.id, inCall: !!m.inCall, nick: await decryptNick(s, m.nick) })),
  );
  renderMembers(s);
  s.call?.sync(s.members);
  renderCallBanner(s);

  if (!event || event.id === s.me) return;
  const nick = await decryptNick(s, event.nick);
  switch (event.kind) {
    case 'join':
      addNotice(`${nick} joined`);
      play('join');
      break;
    case 'leave':
      s.typing.delete(event.id);
      renderTyping(s);
      addNotice(`${nick} left`);
      play('leave');
      break;
    case 'call-join': {
      const others = s.members.filter((m) => m.inCall && m.id !== event.id);
      addNotice(others.length ? `📞 ${nick} joined the call` : `📞 ${nick} started a call`);
      if (!s.call) play('call');
      break;
    }
    case 'call-leave':
      addNotice(`${nick} left the call`);
      break;
  }
}

function renderMembers(s) {
  const chips = s.members.map((m) => {
    const chip = el('span', m.id === s.me ? 'chip me' : 'chip');
    chip.append(avatar(m.nick, 'avatar xs'), el('span', 'chip-name', m.id === s.me ? `${m.nick} (you)` : m.nick));
    if (m.inCall) {
      const badge = el('span', 'chip-call');
      badge.dataset.icon = 'phone';
      badge.title = 'In call';
      chip.append(badge);
    }
    return chip;
  });
  const count = el('span', 'member-count', `${s.members.length} online`);
  membersEl.replaceChildren(count, ...chips);
  if (!s.ended && s.members.length < (s.maxMembers ?? 5)) {
    const invite = el('button', 'chip invite-chip');
    invite.type = 'button';
    invite.dataset.inviteOpen = '';
    const glyph = el('span');
    glyph.dataset.icon = 'user-plus';
    invite.append(glyph, 'Invite');
    membersEl.append(invite);
  }
  hydrateIcons(membersEl);
}

function renderCallBanner(s) {
  const inCall = s.members.filter((m) => m.inCall);
  const show = !s.call && !s.ended && inCall.length > 0;
  $('#call-banner').hidden = !show;
  if (show) $('#call-banner-text').textContent = `Call in progress: ${inCall.map((m) => m.nick).join(', ')}`;
}

function clearTyping(s, nick) {
  for (const [id, entry] of s.typing) if (entry.nick === nick) s.typing.delete(id);
  renderTyping(s);
}

function renderTyping(s) {
  const now = Date.now();
  for (const [id, entry] of s.typing) if (entry.until < now) s.typing.delete(id);
  const names = [...s.typing.values()].map((t) => t.nick);
  if (!names.length) {
    typingEl.replaceChildren();
    return;
  }
  const text =
    names.length === 1
      ? `${names[0]} is typing`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing`
        : 'Several people are typing';
  const dots = el('span', 'dots');
  dots.append(el('i'), el('i'), el('i'));
  typingEl.replaceChildren(dots, el('span', '', text));
}

function nearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addItem(s, item) {
  if (item.kind === 'react') applyReaction(s, item);
  else addMessage(s, item);
}

function addMessage(s, item) {
  const stick = nearBottom() || item.own;

  const day = formatDay(item.ts);
  if (day !== s.lastDay) {
    s.lastDay = day;
    s.lastSender = null;
    messagesEl.append(el('li', 'day', day));
  }

  const li = el('li', 'msg');
  if (item.failed) {
    li.classList.add('failed');
    li.append(el('span', 'avatar-spacer'));
    const wrap = el('div', 'bubble-wrap');
    wrap.append(el('div', 'body', '🔒 This message could not be decrypted.'));
    li.append(wrap);
    s.lastSender = null;
    messagesEl.append(li);
    if (stick) scrollToBottom();
    return;
  }

  li.dataset.id = item.id;
  if (item.own) li.classList.add('own');
  const key = `${item.sender}|${item.nick}`;
  const continued = s.lastSender?.key === key && item.ts - s.lastSender.ts < GROUP_WINDOW;
  if (continued) li.classList.add('cont');
  s.lastSender = { key, ts: item.ts };

  if (!item.own) li.append(continued ? el('span', 'avatar-spacer') : avatar(item.nick));

  const wrap = el('div', 'bubble-wrap');
  if (!continued) {
    const meta = el('div', 'meta');
    if (!item.own) meta.append(el('span', 'nick', item.nick));
    meta.append(el('time', '', formatTime(item.ts)));
    wrap.append(meta);
  }
  let body;
  if (item.kind === 'file') {
    body = renderFile(s, item.file);
  } else {
    body = el('div', isJumboEmoji(item.text) ? 'body jumbo' : 'body');
    body.append(linkify(item.text));
  }
  body.title = new Date(item.ts).toLocaleString();
  wrap.append(body, el('div', 'reactions'));

  const tools = el('div', 'msg-tools');
  for (const emoji of QUICK_REACTIONS.slice(0, 6)) {
    const button = el('button', '', emoji);
    button.type = 'button';
    button.dataset.react = emoji;
    button.title = `React ${emoji}`;
    tools.append(button);
  }
  const more = el('button', 'more');
  more.type = 'button';
  more.dataset.reactMore = '';
  more.title = 'More reactions';
  more.dataset.icon = 'plus';
  tools.append(more);

  li.append(wrap, tools);
  hydrateIcons(tools);
  messagesEl.append(li);
  s.msgEls.set(item.id, li);
  renderReactions(s, item.id);
  if (stick) scrollToBottom();
}

function applyReaction(s, item) {
  if (!item.emoji || !Number.isFinite(item.target)) return;
  let byEmoji = s.reactions.get(item.target);
  if (!byEmoji) s.reactions.set(item.target, (byEmoji = new Map()));
  let senders = byEmoji.get(item.emoji);
  if (!senders) byEmoji.set(item.emoji, (senders = new Map()));
  if (item.on) senders.set(item.sender, item.nick);
  else senders.delete(item.sender);
  if (!senders.size) byEmoji.delete(item.emoji);
  renderReactions(s, item.target);
}

function renderReactions(s, id) {
  const li = s.msgEls.get(id);
  if (!li) return;
  const stick = nearBottom();
  const container = li.querySelector('.reactions');
  const chips = [];
  for (const [emoji, senders] of s.reactions.get(id) ?? []) {
    const chip = el('button', senders.has(s.sid) ? 'reaction mine' : 'reaction');
    chip.type = 'button';
    chip.dataset.react = emoji;
    chip.title = [...senders.values()].join(', ');
    chip.append(el('span', 'e', emoji), el('span', 'n', String(senders.size)));
    chips.push(chip);
  }
  container.replaceChildren(...chips);
  if (stick) scrollToBottom();
}

function toggleReaction(s, id, emoji) {
  const mine = s.reactions.get(id)?.get(emoji)?.has(s.sid) ?? false;
  sendPayload(s, { k: 'react', target: id, e: emoji, on: !mine });
}

function addNotice(text) {
  const stick = nearBottom();
  messagesEl.append(el('li', 'sys', text));
  if (session) session.lastSender = null;
  if (stick) scrollToBottom();
}

function renderStatus() {
  const s = session;
  if (!s) return;
  const badge = $('#mode-badge');
  badge.className = `badge ${s.mode}`;
  badge.replaceChildren();
  const glyph = el('span');
  glyph.dataset.icon = s.mode === 'private' ? 'zap' : 'database';
  badge.append(glyph, s.mode === 'private' ? 'Private · RAM only' : 'Logged · encrypted');
  hydrateIcons(badge);
  for (const button of document.querySelectorAll('.persist-action')) button.hidden = s.mode !== 'private';
  tick();
}

function tick() {
  const s = session;
  if (!s || s.ended) return;
  const node = $('#countdown');
  if (s.mode === 'private') {
    const left = s.expiresAt - Date.now();
    node.textContent = left > 0 ? `⏳ ${formatDuration(left)}` : 'expiring…';
    node.title = 'Time until this room self-destructs';
    node.classList.toggle('urgent', left < 10 * 60_000);
  } else {
    node.textContent = s.inactiveDays ? `deleted after ${s.inactiveDays}d idle` : 'kept until destroyed';
    node.title = '';
  }
  renderTyping(s);
}

function setComposerEnabled(enabled) {
  input.disabled = !enabled;
  for (const button of composer.querySelectorAll('button')) button.disabled = !enabled;
}

function onSocketClosed(s) {
  if (session !== s || s.ended) return;
  if (s.call) {
    endCall(s, false);
    addNotice('Call ended because the connection dropped.');
  }
  addNotice('Connection lost. Reconnecting…');
  setComposerEnabled(false);
  reconnect(s);
}

async function reconnect(s) {
  for (let attempt = 0; session === s && !s.ended; attempt++) {
    await sleep(Math.min(15_000, 1000 * 2 ** attempt));
    if (session !== s || s.ended) return;
    try {
      const { ws, joined } = await openSocket(s.joinRequest);
      if (session !== s) return ws.close();
      attach(s, ws, joined);
      setComposerEnabled(true);
      return;
    } catch (err) {
      if (!['connection', 'rate_limited', 'server_full'].includes(err.message)) {
        return end(s, err.message === 'not_found' ? END_REASONS.deleted : ERRORS[err.message] || ERRORS.connection, false);
      }
    }
  }
}

// Cancels uploads, frees decrypted files kept in memory and closes any overlays.
function cleanupSession(s) {
  for (const cancel of s.uploads) cancel();
  s.uploads.clear();
  for (const url of s.blobUrls.values()) URL.revokeObjectURL(url);
  s.blobUrls.clear();
  closeViewer();
  closeMenu();
  closeInviteDialog();
  $('#persist-modal').hidden = true;
}

function end(s, reason, wipe) {
  if (s.ended) return;
  if (s.call) endCall(s, false);
  cleanupSession(s);
  s.ended = true;
  s.ws?.close();
  if (wipe) messagesEl.replaceChildren();
  addNotice(reason);
  setComposerEnabled(false);
  s.typing.clear();
  renderTyping(s);
  renderCallBanner(s);
  $('#countdown').textContent = '';
  roomView.classList.add('ended');
}

function leave() {
  const s = session;
  if (s?.call) endCall(s, true);
  if (s) cleanupSession(s);
  session = null;
  if (s) {
    s.ended = true;
    s.ws?.close();
  }
  messagesEl.replaceChildren();
  membersEl.replaceChildren();
  typingEl.replaceChildren();
  $('#call-banner').hidden = true;
  history.replaceState(null, '', '/');
  showLanding();
}

function sendMessage(event) {
  event.preventDefault();
  const s = session;
  const text = convertEmoticons(input.value.trim());
  if (!s || s.ended || !text) return;
  if (text.length > MAX_TEXT) return toast(`Messages are limited to ${MAX_TEXT} characters.`);
  if (s.ws?.readyState !== WebSocket.OPEN) return toast('Not connected. Your message was kept.');

  input.value = '';
  autosize();
  s.lastTypingSent = 0;
  sendPayload(s, { k: 'text', m: text });
}

function onComposerInput() {
  autosize();
  const s = session;
  if (!s || s.ended || !input.value.trim()) return;
  const now = Date.now();
  if (now - s.lastTypingSent < TYPING_SEND_EVERY) return;
  s.lastTypingSent = now;
  sendEncrypted(s, (data) => ({ t: 'eph', data }), { k: 'typing', n: s.nick });
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function insertAtCursor(text) {
  input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
  input.focus();
  autosize();
}

// ---------- files ----------

function fileErrorText(s, code) {
  if (code === 'file_too_large' && s.files) {
    const hint = s.mode === 'private' ? ' Logged rooms allow bigger files (menu → Keep history).' : '';
    return `Too large: the limit in this room is ${formatBytes(s.files.maxFile)} per file.${hint}`;
  }
  return ERRORS[code] || ERRORS.upload_failed;
}

function fileIcon() {
  const node = el('span', 'file-icon');
  node.dataset.icon = 'file';
  return node;
}

function renderFile(s, file) {
  if (file.id) s.fileMeta.set(file.id, file);
  if (file.id && file.thumb && SAFE_IMAGES.has(file.mime)) {
    const button = el('button', 'body image-msg');
    button.type = 'button';
    button.dataset.fileOpen = file.id;
    button.setAttribute('aria-label', `Open image ${file.name}`);
    if (file.w && file.h) button.style.setProperty('--ratio', `${file.w} / ${file.h}`);
    const img = el('img');
    img.src = file.thumb;
    img.alt = file.name;
    button.append(img);
    return button;
  }
  const card = el('div', 'body file-card');
  const info = el('div', 'file-info');
  info.append(el('span', 'file-name', file.name), el('span', 'file-meta', formatBytes(file.size)));
  card.append(fileIcon(), info);
  if (file.id) {
    const download = el('button', 'file-action');
    download.type = 'button';
    download.dataset.fileDownload = file.id;
    download.dataset.icon = 'download';
    download.title = `Download ${file.name}`;
    download.setAttribute('aria-label', `Download ${file.name}`);
    card.append(download);
  }
  hydrateIcons(card);
  return card;
}

// Downloads, decrypts and caches a file for this session as an object URL.
async function fileObjectUrl(s, file, onProgress) {
  const cached = s.blobUrls.get(file.id);
  if (cached) return cached;
  const bytes = await downloadFile(s.keys.ref, s.keys.auth, file.id, onProgress);
  const type = SAFE_IMAGES.has(file.mime) ? file.mime : 'application/octet-stream';
  const url = URL.createObjectURL(await decryptFile(s.keys.encKey, s.keys.ref, file.id, bytes, type));
  if (session !== s) {
    URL.revokeObjectURL(url);
    throw new TransferError('cancelled');
  }
  s.blobUrls.set(file.id, url);
  return url;
}

function saveObjectUrl(url, name) {
  const link = el('a');
  link.href = url;
  link.download = name || 'file';
  document.body.append(link);
  link.click();
  link.remove();
}

async function downloadToDisk(s, file, button) {
  if (button.classList.contains('busy')) return;
  button.classList.add('busy');
  const progress = (p) => button.style.setProperty('--p', `${Math.round(p * 100)}%`);
  try {
    saveObjectUrl(await fileObjectUrl(s, file, progress), file.name);
  } catch (err) {
    if (err?.code !== 'cancelled') toast(ERRORS[err?.code] || (err instanceof TransferError ? ERRORS.download_failed : '🔒 Could not decrypt this file.'));
  } finally {
    button.classList.remove('busy');
    button.style.removeProperty('--p');
  }
}

function addPendingUpload(name, size) {
  const li = el('li', 'msg own pending');
  const wrap = el('div', 'bubble-wrap');
  const card = el('div', 'body file-card');
  const info = el('div', 'file-info');
  const status = el('span', 'file-meta', formatBytes(size));
  info.append(el('span', 'file-name', name), status);
  const cancel = el('button', 'file-action');
  cancel.type = 'button';
  cancel.dataset.icon = 'x';
  cancel.title = 'Cancel';
  cancel.setAttribute('aria-label', 'Cancel upload');
  card.append(fileIcon(), info, cancel);
  const bar = el('div', 'progress');
  const fill = el('span');
  bar.append(fill);
  wrap.append(card, bar);
  li.append(wrap);
  hydrateIcons(li);
  messagesEl.append(li);
  scrollToBottom();

  let onCancel = () => li.remove();
  cancel.addEventListener('click', () => onCancel());
  return {
    status: (text) => (status.textContent = `${formatBytes(size)} · ${text}`),
    progress: (p) => {
      fill.style.width = `${Math.round(p * 100)}%`;
      status.textContent = `${formatBytes(size)} · ${Math.round(p * 100)}%`;
    },
    cancellable: (fn) => (onCancel = fn),
    remove: () => li.remove(),
    fail: (text) => {
      li.classList.add('error');
      status.textContent = text;
      cancel.title = 'Dismiss';
      onCancel = () => li.remove();
    },
  };
}

async function sendFile(s, file) {
  const pending = addPendingUpload(file.name || 'file', file.size);
  let cancelUpload = null;
  try {
    pending.status('preparing…');
    const image = await prepareImage(file);
    const blob = image?.blob ?? file;
    const limits = s.files;
    if (limits && blob.size > limits.maxFile) throw new TransferError('file_too_large');
    if (limits && limits.used + encryptedSize(blob.size) > limits.maxRoom) throw new TransferError('room_storage_full');

    const id = newFileId();
    pending.status('encrypting…');
    const body = await encryptFile(s.keys.encKey, s.keys.ref, id, blob);
    if (session !== s || s.ended) return pending.remove();
    pending.status('uploading…');
    const transfer = uploadFile(s.keys.ref, s.keys.auth, id, body, pending.progress);
    cancelUpload = transfer.cancel;
    s.uploads.add(cancelUpload);
    pending.cancellable(transfer.cancel);
    await transfer.done;
    if (limits) limits.used += body.size;

    const payload = { k: 'file', id, name: (image?.name ?? file.name ?? 'file').slice(0, 200), mime: image?.type ?? file.type, size: blob.size };
    if (image) Object.assign(payload, { w: image.width, h: image.height, thumb: image.thumb });
    sendPayload(s, payload);
    pending.remove();
  } catch (err) {
    if (err?.code === 'cancelled') return pending.remove();
    pending.fail(err instanceof TransferError ? fileErrorText(s, err.code) : `Could not send: ${err?.message || err}`);
  } finally {
    if (cancelUpload) s.uploads.delete(cancelUpload);
  }
}

// One at a time keeps memory use low on phones and preserves the order.
async function sendFiles(files) {
  const s = session;
  if (!s || s.ended || !files.length) return;
  for (const file of files) {
    if (session !== s || s.ended) return;
    await sendFile(s, file);
  }
}

async function openViewer(s, file) {
  const viewer = $('#viewer');
  const img = $('#viewer-img');
  viewer.hidden = false;
  viewer.dataset.file = file.id;
  $('#viewer-name').textContent = file.name;
  img.src = file.thumb ?? '';
  img.classList.add('loading');
  const bar = $('#viewer-progress');
  bar.hidden = false;
  bar.firstElementChild.style.width = '0%';
  try {
    const url = await fileObjectUrl(s, file, (p) => (bar.firstElementChild.style.width = `${Math.round(p * 100)}%`));
    if (viewer.dataset.file !== file.id) return;
    img.src = url;
    img.classList.remove('loading');
  } catch (err) {
    if (viewer.dataset.file !== file.id || err?.code === 'cancelled') return;
    toast(ERRORS[err?.code] || '🔒 Could not open this image.');
    closeViewer();
  } finally {
    if (viewer.dataset.file === file.id) bar.hidden = true;
  }
}

function closeViewer() {
  const viewer = $('#viewer');
  viewer.hidden = true;
  delete viewer.dataset.file;
  $('#viewer-img').removeAttribute('src');
}

function openMenu() {
  $('#room-menu').hidden = false;
  $('#menu-backdrop').hidden = false;
  $('#menu-btn').setAttribute('aria-expanded', 'true');
}

function closeMenu() {
  $('#room-menu').hidden = true;
  $('#menu-backdrop').hidden = true;
  $('#menu-btn').setAttribute('aria-expanded', 'false');
}

// ---------- invite links: creating ----------

// Draws the QR code as SVG elements; generated markup would trip the CSP.
function renderQr(container, text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 2;
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`;
    }
  }
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${count + margin * 2} ${count + margin * 2}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const background = document.createElementNS(NS, 'rect');
  background.setAttribute('width', '100%');
  background.setAttribute('height', '100%');
  background.setAttribute('fill', '#fff');
  const modules = document.createElementNS(NS, 'path');
  modules.setAttribute('d', path);
  modules.setAttribute('fill', '#0b0d17');
  svg.append(background, modules);
  container.replaceChildren(svg);
}

function requestInvite(s, id, data) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      s.inviteWaiters.delete(id);
      resolve(null);
    }, 5000);
    s.inviteWaiters.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    s.ws.send(JSON.stringify({ t: 'invite', id, data }));
  });
}

async function createInvite() {
  const s = session;
  if (!s || s.ended || s.ws?.readyState !== WebSocket.OPEN) return toast(ERRORS.connection);
  clearInterval(inviteTimer);
  s.invite = null;
  $('#invite-qr').replaceChildren();
  $('#invite-overlay').hidden = true;
  $('#invite-link').value = '';
  $('#invite-status').textContent = 'Creating a link…';
  $('#invite-new').disabled = true;
  try {
    const secret = newInviteSecret();
    const { id, data } = await sealInvite(secret, { r: s.roomId, p: s.pin });
    const ok = await requestInvite(s, id, data);
    if (session !== s) return;
    if (!ok) {
      $('#invite-status').textContent = 'Could not create a link. Try again.';
      return;
    }
    const url = `${location.origin}/i#${secret}`;
    s.invite = { id, url, expiresAt: ok.expiresAt, used: false };
    $('#invite-link').value = url;
    renderQr($('#invite-qr'), url);
    tickInvite();
    inviteTimer = setInterval(tickInvite, 1000);
  } finally {
    $('#invite-new').disabled = false;
  }
}

function tickInvite() {
  const invite = session?.invite;
  if (!invite) return;
  const status = $('#invite-status');
  const overlay = $('#invite-overlay');
  const left = invite.expiresAt - Date.now();
  if (invite.used || left <= 0) {
    clearInterval(inviteTimer);
    overlay.hidden = false;
    overlay.textContent = invite.used ? '✓ Used' : 'Expired';
    status.textContent = invite.used
      ? 'Used: they are joining now. Create a new link for someone else.'
      : 'This link expired. Create a new one.';
    status.className = `invite-status ${invite.used ? 'ok' : 'expired'}`;
    return;
  }
  const seconds = Math.ceil(left / 1000);
  status.textContent = `Valid for ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · works once`;
  status.className = `invite-status${seconds <= 30 ? ' urgent' : ''}`;
}

function openInviteDialog() {
  if (!session || session.ended) return;
  $('#invite-modal').hidden = false;
  createInvite();
}

function closeInviteDialog() {
  clearInterval(inviteTimer);
  $('#invite-modal').hidden = true;
}

// ---------- calls ----------

function requestIce(s) {
  return new Promise((resolve) => {
    const done = (servers) => {
      clearTimeout(timer);
      resolve(Array.isArray(servers) ? servers : []);
    };
    const timer = setTimeout(() => {
      s.iceWaiters = s.iceWaiters.filter((w) => w !== done);
      resolve([]);
    }, 4000);
    s.iceWaiters.push(done);
    s.ws.send(JSON.stringify({ t: 'ice' }));
  });
}

function mediaError(err) {
  if (err?.name === 'NotAllowedError') return 'Permission to use the microphone/camera was denied.';
  if (err?.name === 'NotFoundError') return 'No microphone/camera was found.';
  if (err?.name === 'NotReadableError') return 'The microphone/camera is in use by another app.';
  return `Could not start media: ${err?.message || err}`;
}

async function startCall(video) {
  const s = session;
  if (!s || s.ended || s.call || s.ws?.readyState !== WebSocket.OPEN) return;
  if (!navigator.mediaDevices?.getUserMedia) return toast('This browser does not support calls.');
  unlockAudio();
  for (const id of ['call-audio', 'call-video', 'banner-audio', 'banner-video']) $(`#${id}`).disabled = true;
  try {
    const iceServers = await requestIce(s);
    const call = new Call({
      me: s.me,
      iceServers,
      signal: (to, payload) => sendEncrypted(s, (data) => ({ t: 'signal', to, data }), payload),
      onChange: () => renderStage(s),
    });
    try {
      await call.start({ video });
    } catch (err) {
      call.hangup();
      return toast(mediaError(err));
    }
    if (session !== s || s.ended || s.call) return call.hangup();
    s.call = call;
    s.ws.send(JSON.stringify({ t: 'call', on: true }));
    stageEl.hidden = false;
    roomView.classList.add('calling');
    call.sync(s.members);
    renderCallBanner(s);
    meterLoop(s, call);
  } finally {
    for (const id of ['call-audio', 'call-video', 'banner-audio', 'banner-video']) $(`#${id}`).disabled = false;
  }
}

function endCall(s, notify) {
  const call = s.call;
  if (!call) return;
  call.hangup();
  s.call = null;
  if (notify && s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ t: 'call', on: false }));
  stageEl.hidden = true;
  stageEl.classList.remove('expanded');
  setIcon($('#ctl-expand'), 'maximize');
  roomView.classList.remove('calling');
  tilesEl.replaceChildren();
  renderCallBanner(s);
}

function createTile(id) {
  const tile = el('div', 'tile');
  tile.dataset.id = id;
  const video = el('video');
  video.autoplay = true;
  video.playsInline = true;
  const face = el('div', 'tile-face');
  const label = el('div', 'tile-label');
  const mic = el('span', 'tile-mic');
  label.append(mic, el('span', 'tile-name'), el('span', 'tile-status'));
  tile.append(video, face, label);
  return tile;
}

function renderStage(s) {
  const call = s.call;
  if (!call || session !== s) return;
  const nickOf = (id) => s.members.find((m) => m.id === id)?.nick ?? '…';
  const entries = [
    {
      id: s.me,
      nick: `${s.nick} (you)`,
      avatarName: s.nick,
      stream: call.local,
      mic: call.mic,
      video: call.camOn || call.screenOn,
      mirror: call.camOn && !call.screenOn,
      screen: call.screenOn,
      local: true,
      status: '',
    },
    ...[...call.peers.values()].map((peer) => ({
      id: peer.id,
      nick: nickOf(peer.id),
      avatarName: nickOf(peer.id),
      stream: peer.stream,
      mic: peer.state.mic,
      video: peer.state.cam || peer.state.screen,
      mirror: false,
      screen: peer.state.screen,
      local: false,
      status: { new: 'connecting…', connecting: 'connecting…', disconnected: 'reconnecting…', failed: 'connection failed' }[
        peer.connection
      ] ?? '',
    })),
  ];

  const existing = new Map([...tilesEl.children].map((tile) => [tile.dataset.id, tile]));
  for (const entry of entries) {
    let tile = existing.get(entry.id);
    if (!tile) {
      tile = createTile(entry.id);
      tilesEl.append(tile);
    }
    existing.delete(entry.id);
    const video = tile.querySelector('video');
    video.muted = entry.local;
    if (video.srcObject !== entry.stream) {
      video.srcObject = entry.stream;
      video.play().catch(() => {});
    }
    tile.classList.toggle('has-video', entry.video);
    tile.classList.toggle('mirror', entry.mirror);
    tile.classList.toggle('screen', entry.screen);
    tile.classList.toggle('muted', !entry.mic);
    const face = tile.querySelector('.tile-face');
    if (face.dataset.name !== entry.avatarName) {
      face.dataset.name = entry.avatarName;
      face.replaceChildren(avatar(entry.avatarName, 'avatar xl'));
    }
    tile.querySelector('.tile-name').textContent = entry.nick;
    tile.querySelector('.tile-status').textContent = entry.status;
    const mic = tile.querySelector('.tile-mic');
    if (mic.dataset.icon !== (entry.mic ? 'mic' : 'mic-off')) setIcon(mic, entry.mic ? 'mic' : 'mic-off');
  }
  for (const tile of existing.values()) tile.remove();
  tilesEl.dataset.count = String(entries.length);

  const micButton = $('#ctl-mic');
  setIcon(micButton, call.mic ? 'mic' : 'mic-off');
  micButton.classList.toggle('off', !call.mic);
  micButton.title = call.mic ? 'Mute' : 'Unmute';
  const camButton = $('#ctl-cam');
  setIcon(camButton, call.camOn ? 'video' : 'video-off');
  camButton.classList.toggle('off', !call.camOn);
  camButton.title = call.camOn ? 'Turn camera off' : 'Turn camera on';
  $('#ctl-screen').classList.toggle('active', call.screenOn);
}

// Drives the "speaking" glow on call tiles.
function meterLoop(s, call) {
  const frame = () => {
    if (s.call !== call) return;
    for (const tile of tilesEl.children) {
      const level = call.level(tile.dataset.id);
      tile.classList.toggle('speaking', level > 0.035);
      tile.style.setProperty('--level', Math.min(1, level * 6).toFixed(2));
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function callAction(fn, { quietIfCancelled = false } = {}) {
  const s = session;
  if (!s?.call) return;
  try {
    await fn(s.call);
  } catch (err) {
    // Closing the screen-share picker rejects with NotAllowedError; that's not an error.
    if (quietIfCancelled && (err?.name === 'NotAllowedError' || err?.name === 'AbortError')) return;
    toast(mediaError(err));
  }
}

// ---------- wiring ----------

function updateSoundButton() {
  const label = soundOn ? 'Sounds on' : 'Sounds off';
  for (const button of document.querySelectorAll('.sound-action')) {
    setIcon(button.querySelector('.sound-icon'), soundOn ? 'bell' : 'bell-off');
    const text = button.querySelector('.sound-label');
    if (text) text.textContent = label;
    else button.title = label;
  }
  setSoundEnabled(soundOn);
}

// Room actions, shared by the top-bar icons (wide screens) and the ⋯ menu (phones).
const ROOM_ACTIONS = {
  invite: openInviteDialog,
  copy() {
    const url = `${location.origin}/${session.roomId}`;
    navigator.clipboard.writeText(url).then(
      () => toast('🔗 Link copied. Send the PIN through a different channel.'),
      () => window.prompt('Copy this link:', url),
    );
  },
  persist() {
    if (session && !session.ended && session.mode === 'private') $('#persist-modal').hidden = false;
  },
  sound() {
    soundOn = !soundOn;
    storageSet('localStorage', 'pchat-sound', soundOn ? '1' : '0');
    updateSoundButton();
    if (soundOn) play('message');
  },
  destroy() {
    const s = session;
    if (!s || s.ended || s.ws?.readyState !== WebSocket.OPEN) return;
    if (window.confirm('Destroy this room for everyone?\nAll messages are deleted permanently.')) {
      s.ws.send(JSON.stringify({ t: 'destroy' }));
    }
  },
};

function init() {
  hydrateIcons();
  if (!window.isSecureContext || !crypto.subtle) {
    $('#insecure').hidden = false;
    for (const button of document.querySelectorAll('form button')) button.disabled = true;
  }

  const nick = storageGet('localStorage', 'pchat-nick', '');
  createForm.elements.nick.value = nick;
  joinForm.elements.nick.value = nick;

  const pathId = location.pathname.slice(1);
  if (location.pathname === '/i') {
    const secret = location.hash.slice(1);
    selectTab('join');
    if (isInviteSecret(secret)) showInviteLanding(secret);
    else {
      history.replaceState(null, '', '/');
      showError(joinForm, ERRORS.invite_broken);
    }
  } else if (ROOM_RE.test(pathId) && !RESERVED.has(pathId)) {
    joinForm.elements.room.value = pathId;
    createForm.elements.room.value = pathId;
    selectTab('join');
    (nick ? joinForm.elements.pin : joinForm.elements.nick).focus();
  } else {
    selectTab('create');
  }
  updateMeters();
  updateModeFields();
  updateSoundButton();
  if (!navigator.mediaDevices?.getDisplayMedia) $('#ctl-screen').hidden = true;

  for (const button of document.querySelectorAll('[data-tab]')) {
    button.addEventListener('click', () => selectTab(button.dataset.tab));
  }
  for (const button of document.querySelectorAll('.reveal')) {
    button.addEventListener('click', () => {
      const field = document.getElementById(button.dataset.target);
      field.type = field.type === 'password' ? 'text' : 'password';
      setIcon(button, field.type === 'password' ? 'eye' : 'eye-off');
    });
  }
  $('#gen-room').addEventListener('click', () => {
    createForm.elements.room.value = crypto.randomUUID();
    updateMeters();
  });
  $('#gen-pin').addEventListener('click', () => {
    createForm.elements.pin.value = randomPin();
    createForm.elements.pin.type = 'text';
    setIcon(createForm.querySelector('.reveal'), 'eye-off');
    updateMeters();
  });
  createForm.elements.room.addEventListener('input', updateMeters);
  createForm.elements.pin.addEventListener('input', updateMeters);
  createForm.addEventListener('change', updateModeFields);

  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const fields = createForm.elements;
    enter(createForm, {
      t: 'create',
      mode: fields.mode.value,
      ttl: Number(fields.ttl.value) * 60_000,
      inactiveDays: Number(fields.inactive.value),
    });
  });
  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    enter(joinForm, {});
  });

  composer.addEventListener('submit', sendMessage);
  input.addEventListener('input', onComposerInput);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  $('#emoji-btn').addEventListener('click', (event) => picker.toggle(event.currentTarget, insertAtCursor));

  // Keep the newest message in view while the chat area resizes (call stage, mobile keyboard).
  let pinnedToBottom = true;
  messagesEl.addEventListener('scroll', () => (pinnedToBottom = nearBottom()), { passive: true });
  new ResizeObserver(() => pinnedToBottom && scrollToBottom()).observe(messagesEl);

  messagesEl.addEventListener('click', (event) => {
    const s = session;
    const li = event.target.closest('li.msg[data-id]');
    if (!s || s.ended || !li) return;
    const id = Number(li.dataset.id);
    const open = event.target.closest('[data-file-open]');
    if (open) return openViewer(s, s.fileMeta.get(open.dataset.fileOpen));
    const download = event.target.closest('[data-file-download]');
    if (download) return downloadToDisk(s, s.fileMeta.get(download.dataset.fileDownload), download);
    const react = event.target.closest('[data-react]');
    if (react) return toggleReaction(s, id, react.dataset.react);
    const more = event.target.closest('[data-react-more]');
    if (more) return picker.open(more, (emoji) => toggleReaction(s, id, emoji));
    // Touch screens have no hover, so a tap on a message reveals its reaction bar.
    for (const open of messagesEl.querySelectorAll('li.tools-open')) if (open !== li) open.classList.remove('tools-open');
    li.classList.toggle('tools-open');
  });

  // Files: picker, drag and drop, and pasted images.
  const fileInput = $('#file-input');
  $('#attach-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    sendFiles([...fileInput.files]);
    fileInput.value = '';
  });
  input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    sendFiles(files);
  });
  let dragDepth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  roomView.addEventListener('dragenter', (event) => {
    if (!hasFiles(event) || !session || session.ended) return;
    dragDepth++;
    $('#drop-overlay').hidden = false;
  });
  roomView.addEventListener('dragover', (event) => hasFiles(event) && event.preventDefault());
  roomView.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('#drop-overlay').hidden = true;
    }
  });
  roomView.addEventListener('drop', (event) => {
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    if (!hasFiles(event)) return;
    event.preventDefault();
    sendFiles([...event.dataTransfer.files]);
  });

  $('#viewer-close').addEventListener('click', closeViewer);
  $('#viewer-body').addEventListener('click', (event) => event.target === event.currentTarget && closeViewer());
  $('#viewer-download').addEventListener('click', () => {
    const s = session;
    const file = s?.fileMeta.get($('#viewer').dataset.file);
    if (!file) return;
    const url = s.blobUrls.get(file.id);
    if (url) saveObjectUrl(url, file.name);
    else downloadToDisk(s, file, $('#viewer-download'));
  });

  // Invite links.
  $('#invite-form').addEventListener('submit', joinByInvite);
  $('#invite-home').addEventListener('click', () => {
    hideInviteLanding();
    selectTab('create');
  });
  membersEl.addEventListener('click', (event) => event.target.closest('[data-invite-open]') && openInviteDialog());
  $('#invite-new').addEventListener('click', createInvite);
  $('#invite-close').addEventListener('click', closeInviteDialog);
  $('#invite-modal').addEventListener('click', (event) => event.target === event.currentTarget && closeInviteDialog());
  $('#invite-copy').addEventListener('click', () => {
    const url = session?.invite?.url;
    if (!url) return;
    navigator.clipboard.writeText(url).then(
      () => toast('🎟️ Invite link copied. It works once, for a few minutes.'),
      () => $('#invite-link').select(),
    );
  });
  if (navigator.share) {
    $('#invite-share').hidden = false;
    $('#invite-share').addEventListener('click', () => {
      const url = session?.invite?.url;
      if (url) navigator.share({ title: 'pchat invite', text: 'Join my private chat (this link works once):', url }).catch(() => {});
    });
  }

  // Room menu and "keep history".
  $('#menu-btn').addEventListener('click', () => ($('#room-menu').hidden ? openMenu() : closeMenu()));
  $('#menu-backdrop').addEventListener('click', closeMenu);
  $('#room-menu').addEventListener('click', (event) => event.target.closest('button') && closeMenu());
  roomView.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button && session) ROOM_ACTIONS[button.dataset.action]?.();
  });
  $('#persist-cancel').addEventListener('click', () => ($('#persist-modal').hidden = true));
  $('#persist-modal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) $('#persist-modal').hidden = true;
  });
  $('#persist-confirm').addEventListener('click', () => {
    const s = session;
    $('#persist-modal').hidden = true;
    if (!s || s.ended || s.ws?.readyState !== WebSocket.OPEN) return toast(ERRORS.connection);
    s.ws.send(JSON.stringify({ t: 'persist', inactiveDays: Number($('#persist-inactive').value) }));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#viewer').hidden) closeViewer();
    else if (!$('#invite-modal').hidden) closeInviteDialog();
    else if (!$('#persist-modal').hidden) $('#persist-modal').hidden = true;
    else if (!$('#room-menu').hidden) closeMenu();
  });

  $('#leave').addEventListener('click', leave);

  $('#call-audio').addEventListener('click', () => startCall(false));
  $('#call-video').addEventListener('click', () => startCall(true));
  $('#banner-audio').addEventListener('click', () => startCall(false));
  $('#banner-video').addEventListener('click', () => startCall(true));
  $('#ctl-mic').addEventListener('click', () => callAction((call) => call.toggleMic()));
  $('#ctl-cam').addEventListener('click', () => callAction((call) => call.toggleCamera()));
  $('#ctl-screen').addEventListener('click', () =>
    callAction((call) => call.toggleScreen(), { quietIfCancelled: true }),
  );
  $('#ctl-expand').addEventListener('click', () => {
    const expanded = stageEl.classList.toggle('expanded');
    setIcon($('#ctl-expand'), expanded ? 'minimize' : 'maximize');
  });
  $('#ctl-hangup').addEventListener('click', () => session && endCall(session, true));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && unread) {
      unread = 0;
      document.title = TITLE;
    }
  });
  setInterval(tick, 1000);
}

init();
