# Online Duel — Phase 1 (rooms + guest identity)

> **Build note:** the pkg binary always runs in online-capable mode (Socket.IO mounted,
> binds `0.0.0.0`). `ONLINE_MODE=1` is still accepted in dev/server deployments.

---

## Launch (host)

Double-click the binary — it's ready to host.

In dev:

```bash
# Windows PowerShell
$env:ONLINE_MODE=1 ; npm start

# Linux / macOS / Git Bash
ONLINE_MODE=1 npm start
```

Then expose the server via Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Share the `https://xxx.trycloudflare.com` URL and the room code with your opponent.

---

## Join a room (opponent)

1. Launch your own app (binary or `npm start`).
2. Go to **Online Duel**.
3. Enter the host's Cloudflare Tunnel URL in **"URL du serveur hôte"**.
4. Enter your pseudo and the room code → **Rejoindre**.

---

## Acceptance criteria (two-machine test)

| # | Criterion | How to verify |
| --- | --------- | ------------- |
| 1 | Host creates a room and gets a code | Click "Héberger un duel" |
| 2 | Opponent joins via code + tunnel URL | Click "Rejoindre" with the tunnel URL filled in |
| 3 | Both players appear in presence | "Joueurs" banner in the room |
| 4 | Chat is real-time both ways | Send a message from each side |
| 5 | When opponent closes the tab, host sees them leave | System message + presence update |
| 6 | A message to a room you're not in is rejected | Try `socket.emit('chat:message',…)` without joining |

---

## Module architecture

```text
online/
  index.js      ← Socket.IO mount + event handlers (authoritative)
  rooms.js      ← In-memory room state (Map code → room)
  validate.js   ← Per-message-type validation schemas
  rateLimit.js  ← Sliding-window rate limiter (chat + join)
  README.md     ← This file
```

**Wired in `server.js`:**

```js
const IS_ONLINE = !!(process.env.ONLINE_MODE || process.pkg);

if (IS_ONLINE) require('./online').mount(httpServer);

httpServer.listen(PORT, IS_ONLINE ? '0.0.0.0' : '127.0.0.1', ...);
```

---

## Security gates

When running as a shared server (`ONLINE_MODE` env var, not pkg binary):

- `GET /api/update/check` and `POST /api/update/apply` are disabled (downloads & executes a binary)
- `GET /api/collections` and `PUT /api/collections|decks` are disabled (single shared file)
- `POST /api/heartbeat` is disabled (auto-kill process)

In the pkg binary these routes remain active — each user has their own installation.

---

## Out of scope for Phase 1

- Board, zones, cards, drag-and-drop → Phase 2
- Discord auth, sessions, persistence → Phase 3
- Matchmaking, advanced reconnection, spectators → Phase 4
