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
| `data-version.json`  | The **manifest** clients verify against: `version`, the `files` list, and a SHA-256 `hashes` map. The client rejects any file whose hash doesn't match. |

`hash-data` keeps the two `version` numbers in lockstep so they can't drift.

---

## The automated routine (default path)

A scheduled GitHub Actions workflow does this automatically — you normally don't
touch data by hand:

**[`.github/workflows/data-sync.yml`](.github/workflows/data-sync.yml)**

- **Runs daily at 05:00 UTC** (`cron: '0 5 * * *'`), and on-demand via
  **Actions → Data Sync → Run workflow** (`workflow_dispatch`).
- Steps: `npm run sync-data` → commit `data/` **only if something changed** →
  push to `main` → purge the jsDelivr cache for the channel + data files.
- Publishes via the data channel with `tag: "main"` (no `vX.Y.Z` tag), so it
  **never** triggers the binary-release workflow. Clients pick up the new data
  through the background / manual **"⟳ Check for card-data update"** mechanism —
  no app update required.

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

`sync-data` runs the four syncs then `hash-data --bump --tag=main`, which:
- refreshes `data/data-version.json` `hashes` and bumps its `version`,
- rewrites `data/data-channel.json` to `{ "tag": "main", "version": <new> }`.

Then commit and push:

```bash
git add data/
git commit -m "chore(data): refresh card data (v<new>)"
git push origin main
```

Because the channel tag is `main`, jsDelivr serves the JSON straight from
`@main/data`. Clients switch over within jsDelivr's `@main` cache TTL (~12 h), or
**immediately** if the user clicks **"⟳ Check for card-data update"** on the home
screen. (CI purges the cache automatically; a local push does not — so allow up
to ~12 h, or purge manually, see below.)

Only need one source?

```bash
node scripts/sync/sync-banlist.js       # or sync-cards / sync-sets / sync-gallery
npm run hash-data -- --bump --tag=main
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

- **Always re-run `hash-data` after any `data/` change.** The client verifies each
  file's SHA-256 against `data-version.json`; stale hashes → clients refuse the
  update. `npm run sync-data` and the release flow both do this for you.
- **Never move a pinned `vX.Y.Z` (or `data-vN`) tag.** jsDelivr caches a pinned
  ref **permanently**. If you need fresh data on a pinned scheme, cut a *new*
  incremental tag; for rolling updates use `tag: "main"` (short TTL) as the
  routine does.
- **Version only ever goes up.** Clients compare `data-channel.json`'s `version`
  to their cached value and only download when it's higher.

## Manually purging the jsDelivr cache (only needed for local pushes)

```bash
for f in data-channel.json cards.json sets-data.json gallery-images.json image-urls.json banlist.json; do
  curl -fsS "https://purge.jsdelivr.net/gh/shaser0/rush-duel-app@main/data/$f"
done
```
