// Tiny synthesized UI sounds, so there are no audio files to serve.
let ctx = null;

function context() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(frequencies, { duration = 0.12, gap = 0.09, volume = 0.06, type = 'sine' } = {}) {
  let ac;
  try {
    ac = context();
  } catch {
    return;
  }
  frequencies.forEach((frequency, i) => {
    const start = ac.currentTime + i * gap;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  });
}

const SOUNDS = {
  message: () => tone([880, 1320], { duration: 0.14 }),
  join: () => tone([523, 659, 784], { gap: 0.08 }),
  leave: () => tone([784, 523], { gap: 0.1 }),
  call: () => tone([659, 880, 659, 880], { duration: 0.18, gap: 0.2, volume: 0.07, type: 'triangle' }),
};

let enabled = true;

export function setSoundEnabled(value) {
  enabled = value;
}

export function play(name) {
  if (enabled) SOUNDS[name]?.();
}

// Browsers only allow audio after a user gesture; call this from one to unlock it early.
export function unlockAudio() {
  try {
    context();
  } catch {}
}

export function sharedAudioContext() {
  return context();
}
