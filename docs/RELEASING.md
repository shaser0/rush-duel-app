# Release process — rush-app

This document describes the changes made to the update chain as part of
**Phase 3 (supply chain)** of the security audit, along with the release
workflow to follow for each new version.

---

## Applied changes

### Item 15 — SHA-256 verification of the downloaded binary (T2/F1)

**Files changed:** `scripts/release/update.js`, `server.js`

Previously, the binary downloaded from GitHub was installed as-is, with no
integrity check. A compromised GitHub account or an intercepted HTTP redirect
was enough to deliver a malicious binary.

**What was added in `update.js`:**

- `fetchText(url)` — downloads a text asset following HTTPS-only redirects
  (rejects any `http://` redirect).
- `fetchChecksums(release, assetFilename)` — locates the `checksums.sha256`
  asset in the GitHub release and returns the expected hash for the current
  platform's binary.
- `verifyFile(filePath, expectedHash)` — computes the SHA-256 of the downloaded
  file; if the hash doesn't match, deletes the file and throws.
- `checkUpdate()` now returns the full `release` object in addition to the
  existing fields.
- `downloadUpdate(downloadUrl, release, appDir, onProgress)` — after the
  download, fetches the checksum from the release and verifies the binary. Any
  mismatch aborts the installation.

**What must be provided with each release:**

A `checksums.sha256` asset uploaded to the GitHub Release, in the standard
`sha256sum` format:

```text
<hash256>  rush-app-win.exe
<hash256>  rush-app-linux
<hash256>  rush-app-macos
```

This file is generated automatically by `npm run build` (see below).

---

### Item 16 — SHA-256 hashes of the data files in `data-version.json` (T2/F4)

**Files changed:** `public/index.html` (client), `scripts/release/hash-data.js`,
`data/data-version.json`

Previously, the downloaded JSON files (`cards.json`, `sets-data.json`, etc.)
were used without any integrity check. A tampered manifest could deliver altered
data or content containing XSS.

> **Architecture note:** the original Phase 3 implementation verified data files
> in a Node-side downloader (`scripts/release/data-update.js`). Reference data
> has since moved to the jsDelivr CDN, loaded and cached **in the browser
> client** (IndexedDB) — `data-update.js` was removed. Integrity verification now
> lives in the client's `refDownload()` in [`public/index.html`](public/index.html).

**What the client does (`refDownload` in `public/index.html`):**

- Fetches each data file's raw bytes and computes its SHA-256 via
  `crypto.subtle.digest` (the same hex digest `hash-data` writes).
- Compares it against the matching entry in the downloaded `data-version.json`
  `hashes` map. On a mismatch it **rejects** that file — a corrupt `cards.json`
  aborts the download (falls back to cache / the pinned baseline), a corrupt
  optional file is blanked and not cached so the next launch retries.
- Verification runs only for **immutable CDN tags** (`v*`, `data-v*`). It is
  skipped for the mutable `@main` ref — whose per-file CDN cache snapshots can
  legitimately mismatch the manifest — and for a same-origin dev checkout, whose
  local data may be edited without re-running `hash-data`. This avoids false
  rejects while still protecting every pinned-tag download.

**Expected structure of `data-version.json`:**

```json
{
  "version": 2,
  "files": ["cards.json", "sets-data.json", "gallery-images.json", "image-urls.json", "banlist.json"],
  "hashes": {
    "cards.json":           "<sha256>",
    "sets-data.json":       "<sha256>",
    "gallery-images.json":  "<sha256>",
    "image-urls.json":      "<sha256>",
    "banlist.json":         "<sha256>"
  }
}
```

The `hashes` field is generated automatically by `npm run hash-data` (see below).

---

### Item 17 — Versioned URL instead of the `main` branch (T2/F5)

Previously, data was always downloaded from `main/data`, which meant any commit
on `main` immediately became an available update — no release process, no
validation.

**What changed:**

Clients pin their data to an **immutable git tag** rather than the mutable
`main` branch. The tag is resolved in this priority order:

1. The `tag` named by the data-channel pointer (`data/data-channel.json`) —
   e.g. `data-v15` for a data-only publish, or `vX.Y.Z` for a release.
2. The application version from the embedded `package.json` (baseline for a
   fresh install with no cache and no reachable channel).
3. Fallback to same-origin `/data` (local development only).

jsDelivr serves a pinned tag as one consistent, permanently-cached snapshot, so
a single commit's files can't drift apart the way `@main`'s per-file caches can.

---

## Script: `npm run hash-data`

**File:** `scripts/release/hash-data.js`

Computes the SHA-256 of each file listed in `data/data-version.json` and writes
the result into the manifest's `hashes` field. Also keeps `data-channel.json`'s
`version` (and `tag`) in sync when bumping.

```bash
npm run hash-data                          # update the hashes field only
npm run hash-data -- --bump                # hashes + version++, channel.tag → v<package.json version>
npm run hash-data -- --bump --data-tag     # hashes + version++, channel.tag → data-v<new version>
npm run hash-data -- --bump --data-tag --if-changed   # as above, but a no-op when no data changed
```

Run it after any data change (syncs), before committing.

---

## Updating data WITHOUT publishing a binary (data channel)

Clients resolve their dataset via a **pointer file**, `data/data-channel.json`,
read from the `main` branch (jsDelivr `@main`, ~12 h cache). It names the **tag**
and **version** of the current data:

```json
{ "tag": "data-v15", "version": 15 }
```

At launch (and via the "⟳ Check for card-data update" button on the home
screen), the client compares `version` to its IndexedDB cache; if newer, it
downloads the JSON from `cdn.jsdelivr.net/gh/shaser0/rush-duel-app@<tag>/data`,
verifies each file's hash, and reloads. **No binary rebuild is required.**
`GET /api/config` exposes the pointer URL (`dataChannelUrl`), overridable via
`DATA_CHANNEL_URL` (Phase 3: Oracle may later serve an endpoint instead).

**Important:** jsDelivr caches a pinned tag **permanently** (immutable). So
**never move** a data tag — always create a **new, incremental** one
(`data-v15` → `data-v16`, …). Because the data lives on an immutable tag while
only the tiny `data-channel.json` pointer lives on mutable `@main`, jsDelivr can
never serve `data-channel.json` and `data-version.json` at mismatched versions
(the per-file cache skew that previously drove clients into a reload loop).

### Automated data publishing (default path)

The scheduled **[`data-sync.yml`](.github/workflows/data-sync.yml)** workflow
does this weekly — you normally don't touch data by hand. It runs
`npm run sync-data` (which ends with `hash-data --bump --data-tag --if-changed`),
and **only if the data actually changed** it commits `data/`, creates the
immutable `data-v<N>` tag, and purges the `@main` channel pointer from jsDelivr.
See [`DATA-UPDATES.md`](DATA-UPDATES.md) for details and the manual equivalent.

### Manual data-only publish flow

```bash
# 1. Refresh the data + recompute hashes/version + set channel tag to data-v<N>
npm run sync-cards && npm run sync-sets && npm run sync-gallery && npm run sync-banlist
npm run hash-data -- --bump --data-tag      # → data-version.json + data-channel.json { tag: "data-v<N>", version: <N> }

# 2. Commit
git add data/
git commit -m "chore(data): refresh card data (data-v<N>)"

# 3. Create the immutable data tag (the "data-" prefix does NOT match the
#    release workflow's "v[0-9]*" trigger, so it never builds binaries) and push
git tag "data-v<N>"
git push origin main
git push origin "data-v<N>"
```

Once jsDelivr refreshes `@main/data/data-channel.json` (≤ 12 h), clients switch
to `data-v<N>` automatically; the manual button forces an immediate check.

> A `data-v<N>` tag contains only `data/` — the binary remains the latest
> `vX.Y.Z` release. The next real binary release must embed a data `version` ≥
> the channel's (otherwise the channel takes precedence again, which is correct).

---

## CI workflow: `.github/workflows/release.yml`

Triggered automatically on any push of a `vX.Y.Z` tag.

**Steps:**

1. Checkout the repo at the pushed tag.
2. Install dependencies via `npm ci`.
3. Verify that `data-version.json` contains a `hashes` field — the release is
   blocked if it's missing or empty (the developer forgot `npm run hash-data`).
4. `npm run build`:
   - Compiles `rush-app-win.exe`, `rush-app-linux`, `rush-app-macos` via
     `@yao-pkg/pkg`
   - Patches the Windows PE header (console → GUI)
   - Copies `data/` and `README.md` into `dist/`
   - Creates the archives `rush-app-win.zip`, `rush-app-linux.tar.gz`,
     `rush-app-macos.tar.gz`
   - **Generates `dist/checksums.sha256`** with the SHA-256 hashes of the three
     binaries
5. **Changelog extraction:** the **body** of the tagged commit's message is used
   as the release body (convention — see Step 2). If that body is empty (subject
   only, as for v1.5.3), a changelog is **synthesized automatically**: the tagged
   commit's subject + a bulleted list of commits since the previous release tag.
6. Creates the GitHub Release with `generate_release_notes: true` (which appends
   the "Full Changelog" link **after** the body) and uploads:
   - `rush-app-win.exe` + `rush-app-win.zip`
   - `rush-app-linux` + `rush-app-linux.tar.gz`
   - `rush-app-macos` + `rush-app-macos.tar.gz`
   - `checksums.sha256`

---

## Full release workflow

### Step 1 — Update the data

After running the sync scripts (`sync-cards`, `sync-sets`, etc.):

```bash
npm run hash-data -- --bump
# → updates data/data-version.json (hashes + version++)
```

Commit the result:

```bash
git add data/data-version.json
git commit -m "chore: bump data version to X"
```

### Step 2 — Bump the application version

Edit `package.json` to update `"version"`, then commit with a **full changelog
in the message body**: the CI workflow uses that body as the GitHub release body
(convention — see commit `1252cac`).

```bash
# edit package.json: "version": "X.Y.Z"
git add package.json
git commit -m "chore(release): bump to vX.Y.Z — short summary" -m "$(cat <<'EOF'
Section:
- point 1
- point 2
EOF
)"
```

> **If the commit body is empty** (subject only), the release is no longer
> broken: the workflow automatically synthesizes a changelog from the tagged
> commit's subject + the list of commits since the previous tag. Providing a
> real body is still preferable — a written summary beats the raw list of commit
> subjects.

### Step 3 — Push the tag

```bash
git tag vX.Y.Z
git push origin main --tags
```

The CI workflow takes over: build, generate `checksums.sha256`, create the
GitHub release.

### Step 4 — Verify the release

On GitHub, the release must contain these 7 assets:

| Asset | Description |
| ------- | ------------- |
| `rush-app-win.exe` | Standalone Windows binary |
| `rush-app-win.zip` | Windows archive (binary + data + README) |
| `rush-app-linux` | Standalone Linux binary |
| `rush-app-linux.tar.gz` | Linux archive |
| `rush-app-macos` | Standalone macOS binary |
| `rush-app-macos.tar.gz` | macOS archive |
| `checksums.sha256` | SHA-256 hashes of the three binaries |

---

## Summary of protections in place

| Attack vector | Protection |
| --- | --- |
| Malicious binary from a compromised GitHub account | SHA-256 verified before installation (Item 15) |
| Intercepted HTTP redirect to a malicious binary | Rejects any non-HTTPS redirect (T2/F3, already applied) |
| Tampered data in the manifest | SHA-256 verified per data file, client-side, for pinned tags (Item 16) |
| Accidental commit to `main` delivered as an update | Data pinned to an immutable versioned tag (Item 17) |
| Path traversal via the manifest's `files` list | File-name sanitization (T2/F2, already applied) |
