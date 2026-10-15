import { toHex } from './crypto.js';

// Files are encrypted in fixed-size chunks so large files never need to sit in
// memory as one plaintext buffer, and each chunk's associated data binds it to the
// room, the file id, its position and whether it is last. The server can therefore
// neither reorder, truncate nor swap chunks between files.
export const CHUNK = 256 * 1024;
const IV = 12;
const TAG = 16;
const RECORD = IV + CHUNK + TAG;
const encoder = new TextEncoder();

const chunkAad = (ref, id, index, last) => encoder.encode(`pchat/file/v1|${ref}|${id}|${index}|${last ? 1 : 0}`);

export function newFileId() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

export function encryptedSize(size) {
  return Math.max(1, Math.ceil(size / CHUNK)) * (IV + TAG) + size;
}

export async function encryptFile(key, ref, id, blob) {
  const count = Math.max(1, Math.ceil(blob.size / CHUNK));
  const parts = [];
  for (let i = 0; i < count; i++) {
    const plain = await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer();
    const iv = crypto.getRandomValues(new Uint8Array(IV));
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: chunkAad(ref, id, i, i === count - 1) },
      key,
      plain,
    );
    parts.push(iv, new Uint8Array(cipher));
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

export async function decryptFile(key, ref, id, bytes, type) {
  const parts = [];
  for (let offset = 0, i = 0; offset < bytes.length; i++) {
    const end = Math.min(offset + RECORD, bytes.length);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(offset, offset + IV), additionalData: chunkAad(ref, id, i, end === bytes.length) },
      key,
      bytes.subarray(offset + IV, end),
    );
    parts.push(new Uint8Array(plain));
    offset = end;
  }
  return new Blob(parts, { type: type || 'application/octet-stream' });
}

export class TransferError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fileUrl = (ref, id) => `/api/files/${ref}/${id}`;

// XMLHttpRequest because fetch() can't report upload progress.
export function uploadFile(ref, auth, id, body, onProgress) {
  const xhr = new XMLHttpRequest();
  const done = new Promise((resolve, reject) => {
    xhr.open('PUT', fileUrl(ref, id));
    xhr.setRequestHeader('Authorization', `Bearer ${auth}`);
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress?.(event.loaded / event.total);
    xhr.onload = () => {
      if (xhr.status === 201) return resolve();
      let code = 'upload_failed';
      try {
        code = JSON.parse(xhr.responseText).error || code;
      } catch {}
      reject(new TransferError(code));
    };
    xhr.onerror = () => reject(new TransferError('connection'));
    xhr.onabort = () => reject(new TransferError('cancelled'));
    xhr.send(body);
  });
  return { done, cancel: () => xhr.abort() };
}

export async function downloadFile(ref, auth, id, onProgress) {
  const res = await fetch(fileUrl(ref, id), { headers: { Authorization: `Bearer ${auth}` }, cache: 'no-store' });
  if (!res.ok) {
    let code = res.status === 404 ? 'file_gone' : 'download_failed';
    try {
      code = res.status === 404 ? 'file_gone' : (await res.json()).error || code;
    } catch {}
    throw new TransferError(code);
  }
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  const extra = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length <= total) out.set(value, received);
    else extra.push(value);
    received += value.length;
    if (total) onProgress?.(received / total);
  }
  if (!extra.length && received === total) return out;
  // No or wrong Content-Length: fall back to concatenating.
  const all = new Uint8Array(received);
  all.set(out.subarray(0, Math.min(total, received)));
  let offset = Math.min(total, received);
  for (const part of extra) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

// ---------- images ----------

const REENCODE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif']);
const MAX_EDGE = 2560;
const THUMB_EDGE = 360;

function canvasBlob(source, width, height, type, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(source, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function fit(width, height, edge) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Photos are re-encoded: that strips EXIF metadata such as GPS location, applies
// the camera's rotation, and keeps phone photos to a sensible size. GIFs keep
// their animation and are sent as-is. A small JPEG thumbnail travels inside the
// (encrypted) chat message, so it shows before anything is downloaded.
// Returns null when the browser can't decode the image; it is then sent as a plain file.
export async function prepareImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    let blob = file;
    let type = file.type;
    let name = file.name || 'image';
    if (REENCODE.has(file.type)) {
      const [w, h] = fit(bitmap.width, bitmap.height, MAX_EDGE);
      type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      blob = (await canvasBlob(bitmap, w, h, type, 0.88)) ?? file;
      if (blob === file) type = file.type;
      else if (type === 'image/jpeg') name = name.replace(/\.(heic|heif|webp|avif|png|jpe?g)$/i, '') + '.jpg';
    }
    let [tw, th] = fit(bitmap.width, bitmap.height, THUMB_EDGE);
    let thumb = await blobToDataUrl(await canvasBlob(bitmap, tw, th, 'image/jpeg', 0.6));
    // The thumbnail rides inside an encrypted chat message, which has a size cap.
    if (thumb.length > 24_000) {
      [tw, th] = fit(bitmap.width, bitmap.height, 200);
      thumb = await blobToDataUrl(await canvasBlob(bitmap, tw, th, 'image/jpeg', 0.45));
    }
    return { blob, type, name, width: bitmap.width, height: bitmap.height, thumb: thumb.length <= 30_000 ? thumb : null };
  } finally {
    bitmap.close?.();
  }
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
