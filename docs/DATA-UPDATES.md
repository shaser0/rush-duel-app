# Updating card data — rush-app

Card data (`cards.json`, `sets-data.json`, `gallery-images.json`, `image-urls.json`,
`banlist.json`) is **decoupled from the app binaries**. Clients load it from the
jsDelivr CDN and cache it in IndexedDB; the release binaries do **not** bundle it
(see [`scripts/release/build.js`](scripts/release/build.js) — reference data is
excluded). So refreshing data normally needs **no release and no rebuild**.

Two small files drive the whole thing, both under `data/`:

| File | Role |
| --- | --- |
| `data-channel.json` | The **pointer** clients read (always from `@main`): `{ "tag": <git ref>, "version": <n> }`. Names which git ref jsDelivr serves the JSON from, and the current data version. |
| `data-version.json`  | The **manifest**: `version`, the `files` list, and a SHA-256 `hashes` map recorded alongside the cached data (integrity metadata; the client does **not** currently re-verify per-file hashes — updates are gated on `version`). |

`hash-data` keeps the two `version` numbers in lockstep so they can't drift.

---

## The automated routine (default path)

A scheduled GitHub Actions workflow does this automatically — you normally don't
touch data by hand:

**[`.github/workflows/data-sync.yml`](.github/workflows/data-sync.yml)**

- **Runs daily at 05:00 UTC** (`cron: '0 5 * * *'`), and on-demand via
  **Actions → Data Sync → Run workflow** (`workflow_dispatch`).
- Steps: `npm run sync-data` → commit `data/` **only if something changed** →
  push to `main` → **create an immutable `data-v<N>` git tag** on that commit →
  purge the jsDelivr cache for the channel pointer.
- Publishes via the data channel with `tag: "data-v<N>"` (an immutable data-only
  tag — **not** a `vX.Y.Z` release tag, so it **never** triggers the
  binary-release workflow). Clients read the `data-channel.json` pointer from
  `@main` but download the data from the pinned `@data-v<N>` tag, so jsDelivr
  always serves one **consistent** snapshot. (Using the mutable `@main` ref for
  the data itself let jsDelivr serve `data-channel.json` and `data-version.json`
  at mismatched versions — a per-file cache skew that drove clients into a reload
  loop.) Clients pick the new data up through the background / manual **"⟳ Check
  for card-data update"** mechanism — no app update required.

To trigger it now instead of waiting for the daily run:

```bash
gh workflow run data-sync.yml
gh run watch                       # follow the run
```

### Adjusting the routine
- **Cadence:** edit the `cron:` line (UTC). e.g. twice daily → `0 5,17 * * *`;
  weekly Mondays → `0 5 * * 1`.
- **Disable temporarily:** Actions tab → Data Sync → `⋯` → Disable workflow, or
  comment out the `schedule:` block.

---

## Manual data-only update (same effect, run locally)

Use this if you want to sync outside the daily window or inspect the diff first.

```bash
npm run sync-data
```

`sync-data` runs the four syncs then `hash-data --bump --data-tag`, which:
- refreshes `data/data-version.json` `hashes` and bumps its `version`,
- rewrites `data/data-channel.json` to `{ "tag": "data-v<new>", "version": <new> }`.

Then commit, push, and create the matching immutable tag:

```bash
git add data/
git commit -m "chore(data): refresh card data (data-v<new>)"
git push origin main
git tag "data-v<new>" && git push origin "data-v<new>"   # tag name = data-channel.json's "tag"
```

Clients read the `data-channel.json` pointer from `@main` (jsDelivr cache TTL
~12 h) and download the data from the immutable `@data-v<new>` tag. They switch
over within that TTL, or **immediately** if the user clicks **"⟳ Check for
card-data update"** on the home screen. (CI purges the channel pointer
automatically; a local push does not — so allow up to ~12 h, or purge manually,
see below.)

Only need one source?

```bash
node scripts/sync/sync-banlist.js       # or sync-cards / sync-sets / sync-gallery
npm run hash-data -- --bump --data-tag
# then commit + push + tag as above
```

---

## Shipping data as part of an app release

When the data update rides along with a `vX.Y.Z` binary release, pin the channel
to the **release tag** instead of `main` (immutable, permanently cached — the
safest option). Bump `package.json` **first**, then hash without `--tag`:

```bash
# after editing package.json to the new vX.Y.Z
npm run hash-data -- --bump             # channel.tag → v<package.json version>
git add data/ package.json && git commit -m "chore(release): bump to vX.Y.Z"
git tag vX.Y.Z && git push origin main --tags
```

The release workflow ([`release.yml`](.github/workflows/release.yml)) then builds
the binaries and purges the jsDelivr cache for both `@main` and the new tag.

---

## Rules that keep clients from breaking

- **Always re-run `hash-data` after any `data/` change.** It keeps the `hashes`
  map and both `version` numbers current (and, via `--if-changed`, is a no-op when
  nothing actually changed). `npm run sync-data` and the release flow both do this
  for you. *(The client records these hashes but does not currently re-verify them;
  updates are gated on `version`.)*
- **Never move a pinned `vX.Y.Z` or `data-vN` tag.** jsDelivr caches a pinned
  ref **permanently**. To publish fresh data, always cut a *new* incremental tag
  (`data-v15` → `data-v16`) — never repoint an existing one.
- **Version only ever goes up.** Clients compare `data-channel.json`'s `version`
  to their cached value and only download when it's higher.

## Manually purging the jsDelivr cache (only needed for local pushes)

The data files live on the immutable `@data-v<N>` tag, which jsDelivr fetches
fresh on first request — no purge needed. Only the mutable `@main` channel
pointer needs purging so clients see the new version before its ~12 h TTL:

```bash
curl -fsS "https://purge.jsdelivr.net/gh/shaser0/rush-duel-app@main/data/data-channel.json"
```
