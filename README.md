<p align="center">
  <img src="web/favicon.svg" alt="pchat logo" width="112" height="112">
</p>

<h1 align="center">pchat</h1>

<p align="center">
  Private rooms that vanish. Self-hosted, end-to-end encrypted chat, voice, video and file sharing.
</p>

Rooms live at `https://<your-domain>/<room-id>`.

1. Someone creates a room with an ID (a generated UUID, or any string), a PIN, a nickname and a mode.
2. They invite others in one of two ways:
   - send the room link and, **through a different channel**, the PIN;
   - or create a **one-time invite link / QR code** that joins without a PIN.
3. Up to 5 people chat, call and share files.

## Modes

| Mode    | Where messages live                    | When they disappear                                        |
|---------|----------------------------------------|------------------------------------------------------------|
| Private | server RAM only (last 500 messages + files) | at the TTL (default 12h), on "Destroy", or on a server restart |
| Logged  | SQLite + files on disk (ciphertext only)    | on "Destroy", or after an optional idle period              |

A private room can be switched to logged from inside the chat (menu → **Keep history**). Its RAM history and files move to disk, the timer stops, and everyone in the room sees a notice. It can't be switched back.

## Features

- **Chat** has emoji (a picker, `:)`-style emoticons that become 🙂, and large single-emoji messages), reactions, typing indicators, clickable links and day separators.
- **Calls** offer voice, video and screen sharing. They are a WebRTC full mesh, which works well for up to about 4 people (rooms hold 5). Mic and camera can be toggled mid-call, and tiles show who is speaking.
- **Files and photos:** send with the 📎 button, drag and drop, or paste.
  - Files are encrypted in the browser in 256 KiB chunks before upload.
  - Photos are resized and re-encoded, which strips EXIF data such as GPS location. They arrive with a tiny encrypted thumbnail and open full size in a viewer.
  - Other files download and decrypt on demand.
- **One-time invites:** any member can create a link (with a QR code) that lets one person join without the PIN.
  - It works once and expires after 5 minutes (configurable).
  - The inviter sees live when it has been used.
  - On mobile it can be sent through the system share sheet.
- **Interface:** light and dark themes follow the system setting, sounds can be toggled, and the layout is built for phones: bottom-sheet menus, large touch targets, and no iOS input zoom.

## Security model

Each browser derives three values from the room ID and PIN:
- `ref` = SHA-256 of the room ID. The server knows rooms only by this hash.
- `encKey` comes from PBKDF2-SHA256 (600k iterations) over the PIN. It is an AES-GCM key for messages and nicknames, and it never leaves the browser.
- `auth` is a second key from the same derivation. The server stores only `sha256(auth)` and uses it to reject wrong PINs.

As a result, the server and its database never see room IDs, PINs, nicknames or message text.

Call setup is encrypted with the same key. Offers, answers and ICE candidates are relayed as ciphertext, so the server can't swap DTLS fingerprints and can't intercept media. Media itself is DTLS-SRTP, sent peer-to-peer or through the TURN relay, which only forwards encrypted packets. TURN credentials are short-lived HMACs (coturn `use-auth-secret`) and are handed out only to clients already in a room.

File chunks are bound to the room, file id, position and "last chunk" flag through the AES-GCM associated data, so the server can't reorder, truncate or swap them. The file API (`/api/files/<room-hash>/<id>`) uses the same PIN proof as joining.

Invite links are `https://<domain>/i#<secret>`. The secret lives in the URL fragment, which browsers never send to the server, and the page removes it from the address bar on open. HKDF turns the secret into an AES key and a lookup id. The inviter's browser seals the room ID and PIN with that key and registers only the ciphertext under the id. Redeeming takes a `POST`, so link-preview bots that only `GET` can't use an invite up, and the server hands the ciphertext out once and then forgets it. The server never holds anything that decrypts it. As with any bearer link, whoever opens an unused invite first gets in, so send it only to the intended person.

Wrong PINs are rate-limited per IP and per room. The ID and PIN strength meters warn when a value is guessable.

Limits:
- The server operator could serve modified JavaScript. This is inherent to web-based E2EE.
- A weak PIN on a logged room can be brute-forced offline by anyone holding the database.
- Opening `/<room-id>` puts the ID in proxy access logs. The page sends `Referrer-Policy: no-referrer`.

## Run

```sh
cp .env.example .env      # then set PCHAT_DOMAIN, HOST_IP and a random TURN_SECRET
docker compose up -d --build     # app on :PCHAT_PORT (default 8085), coturn on 3478 (host network)
node scripts/smoke-test.mjs ws://localhost:8085/ws   # protocol test (Node 22+)
```

| `.env` variable | Meaning |
|---|---|
| `PCHAT_DOMAIN` | Public hostname your reverse proxy serves pchat on. Also used for STUN/TURN. |
| `HOST_IP` | LAN address of the machine running the containers. coturn binds to it. |
| `PCHAT_PORT` | Port the app is published on for the reverse proxy (default 8085). |
| `TURN_SECRET` | Shared secret between the app and coturn (`head -c 32 /dev/urandom \| base64`). |

Browsers expose WebCrypto only on HTTPS or `localhost`. `http://<lan-ip>:8085` loads the page but cannot create rooms.

### Limits for shared files: `config/pchat.json`

```jsonc
{
  "privateRooms": { "maxFileMB": 10, "maxRoomFilesMB": 50, "maxTotalFilesMB": 512 }, // RAM
  "loggedRooms":  { "maxFileMB": 100, "maxRoomFilesMB": 1024 },                      // disk
  "invites":      { "ttlMinutes": 5 }                                                // one-time links
}
```

`maxTotalFilesMB` caps the RAM used by files across all private rooms together. `ttlMinutes` is how long an unused invite link stays valid. The file is mounted read-only into the container. Run `docker compose restart pchat` after editing it; the limits in effect are printed at startup.

### Reverse proxy (example: Caddy)

pchat needs a TLS-terminating reverse proxy in front of it. With Caddy, on the same or another machine:

```
chat.example.com {
	reverse_proxy 192.168.1.10:8085
}
```

Caddy handles TLS and WebSocket upgrades automatically. `TRUST_PROXY=1` in `docker-compose.yml` makes rate limits use the client IP from `X-Forwarded-For`.

### TURN relay (calls across NATs and mobile networks)

coturn runs with host networking on `HOST_IP` and advertises the public IP, which it detects at container start. If the public IP changes, run `docker compose restart coturn`. It needs these ports:

| Where                      | What                                                        |
|----------------------------|-------------------------------------------------------------|
| Router → `HOST_IP`         | forward UDP+TCP **3478** and UDP **49160–49260**            |
| Host firewall (e.g. ufw)   | `sudo ufw allow 3478` and `sudo ufw allow 49160:49260/udp`  |

Without these, calls still work when the browsers can reach each other directly (same LAN, most home NATs). The relay matters for mobile data and strict NATs. The relay refuses to forward to private address ranges, so it can't be used to reach your LAN.

## Layout

- `server/src/index.js`: HTTP server for static files and the `/<room-id>` fallback, the WebSocket upgrade, and the origin check.
- `server/src/hub.js`: rooms, TTL timers, member cap, rate limits and the message protocol (chat, ephemeral events, call presence and signalling).
- `server/src/store.js`: SQLite and on-disk file persistence for logged rooms (`node:sqlite`).
- `server/src/config.js`: loads `config/pchat.json`.
- `web/`: the frontend, plain ES modules with no build step.
  - `crypto.js` holds all the encryption.
  - `call.js` is the WebRTC mesh. The member with the smaller id sends every offer, so offers never collide, and camera/screen toggles are a `replaceTrack`, so they need no renegotiation.
  - `files.js` handles chunked file encryption, upload/download with progress, and image re-encoding and thumbnails.
  - `emoji.js`, `icons.js` and `sound.js` hold emoji data, inline icons and synthesized tones.
  - `qrcode.js` is vendored [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 (MIT), used for invite QR codes.

## Roadmap

- Direct browser-to-browser transfer for very large files (WebRTC DataChannel).
- Inline playback for shared audio and video.
- Device picker (choose mic/camera), plus a group-call SFU if rooms ever need more than about 5 people.
