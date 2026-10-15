export const ROOM_RE = /^[A-Za-z0-9._~-]{3,128}$/;
export const RESERVED = new Set(['static', 'ws', 'healthz']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORDS_RE = /^[a-z]+([-_.~ ][a-z]+)*$/i;
const PIN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

// Rough guessability estimate in bits. It is deliberately pessimistic for words,
// digits and repetition, which are what people actually type.
export function estimateBits(value) {
  if (!value) return 0;
  if (UUID_RE.test(value)) return 122;
  if (/^\d+$/.test(value)) return Math.round(value.length * Math.log2(10));

  let pool = 0;
  if (/[a-z]/.test(value)) pool += 26;
  if (/[A-Z]/.test(value)) pool += 26;
  if (/\d/.test(value)) pool += 10;
  if (/[^A-Za-z0-9]/.test(value)) pool += 16;
  let bits = value.length * Math.log2(pool);

  // Each dictionary word is worth roughly 11 bits, not 4.7 bits per letter.
  if (WORDS_RE.test(value)) bits = Math.min(bits, value.split(/[-_.~ ]/).length * 11 + 4);
  if (new Set(value).size < value.length / 3) bits /= 2;
  return Math.round(bits);
}

const RATINGS = {
  room: [
    [40, 'weak', 'Easy to guess: someone could find this room. The PIN still protects messages, but a UUID is far safer.'],
    [64, 'fair', 'Reasonable. A generated UUID is the safest choice.'],
    [Infinity, 'strong', 'Strong: practically impossible to guess.'],
  ],
  pin: [
    [24, 'weak', 'Weak PIN: anyone who learns the room ID could guess it, especially in Logged mode.'],
    [40, 'fair', 'OK PIN. Longer or generated is safer.'],
    [Infinity, 'strong', 'Strong PIN.'],
  ],
};

export function rate(value, kind) {
  if (!value) return { level: 'none', hint: '' };
  const bits = estimateBits(value);
  const [, level, hint] = RATINGS[kind].find(([max]) => bits < max);
  return { level, hint: `${hint} (~${bits} bits)` };
}

export function randomPin(length = 10) {
  const out = [];
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % PIN_ALPHABET.length);
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out.push(PIN_ALPHABET[byte % PIN_ALPHABET.length]);
    }
  }
  return out.join('');
}
