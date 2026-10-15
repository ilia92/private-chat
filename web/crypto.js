// End-to-end encryption. Everything is derived in the browser from the room ID and PIN:
//   ref    = SHA-256 of the room ID, which is how the server addresses the room
//   encKey = AES-GCM key for messages and nicknames, which never leaves the browser
//   auth   = proof of the PIN, sent to the server, which stores only its SHA-256
const PBKDF2_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function deriveKeys(roomId, pin) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(`pchat/v1/${roomId}`), iterations: PBKDF2_ITERATIONS },
      material,
      512,
    ),
  );
  const encKey = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const ref = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`pchat/room/${roomId}`))));
  return { ref, encKey, auth: toHex(bits.slice(32)) };
}

// The room ref is bound in as associated data, so ciphertext can't be replayed into another room.
export async function encryptJSON(key, ref, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(ref) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  const out = new Uint8Array(iv.length + ciphertext.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ciphertext), iv.length);
  return toBase64(out);
}

export async function decryptJSON(key, ref, blob) {
  const bytes = fromBase64(blob);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(ref) },
    key,
    bytes.slice(12),
  );
  return JSON.parse(decoder.decode(plaintext));
}
