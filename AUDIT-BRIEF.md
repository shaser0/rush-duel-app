# Brief d'audit — rush-app

Document à passer à Claude Code pour cadrer l'audit. Projet : simulateur d'ouverture de boosters Yu-Gi-Oh! Rush Duel (Node/Express 5 + fichiers JSON, packagé en binaire via `@yao-pkg/pkg`). Pas de base de données, pas de tests, état stocké en JSON dans `data/`.

## 1. Contexte technique (à lire avant d'auditer)

- **Backend** : `server.js` (~430 lignes), Express 5, sert `public/index.html` (SPA monolithique de ~175 Ko) et une API REST.
- **Persistance** : tout en JSON dans `data/` (collections, decks, cartes, banlist…). Pas de SQL malgré la présence de `better-sqlite3` dans les dépendances — **à vérifier : `better-sqlite3` est-il réellement utilisé ?** Sinon, dépendance morte à retirer.
- **Distribution** : binaires autonomes Win/macOS/Linux. Mécanismes d'auto-update du binaire (`/api/update/*`) et des données (`/api/data/*`).
- **Mode worker** : en binaire, le serveur se relance lui-même avec `RUSH_SYNC=<name>` pour exécuter les scripts de sync en sous-process.

## 2. Points de sécurité prioritaires

À traiter en priorité, idéalement via `/security-review` :

1. **API d'écriture sans authentification + CORS ouvert.** `app.use(cors())` autorise toutes les origines, et `PUT /api/collections`, `PUT /api/decks`, `POST /api/sync`, `POST /api/update/apply`, `POST /api/data/apply` écrivent sur le disque / lancent des process sans aucun contrôle. N'importe quel onglet web ouvert sur la machine peut piloter le serveur local (CSRF / DNS-rebinding). → Évaluer : binder sur `127.0.0.1` uniquement, token d'origine, vérification du header `Origin`, ou au minimum désactiver CORS.

2. **TLS désactivé sur certains fetchs.** `sync-cards.js` et `tag-legends.js` utilisent `rejectUnauthorized: false` (MITM possible sur les données téléchargées depuis Yugipedia). Incohérent avec les autres scripts qui, eux, utilisent le re-spawn `--use-system-ca`. → Uniformiser sur `--use-system-ca` et supprimer `rejectUnauthorized: false`.

3. **Chaîne d'auto-update = exécution de code.** `update.js` télécharge un binaire depuis GitHub Releases et écrit un script (`apply-update.bat`/`.sh`) que l'utilisateur exécute ; `data-update.js` télécharge des fichiers de données. **Aucune vérification d'intégrité (hash/signature)** n'est visible. Un dépôt/CDN compromis ou un MITM permettrait de livrer un binaire malveillant. → Vérifier la présence d'un checksum signé, le pinning du dépôt, et la validation HTTPS stricte.

4. **`exec()` avec interpolation de chaîne** dans `openBrowser` (`server.js`). L'URL est constante ici donc pas exploitable en l'état, mais le motif est à proscrire ; préférer `execFile`/`spawn` avec arguments séparés.

5. **Écritures non atomiques de l'état utilisateur.** `saveCollections`/`saveDecks` font un `writeFileSync` direct : une coupure pendant l'écriture corrompt le fichier. (À noter : `data-update.js` fait bien du `.tmp` + rename — appliquer le même pattern partout.) Pas de limite de taille sur `express.json()` non plus (DoS mémoire).

6. **Path/裏 surface diverses** : `sendFile` sur des chemins fixes (OK), mais passer en revue l'absence de validation des corps de requête (structure des `collections`/`decks` à peine validée : seulement `Array.isArray`).

## 3. Réflexion sur la structure des scripts

Tu avais raison de tiquer : il y a **12 scripts dans un dossier `scripts/` à plat**, qui mélangent trois natures très différentes, avec beaucoup de duplication.

### Inventaire par rôle

**Sync récurrents (chemin d'exécution normal, appelés par `server.js`)**
- `sync-cards.js` (16 Ko) — récupère les cartes depuis Yugipedia → `raw-cards.json`
- `sync-sets.js` (13 Ko) — données des sets
- `sync-gallery.js` (8 Ko) — images de galerie
- `sync-banlist.js` (5 Ko) — liste Forbidden/Limited
- `clean-cards.js` (6 Ko) — transforme `raw-cards.json` → `cards.json` (réutilisé par sync-cards et tag-legends)

**Distribution / mise à jour**
- `build.js` — packaging des binaires (dev uniquement)
- `update.js` — auto-update du binaire
- `data-update.js` — téléchargement des données pré-construites
- `migrations.js` — migrations de schéma au démarrage (runtime)

**One-off / diagnostic (ne font PAS partie du flux normal)**
- `backfill-names.js` — backfill ponctuel de `name_en`
- `tag-legends.js` — backfill ponctuel des Legend/card_type
- `check-missing-images.js` — outil de QA

### Problèmes de fond

- **Duplication massive de boilerplate.** Le helper HTTP (`get`/`fetchJson` avec retry + `sleep` + rate-limit) est réimplémenté dans presque chaque fichier, avec des variantes subtiles. Les `User-Agent` sont incohérents (`RushDuelDB/1.0`, `YgoRushDB/1.0`, `rush-duel-app/updater`). La résolution de `DATA_DIR` (`process.env.RUSH_DATA_DIR || …`) est copiée partout.
- **Shim TLS incohérent.** Le re-spawn `--use-system-ca` est présent dans `backfill-names`, `sync-banlist`, `sync-sets` mais **absent** de `sync-cards`, `sync-gallery`, `tag-legends` (qui contournent autrement). Comportement Windows non uniforme → bugs et faille (cf. point sécurité #2).
- **Aucune séparation runtime / build / one-off.** Les scripts jetables côtoient le code chargé en production dans le même dossier plat.

### Proposition de réorganisation

```
scripts/
  lib/
    yugipedia.js      ← client API Yugipedia : fetch batché, rate-limit, retry, User-Agent unique
    http.js           ← get() HTTPS avec --use-system-ca centralisé (plus de rejectUnauthorized:false)
    paths.js          ← DATA_DIR et résolution APP_DIR partagées
  sync/
    cards.js  sets.js  gallery.js  banlist.js  clean-cards.js
  release/
    build.js  update.js  data-update.js
  maintenance/        ← ou archive/ ; scripts ponctuels à sortir du chemin courant
    backfill-names.js  tag-legends.js  check-missing-images.js
  migrations.js       ← reste (chargé au runtime par server.js)
```

Bénéfices : ~200-300 lignes de duplication supprimées, un seul endroit pour la logique réseau (donc la correction TLS se fait une fois), et une séparation claire entre ce qui tourne en prod et ce qui est jetable.

**Compromis à signaler à l'audit** : déplacer les fichiers casse les `require('./scripts/...')` dans `server.js` et les chemins `pkg.scripts` du `package.json` (`scripts/**/*.js` reste OK car récursif). À faire d'un bloc, avec un test de lancement du binaire après. Les one-off (`backfill-names`, `tag-legends`) ont sans doute déjà fait leur travail — confirmer puis archiver/supprimer plutôt que maintenir.

## 4. Questions à faire trancher par l'audit

- `better-sqlite3` est-il utilisé, ou dépendance fantôme ?
- Les binaires `dist/` et `data/raw-cards.json` (4 Mo) doivent-ils être dans le dépôt git ? Vérifier `.gitignore`.
- Couverture de tests = 0. Au minimum, tests sur `clean-cards.js` (pure data-transform, facile à tester) et sur les migrations.
- Validation des entrées API (au-delà de `Array.isArray`).

## 5. Niveau de détail attendu — va au fond des choses

Cet audit doit être **exhaustif, pas un survol**. Pour chaque point ci-dessous, ne te contente pas de signaler : démontre, localise, et propose un correctif concret.

**Pour chaque finding, fournis :**
- le **fichier + numéro(s) de ligne** exact(s) ;
- un **extrait du code** incriminé ;
- la **gravité** (Critique / Élevée / Moyenne / Faible) et le **vecteur d'exploitation** concret (« voici comment un attaquant / un bug déclenche le problème ») ;
- un **correctif proposé** sous forme de diff ou de snippet, pas juste une phrase ;
- l'**effort estimé** et les effets de bord (ex. casse du packaging pkg, migration de données).

**Passe en revue, fichier par fichier, sans en sauter :**
- `server.js` — chaque route, chaque middleware, chaque appel `fs`/`exec`/`spawn`. Trace le flux d'une requête `PUT /api/decks` du réseau jusqu'à l'écriture disque.
- les 12 scripts de `scripts/` — un par un. Pour les sync, vérifie la gestion d'erreur réseau, le rate-limit, ce qui se passe si Yugipedia renvoie du HTML/une 429/un JSON partiel, et si un sync interrompu laisse `data/` dans un état corrompu.
- `clean-cards.js` — c'est de la transformation pure : liste les cas limites non gérés (regex sur les noms, `(L)`/`(R)`, archseries avec `*`, markup wiki imbriqué).
- `update.js` + `data-update.js` — déroule le scénario complet d'une mise à jour malveillante : que faut-il compromettre, et qu'est-ce qui l'empêcherait ?
- `public/index.html` — SPA de 175 Ko : cherche les `innerHTML`/`eval`/injections DOM (XSS via noms de cartes ou données importées de deck), la gestion du heartbeat, et les appels à l'API locale.
- `package.json` / `package-lock.json` — `npm audit`, dépendances inutilisées (`better-sqlite3` ?), versions épinglées.
- `.gitignore` + contenu versionné — secrets, binaires `dist/`, gros fichiers de données qui ne devraient pas être dans git.

**Pour le refactor des scripts (section 3) :** ne te limite pas à proposer l'arborescence. Quantifie la duplication réelle (lignes identiques entre fichiers), liste **tous** les `require()` et chemins `pkg` à mettre à jour, et écris la version mutualisée de `lib/http.js` et `lib/yugipedia.js` à partir du code existant.

**Livrable attendu :** un rapport structuré (findings sécurité triés par gravité → dette technique → refactor scripts → tests manquants), chaque item actionnable seul. Si un point est ambigu ou demande un choix de conception, pose la question plutôt que de supposer.

## 6. Commandes suggérées pour Claude Code

```
/security-review          # focalisé sur la section 2, avec le niveau de détail de la section 5
/review                   # revue générale
```
Puis, en langage naturel :
- « Audite ce projet en suivant AUDIT-BRIEF.md. Va au détail : fichier par fichier, ligne par ligne, avec extraits de code, vecteur d'exploitation et correctif en diff pour chaque finding. Ne survole rien. »
- « Refactor des scripts selon la section 3, sans casser le packaging pkg ni les require() de server.js. Montre-moi le diff complet avant d'appliquer. »
