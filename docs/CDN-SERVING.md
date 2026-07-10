# CDN-serving analysis — rush-app

**What can we serve from a CDN instead of baking into the binary, and what do we
gain (and lose) by doing so?**

This is a decision/architecture note, not an implemented feature. It captures the
reasoning so a future "float more of the app on the CDN" project starts from a
clear map instead of re-deriving it.

---

## TL;DR

- The app already CDN-serves the two things that matter most by **bytes** and by
  **change frequency**: **card data** and **card images**.
- The only substantial asset still forcing binary releases is **`index.html`** —
  which happens to be the file that changes most often (the entire SPA lives in
  it).
- Moving `index.html` to the CDN is feasible and consistent with the existing
  data-channel pattern, but its value is **capped by offline support**: because a
  desktop app must keep a working bundled fallback, CDN-serving the UI buys
  "faster UI hotfixes for online users," **not** "the binary stops containing the
  app."
- Everything that touches the local machine or speaks a versioned protocol to the
  host (local persistence, the online-duel socket server, the self-updater, the
  socket.io client) is **native forever** and should stay in the binary.

---

## The dividing line

One rule decides everything:

> **A static asset can be CDN-served. The running process — and anything that
> reads/writes the local machine or speaks a live protocol to the host — cannot.**

Static bytes (data, images, HTML, client JS/CSS) are immutable, versionable,
cacheable, and can be pinned on an immutable jsDelivr tag. The Node process, the
local file I/O, and the socket server are the irreducible native core: updating
them *is* shipping a new binary.

Everything else is just choosing where to put the seam between "shipped in the
`.exe`" and "fetched from the CDN."

---

## Current inventory

| Component | Where it lives today | CDN-servable? |
| --- | --- | --- |
| **Card data** — `cards.json`, `sets-data.json`, `gallery-images.json`, `image-urls.json`, `banlist.json` | jsDelivr `@data-v<N>`, cached in IndexedDB; served locally from `data/` on disk as fallback | ✅ **Already CDN** |
| **Card images** — resolved by `imgUrl()` | Yugipedia CDN direct URLs (`image-urls.json`) + an image-resize proxy; never touch the binary | ✅ **Already CDN** (the bulk of the app's bytes) |
| **`index.html`** — the entire ~340 KB single-file SPA (all of `public/`) | Bundled into the binary (`pkg` assets `public/**/*`), served via `express.static(__dirname/public)` | ⚠️ **Movable** (the main remaining candidate) |
| **socket.io client-dist** | Bundled (`pkg` assets) | ⚠️ Technically movable, but **should stay pinned** to the binary — it must match the socket.io **server** version |
| The Node process + `server.js` | Binary | ❌ Native |
| Local persistence — `/api/collections`, `/api/decks` (read/write user files) | Binary + local disk | ❌ Native |
| Host control — `/api/version`, `/api/config`, `/api/sync`, `/api/sync-status`, `/api/heartbeat` | Binary | ❌ Native |
| The self-updater — `/api/update/check`, `/api/update/apply` | Binary | ❌ Native |
| socket.io **server** (online duels) | Binary | ❌ Native |

The striking takeaway: **by bytes and by churn, the app is already mostly
CDN-served.** Images (the heavy part) and data are external. `index.html` is the
one high-value chunk left in the binary.

---

## Advantages of CDN-serving, per asset

### Card data — *already done, this is the template*

- **Ship new cards without an app release.** The daily `data-sync.yml` workflow
  publishes a new immutable `data-v<N>` tag; clients pick it up via the tiny
  `data-channel.json` pointer. No binary rebuild, no re-download.
- **Consistent, permanently-cached snapshots.** A pinned tag can't suffer the
  per-file cache skew that `@main` can, so `data-channel.json` and
  `data-version.json` never disagree on version.
- **Integrity without a server.** Each file's SHA-256 is verified client-side
  (`refDownload()` in `index.html`) against `data-version.json`, so a tampered CDN
  file is rejected.

### Card images — *already done, and the biggest win*

- **Zero image bytes in the binary or in the release archive.** Thousands of card
  images would otherwise dwarf everything else. They live on Yugipedia's CDN and
  an image-resize/`webp` proxy, fetched on demand and cached by the browser layer.
- **Free responsive delivery.** The resize proxy serves per-width `webp`, so the
  app never ships or stores multiple resolutions.
- **New artwork appears automatically** as `image-urls.json` (itself a data file)
  updates — again, no app release.

### `index.html` — *the candidate; where the interesting advantages are*

- **Decouples UI iteration from binary releases.** Since ~all features live in
  `index.html`, most changes today force a full build → tag → re-distribute →
  users re-download cycle. CDN-serving collapses that to "publish a new UI
  version," the same one-step flow the data already uses.
- **Everyone-online converges fast.** A UI bugfix reaches up-to-date online users
  on their next launch instead of whenever they happen to update the binary.
- **Reuses proven infrastructure.** The pinned-tag + hash-verify + jsDelivr-purge
  machinery already exists for data; the UI is just another hashed asset on the
  same kind of channel.

### socket.io client — *why NOT to CDN-serve it*

- It must stay **version-locked to the socket.io server** compiled into the
  binary. Floating it on a CDN invites a client/server protocol mismatch. It's
  small and changes only when the binary's socket.io does, so bundling costs
  nothing and removes a whole class of skew. This is the concrete illustration of
  the coupling rule below.

---

## General advantages (independent of which asset)

- **Release friction drops.** Fewer binary builds/signings/re-downloads for
  content and UI changes.
- **Bandwidth and storage move off the release.** Release archives stay tiny;
  large/mutable assets live on a CDN built for it.
- **Global edge caching + immutability.** jsDelivr serves pinned tags from the
  edge, permanently cached — fast and stable worldwide.
- **One rollback primitive.** Reverting a bad publish = pointing the channel back
  at the previous tag; no rebuild.

---

## The unifying idea: one release manifest

Rather than proliferate channels (`data-channel`, a future `ui-channel`, …),
generalize the existing pattern into **a single release manifest** pinned at a
tag:

```jsonc
{
  "version": 42,
  "min_host_version": "1.6.0",       // binary refuses assets it can't support
  "assets": {
    "index.html":   "<sha256>",
    "cards.json":   "<sha256>",
    "…":            "<sha256>"
  }
}
```

The binary, on launch: reads the manifest, downloads only what changed, verifies
each hash (the `hash-data.js` machinery already does this), refuses UI newer than
`min_host_version`, and **falls back to its bundled copy** for anything missing or
unreachable. One bootstrap, one purge, one atomic version — the data-channel
pattern, generalized to every static asset.

---

## Drawbacks and risks — **offline is the headline**

CDN-serving the UI can be done two ways with **opposite** offline properties:

| Approach | Offline behavior |
| --- | --- |
| **A. Hard CDN dependency** (fetch `index.html` at launch, no local copy) | **Dead offline.** First run with no network = blank app. Every user's ability to *render* now depends on GitHub + jsDelivr uptime. Never ship this for a desktop app. |
| **B. CDN as update source, bundled + cached copy as truth** (mirrors the data model) | **Offline still works** — serves the last cached UI, or the bundled one on first run. This is the only acceptable design, and it's where the real drawbacks live. |

Under the acceptable design (B), the honest costs are:

1. **You can never stop shipping the UI in the binary.** Offline/first-run needs a
   working bundled fallback, so the binary always contains a full `index.html`.
   CDN-serving therefore does **not** let the binary "stop containing the app" —
   it only lets *online, current* users get UI ahead of the next binary.

2. **The stale-fallback tail.** A user offline for weeks, or on a locked-down
   machine that never phones home, runs the bundled UI indefinitely. Your live UI
   now has a long tail of unreachable old clients, and the bundled fallback rots
   relative to the CDN unless you keep cutting binaries to refresh it. You've
   traded "everyone updates on a binary release" for "online users update fast,
   offline users drift" — a *harder* support story, not a simpler one.

3. **The test matrix doubles.** Today `index.html` + `server.js` are one atomic,
   co-tested unit. With B you must validate {bundled UI, cached UI, newest CDN UI}
   × {server API versions in the wild}, plus the version-gate. Offline is a
   first-class row in that matrix.

4. **Cold-start latency or update-lag.** To stay fast (and work offline) you serve
   the cached copy immediately and update in the background for *next* launch — so
   UI updates are always one launch behind. "Instant hotfix" isn't actually
   instant.

5. **The trust boundary expands.** A bundled (signable) `index.html` is
   tamper-resistant. A CDN-fetched one is executable client code (the whole app is
   inline JS) loaded at runtime, putting GitHub + jsDelivr inside your
   code-execution trust boundary. Mitigated by SHA-256 pinning + immutable tags,
   but a compromised/misconfigured CDN or a manifest-fetch tamper becomes a
   code-injection path it currently isn't. Endpoint-security/AV also dislikes apps
   that download-and-execute remote HTML/JS.

6. **New cache-management surface.** Partial/corrupt downloads, verify-before-use,
   disk-full, permissions, invalidation — all new edge cases, all of which must
   **fail closed** to the bundled copy.

### The coupling constraint

Everything you CDN-serve that *talks to the host* is bound by the host's API
version. So "how much can we CDN-serve" really means "how much are we willing to
freeze/version the server contract." The route surface today is small and stable
(data proxy + local CRUD + update), which is favorable — but the socket.io client
is the cautionary example: anything speaking a live protocol to the binary must
stay pinned to it.

---

## Recommendation

- **Worth doing (eventually):** float `index.html` on the manifest, using design
  **B** (bundled fallback + version-gate). It's the one high-churn asset left, and
  it meaningfully cuts release friction for *online* users.
- **Leave native:** everything touching local files, the socket server, and the
  updater — no benefit, real risk.
- **Keep pinned to the binary:** the socket.io client and anything else speaking a
  versioned protocol to the host.
- **Don't hard-depend on the CDN for the UI (design A).** Offline and upstream
  outages make it unacceptable for a desktop app — a lesson reinforced by
  Yugipedia 502s taking down data syncs during development.

**Decision heuristic:** the payoff scales with *how often you hotfix the UI* ×
*how reliably online your users are*, against *how much you value offline
simplicity and a single tested artifact*. High UI churn + mostly-online users →
design B pays off. Stable UI or significant offline/local use → the extra
machinery and expanded trust boundary likely outweigh just cutting a binary, which
is a solved, boring, safe path today.

For any single frontend change (e.g. the `name_translated` display/search
feature), the right answer remains a normal `vX.Y.Z` release. Revisit the
CDN-UI manifest only if binary-release friction becomes a recurring, *measured*
pain.
