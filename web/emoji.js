const CATEGORIES = [
  {
    name: 'Smileys',
    icon: '😀',
    list: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖',
  },
  {
    name: 'People',
    icon: '👋',
    list: '👋 🤚 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾 🧠 👀 👁️ 👅 👄 🫶 🙋 🤷 🤦 🙇 💃 🕺 👶 👧 👦 👩 👨 🧓 👴 👵',
  },
  {
    name: 'Hearts',
    icon: '❤️',
    list: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟 ⚡ 🎉 🎊 🎈 🎁 🏆 🥇',
  },
  {
    name: 'Nature',
    icon: '🐶',
    list: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🐺 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🐬 🐳 🦈 🌵 🌲 🌴 🍀 🌸 🌹 🌻 🌈 ☀️ 🌙 ❄️ ☔',
  },
  {
    name: 'Food',
    icon: '🍕',
    list: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🌶️ 🌽 🥕 🥐 🍞 🧀 🥚 🍳 🥓 🍔 🍟 🍕 🌭 🌮 🌯 🍣 🍜 🍝 🍰 🎂 🍩 🍪 🍫 🍿 ☕ 🍵 🍺 🍻 🥂 🍷 🥃 🍸',
  },
  {
    name: 'Activities',
    icon: '⚽',
    list: '⚽ 🏀 🏈 ⚾ 🎾 🏐 🎱 🏓 🎮 🎲 🎯 🎸 🎧 🎤 🎬 📷 🚗 🚕 🚌 🚀 ✈️ 🚲 🛵 🚢 🏠 🏖️ 🏔️ 🗺️ ⏰ ⌛',
  },
  {
    name: 'Symbols',
    icon: '💡',
    list: '💡 📱 💻 ⌨️ 🖥️ 🔒 🔓 🔑 🛡️ 📎 📌 ✏️ 📝 📅 📦 💰 💳 📈 📉 🔔 🔕 ✅ ☑️ ❌ ❓ ❗ ⚠️ 🚫 ➕ ➖ ➡️ ⬅️ 🔁 🆗 🆒 🆕 🔴 🟢 🔵 🟡',
  },
].map((c) => ({ ...c, list: c.list.split(' ') }));

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥'];

const EMOTICONS = new Map([
  [':)', '🙂'],
  [':-)', '🙂'],
  [':D', '😄'],
  [':-D', '😄'],
  ['xD', '😆'],
  ['XD', '😆'],
  [';)', '😉'],
  [';-)', '😉'],
  [':(', '🙁'],
  [':-(', '🙁'],
  [":'(", '😢'],
  [':P', '😛'],
  [':p', '😛'],
  [':-P', '😛'],
  [':O', '😮'],
  [':o', '😮'],
  [':*', '😘'],
  ['<3', '❤️'],
  ['</3', '💔'],
  ['B)', '😎'],
  [':/', '😕'],
  [':|', '😐'],
  ['^^', '😊'],
  ['o/', '👋'],
  ['(y)', '👍'],
]);

const EMOTICON_RE = new RegExp(
  `(^|\\s)(${[...EMOTICONS.keys()].map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?=\\s|$)`,
  'g',
);

// Turns standalone text emoticons into emoji: "hi :)" becomes "hi 🙂", but "http://x" is untouched.
export function convertEmoticons(text) {
  return text.replace(EMOTICON_RE, (_, lead, emoticon) => lead + EMOTICONS.get(emoticon));
}

const EMOJI_ONLY_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;

// Messages made of 1–3 emoji are shown large.
export function isJumboEmoji(text) {
  if (!EMOJI_ONLY_RE.test(text) || /^[\d#*\s]+$/.test(text)) return false;
  const count = segmenter ? [...segmenter.segment(text.replace(/\s/g, ''))].length : text.length;
  return count <= 3;
}

const RECENT_KEY = 'pchat-recent-emoji';

function loadRecent() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(value) ? value.slice(0, 24) : [];
  } catch {
    return [];
  }
}

function rememberRecent(emoji) {
  const list = [emoji, ...loadRecent().filter((e) => e !== emoji)].slice(0, 24);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {}
}

// A single shared popover. open(anchor, onPick) positions it next to `anchor`.
export class EmojiPicker {
  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'emoji-picker';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Emoji picker');
    this.tabs = document.createElement('div');
    this.tabs.className = 'emoji-tabs';
    this.grid = document.createElement('div');
    this.grid.className = 'emoji-grid';
    this.root.append(this.tabs, this.grid);
    document.body.append(this.root);

    this.onPick = null;
    this.anchor = null;
    this.category = null;

    this.grid.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-emoji]');
      if (!button) return;
      rememberRecent(button.dataset.emoji);
      this.onPick?.(button.dataset.emoji);
      if (!event.shiftKey) this.close();
    });
    this.tabs.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-category]');
      if (button) this.show(button.dataset.category);
    });
    document.addEventListener('pointerdown', (event) => {
      if (!this.root.hidden && !this.root.contains(event.target) && !this.anchor?.contains(event.target)) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.root.hidden) this.close();
    });
    window.addEventListener('resize', () => this.close());
  }

  categories() {
    const recent = loadRecent();
    return recent.length ? [{ name: 'Recent', icon: '🕘', list: recent }, ...CATEGORIES] : CATEGORIES;
  }

  show(name) {
    const categories = this.categories();
    const current = categories.find((c) => c.name === name) ?? categories[0];
    this.category = current.name;
    this.tabs.replaceChildren(
      ...categories.map((c) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.category = c.name;
        button.title = c.name;
        button.textContent = c.icon;
        button.setAttribute('aria-pressed', String(c === current));
        return button;
      }),
    );
    this.grid.replaceChildren(
      ...current.list.map((emoji) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.emoji = emoji;
        button.textContent = emoji;
        return button;
      }),
    );
    this.grid.scrollTop = 0;
  }

  toggle(anchor, onPick) {
    if (!this.root.hidden && this.anchor === anchor) return this.close();
    this.open(anchor, onPick);
  }

  open(anchor, onPick) {
    this.anchor = anchor;
    this.onPick = onPick;
    this.show(this.category);
    this.root.hidden = false;

    const rect = anchor.getBoundingClientRect();
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    const above = rect.top - height - 8;
    const top = above >= 8 ? above : Math.min(rect.bottom + 8, window.innerHeight - height - 8);
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  close() {
    this.root.hidden = true;
    this.anchor = null;
    this.onPick = null;
  }
}
