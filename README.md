# Rush App

A Yu-Gi-Oh! Rush Duel **pack-opening simulator**, **collection tracker**, and **deck builder** — a single-page web app served by a small local server.

From the main menu you can:

- **Open Packs** — rip booster packs, structure decks, and promos with animated, rarity-accurate pulls
- **My Collection** — browse and filter every card you've pulled, sorted by set and rarity
- **Deck Builder** — build, import, and export Rush Duel decks

> ⚠️ Unofficial, non-commercial fan project — not affiliated with Konami. See [Disclaimer](#disclaimer).
> Built with the help of [Claude](https://www.anthropic.com/claude) (Anthropic).

---

## Installation

No installation required. Just download and run. The `data/` folder must stay next to the executable at all times.

```text
rush-app/
  rush-app-win.exe    ← Windows
  rush-app-macos      ← macOS
  rush-app-linux      ← Linux
  data/
    cards.json
    sets-data.json
    gallery-images.json
    image-urls.json
    collections.json
    decks.json
```

---

## Running the app

### Windows

Double-click **`rush-app-win.exe`** — no terminal will appear. Your browser opens automatically to <http://localhost:3000>.

### macOS

Double-click **`rush-app-macos`**.

> If macOS blocks it: right-click → Open → Open anyway.

### Linux

Mark the binary executable once (only needed the first time):

```sh
chmod +x rush-app-linux
```

Then double-click it from your file manager, or run it from a terminal.

### From source

```sh
npm install
npm start
```

---

## Closing the app

Just close the browser window. The server stops automatically within 15 seconds.

---

## Online Duel

Play against a friend over the internet — no VPN or port-forwarding required.

### Host

1. **Launch the binary** — it automatically runs in online mode (no config needed).
2. **Expose it with [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):**

   ```sh
   cloudflared tunnel --url http://localhost:3000
   ```

3. Copy the `https://xxx.trycloudflare.com` URL from the terminal output.
4. Open **Online Duel → Host a duel**, then share the tunnel URL and room code with your opponent.

### Guest

1. Launch your own copy of the app (binary or `npm start`).
2. Go to **Online Duel**.
3. Paste the host's `https://xxx.trycloudflare.com` URL into **Host server URL**.
4. Enter the room code and your nickname → **Join**.

> **From source:** set `ONLINE_MODE=1` before `npm start` (PowerShell: `$env:ONLINE_MODE=1; npm start`), then run cloudflared in a second terminal.

### What you can do in a room

- **Spectators welcome** — anyone who joins without claiming a seat watches the duel in real time (cards in hand are hidden).
- **Claim / release a seat** — click *Sit Down* in the lobby to become a player; *Stand Up* to go back to spectator. You can swap freely between games.
- **Duel** — full Rush Duel rules: draw phase, main phase, battle phase, pass turn. ATK/DEF stats are shown on field monsters and can be edited live (stat buffs, effects). Combat damage is calculated automatically in the log.
- **Win counter** — wins are tracked per seat for the session and shown in the presence panel.
- **Rematches** — when a game ends you return to the lobby automatically; hit *Sit Down* again to play another game.

---

## Features

### Open Packs

Simulate opening booster packs, structure decks, and special/promo sets with box-rate-accurate rarity odds and animated card flips. You can also build **custom packs** to open.

### Collection

Every pull can be added to a named collection. Browse and filter by rarity, attribute, type (Monster / Spell / Trap), race, sub-type, series, and Level/ATK/DEF ranges. Collections are saved to `data/collections.json`.

### Deck Builder

- Search/filter the full card pool (Skills and Duel Markers are excluded — they aren't playable).
- Click to add cards; build a **Main Deck** (40–60) and **Extra Deck** (Fusion **and** Ritual monsters, up to 15).
- Rush Duel rules enforced: max 3 copies per card.
- **Legend cards** are flagged with a gold ★ and limited to **one per card-type** (Monster/Spell/Trap), one copy, never in the Extra Deck.
- Save multiple named decks (stored in `data/decks.json`).
- **Import/Export** decks via the clipboard in a plain-text format:

```text
Monster
3 Sevens Road Magician
...
Spell
1 Dark Hole
...
Trap
1 Mirror Force
...
Extra
1 Sevens Road Witch
...
```

Your collections and decks are saved automatically. As long as you keep the `data/` folder, your data is never lost.

---

## Updating card data

Card, set, and gallery data are synced from [Yugipedia](https://yugipedia.com). From source you can run the sync scripts in `scripts/` (they respect Yugipedia's rate limits). The `is_legend`, `card_type`, and `property` fields are populated during the card sync; `scripts/tag-legends.js` can backfill them for an existing `data/raw-cards.json`. (The card sync writes the raw `data/raw-cards.json`, then `clean-cards.js` produces the `data/cards.json` the app serves.)

---

## Troubleshooting

### Nothing happens when I double-click

Check `data/rush-app.log` for error details.

### The page shows no cards

Make sure the `data/` folder is in the same directory as the executable and that `cards.json` is present inside it.

### Port 3000 is already in use (Windows)

```sh
set PORT=3001 && rush-app-win.exe
```

Then open <http://localhost:3001> instead.

### Port 3000 is already in use (macOS / Linux)

```sh
PORT=3001 ./rush-app-macos   # macOS
PORT=3001 ./rush-app-linux   # Linux
```

---

## Disclaimer

This is an **unofficial, non-commercial, fan-made project**, created purely for personal, educational, and entertainment purposes. It is **not affiliated with, endorsed, sponsored, or approved by Konami** in any way.

*Yu-Gi-Oh!*, *Yu-Gi-Oh! Rush Duel*, and all associated card names, artwork, text, logos, characters, and related materials are trademarks and copyright © **Konami Digital Entertainment**. All rights to the cards and the game belong to Konami.

Card data, set information, and card images are sourced from **[Yugipedia](https://yugipedia.com)**. Card images are loaded live from Yugipedia at runtime and are **not** copied into or redistributed by this repository.

No copyright or trademark infringement is intended, and no challenge to Konami's ownership is implied. This project generates no revenue and **must not be used for any commercial purpose**. If you are a rights holder and would like content removed, please open an issue and it will be addressed promptly.

## License & usage

The application **code** in this repository is provided free of charge for **non-commercial, personal use only**. You may not sell, monetize, or commercially distribute this software or any build of it. All *Yu-Gi-Oh!* card content (names, text, artwork) remains the exclusive property of Konami Digital Entertainment, as described in the Disclaimer above.

## Acknowledgements & thanks

- **Konami Digital Entertainment** — for creating *Yu-Gi-Oh!* and *Yu-Gi-Oh! Rush Duel*. All card names, artwork, and game content belong to them; this project is only a fan-made tribute.
- **[Yugipedia](https://yugipedia.com)** — the community wiki that provides the card data, set lists, rulings, and images this app depends on.
- **[Claude](https://www.anthropic.com/claude) (Anthropic)** — this app was designed and built with the help of Claude (via Claude Code). Thank you!
