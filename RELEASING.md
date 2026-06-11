# Processus de release — rush-app

Ce document décrit les changements apportés à la chaîne de mise à jour dans le cadre de la **Phase 3 (supply chain)** de l'audit de sécurité, ainsi que le workflow de release à suivre pour chaque nouvelle version.

---

## Changements appliqués

### Item 15 — Vérification SHA-256 du binaire téléchargé (T2/F1)

**Fichiers modifiés :** `scripts/release/update.js`, `server.js`

Avant, le binaire téléchargé depuis GitHub était installé tel quel, sans aucun contrôle d'intégrité. Un compte GitHub compromis ou un redirect HTTP intercepté suffisait pour livrer un binaire malveillant.

**Ce qui a été ajouté dans `update.js` :**

- `fetchText(url)` — télécharge un asset texte en suivant les redirects HTTPS uniquement (rejette tout redirect `http://`).
- `fetchChecksums(release, assetFilename)` — cherche l'asset `checksums.sha256` dans la release GitHub et retourne le hash attendu pour le binaire de la plateforme courante.
- `verifyFile(filePath, expectedHash)` — calcule le SHA-256 du fichier téléchargé ; si le hash ne correspond pas, supprime le fichier et lève une exception.
- `checkUpdate()` retourne désormais l'objet `release` complet en plus des champs existants.
- `downloadUpdate(downloadUrl, release, appDir, onProgress)` — après le téléchargement, récupère le checksum depuis la release et vérifie le binaire. Toute divergence avorte l'installation.

**Ce qui doit être fourni à chaque release :**

Un asset `checksums.sha256` uploadé sur la GitHub Release, au format standard `sha256sum` :

```
<hash256>  rush-app-win.exe
<hash256>  rush-app-linux
<hash256>  rush-app-macos
```

Ce fichier est généré automatiquement par `npm run build` (voir ci-dessous).

---

### Item 16 — Hashes des fichiers de données dans `data-version.json` (T2/F4)

**Fichiers modifiés :** `scripts/release/data-update.js`, `data/data-version.json`, `server.js`

Avant, les fichiers JSON téléchargés (`cards.json`, `sets-data.json`, etc.) étaient installés sans vérification d'intégrité. Un manifeste falsifié pouvait livrer des données altérées ou contenant du XSS.

**Ce qui a été ajouté dans `data-update.js` :**

- `computeHash(filePath)` — calcule le SHA-256 d'un fichier via ReadStream.
- `downloadData(appDir, files, hashes, rawBase, onProgress)` — après chaque `downloadFile`, si le manifeste contient un hash pour ce fichier, il est vérifié. En cas de mismatch, le fichier est supprimé et une exception est levée.
- `checkDataUpdate(appDir, dataTag)` — retourne désormais `hashes` (map `filename → sha256`) et `rawBase` en plus des champs existants.

**Structure attendue de `data-version.json` :**

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

Le champ `hashes` est généré automatiquement par `npm run hash-data` (voir ci-dessous).

---

### Item 17 — URL versionnée plutôt que branche `main` (T2/F5)

**Fichiers modifiés :** `scripts/release/data-update.js`

Avant, les données étaient toujours téléchargées depuis `main/data`, ce qui signifiait que tout commit sur `main` constituait immédiatement une mise à jour disponible — sans processus de release, sans validation.

**Ce qui a changé :**

La fonction `buildRawBase(dataTag)` construit l'URL de base selon l'ordre de priorité suivant :

1. `dataTag` passé en argument à `checkDataUpdate`
2. Variable d'environnement `RUSH_DATA_TAG`
3. Version de l'application lue depuis `package.json` (ex. `v1.2.2`)
4. Fallback sur `main` (développement local uniquement)

Pour les binaires distribués, la version du `package.json` embarqué est utilisée automatiquement : un binaire `1.2.2` pointe sur `refs/tags/v1.2.2/data`. Aucune configuration utilisateur n'est nécessaire.

---

## Nouveau script : `npm run hash-data`

**Fichier :** `scripts/release/hash-data.js`

Calcule le SHA-256 de chaque fichier listé dans `data/data-version.json` et écrit le résultat dans le champ `hashes` du manifeste.

```bash
npm run hash-data           # met à jour le champ hashes uniquement
npm run hash-data -- --bump # met à jour hashes ET incrémente version
```

À exécuter après chaque mise à jour des données (syncs), avant de committer.

---

## Nouveau workflow CI : `.github/workflows/release.yml`

Déclenché automatiquement sur tout push d'un tag `vX.Y.Z`.

**Étapes :**

1. Checkout du dépôt au tag poussé.
2. Installation des dépendances via `npm ci`.
3. Vérification que `data-version.json` contient un champ `hashes` — la release est bloquée si le champ est absent ou vide (le développeur a oublié `npm run hash-data`).
4. `npm run build` :
   - Compile `rush-app-win.exe`, `rush-app-linux`, `rush-app-macos` via `@yao-pkg/pkg`
   - Patche le PE header Windows (console → GUI)
   - Copie `data/` et `README.md` dans `dist/`
   - Crée les archives `rush-app-win.zip`, `rush-app-linux.tar.gz`, `rush-app-macos.tar.gz`
   - **Génère `dist/checksums.sha256`** avec les hashes SHA-256 des trois binaires
5. Création de la GitHub Release avec `generate_release_notes: true` et upload de :
   - `rush-app-win.exe` + `rush-app-win.zip`
   - `rush-app-linux` + `rush-app-linux.tar.gz`
   - `rush-app-macos` + `rush-app-macos.tar.gz`
   - `checksums.sha256`

---

## Workflow de release complet

### Étape 1 — Mettre à jour les données

Après avoir lancé les scripts de sync (`sync-cards`, `sync-sets`, etc.) :

```bash
npm run hash-data -- --bump
# → met à jour data/data-version.json (hashes + version++)
```

Committer le résultat :

```bash
git add data/data-version.json
git commit -m "chore: bump data version to X"
```

### Étape 2 — Bumper la version de l'application

Éditer `package.json` pour mettre à jour `"version"` :

```bash
# éditer package.json : "version": "X.Y.Z"
git add package.json
git commit -m "chore: bump app version to X.Y.Z"
```

### Étape 3 — Pousser le tag

```bash
git tag vX.Y.Z
git push origin main --tags
```

Le workflow CI prend le relais : build, génération de `checksums.sha256`, création de la release GitHub.

### Étape 4 — Vérifier la release

Sur GitHub, la release doit contenir les 7 assets suivants :

| Asset | Description |
|-------|-------------|
| `rush-app-win.exe` | Binaire Windows autonome |
| `rush-app-win.zip` | Archive Windows (binaire + data + README) |
| `rush-app-linux` | Binaire Linux autonome |
| `rush-app-linux.tar.gz` | Archive Linux |
| `rush-app-macos` | Binaire macOS autonome |
| `rush-app-macos.tar.gz` | Archive macOS |
| `checksums.sha256` | Hashes SHA-256 des trois binaires |

---

## Résumé des protections en place

| Vecteur d'attaque | Protection |
|-------------------|------------|
| Binaire malveillant sur compte GitHub compromis | SHA-256 vérifié avant installation (Item 15) |
| Redirect HTTP intercepté vers binaire malveillant | Rejet de tout redirect non-HTTPS (T2/F3, déjà appliqué) |
| Données falsifiées dans le manifeste | SHA-256 vérifié pour chaque fichier data (Item 16) |
| Commit accidentel sur `main` livré comme mise à jour | URL pointant sur un tag de release versionné (Item 17) |
| Path traversal via la liste `files` du manifeste | Sanitisation des noms de fichiers (T2/F2, déjà appliqué) |
