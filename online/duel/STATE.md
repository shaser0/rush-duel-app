# Phase 2 — Structure de l'état de partie (note pour la Phase 5)

> Cœur **serveur autoritatif** d'un duel manuel type Duelingbook, adapté au plateau
> Rush Duel. Le serveur est autoritatif sur l'**appartenance** et la **visibilité**,
> **jamais** sur les règles. Tout est manuel.

## Modules (séparation état / actions — clé de l'extensibilité Phase 5)

```
online/duel/
  state.js        ← structure de données PURE + mutateurs structurels (zéro I/O, zéro règle)
  actions.js      ← registre d'actions { validate, apply } — validation STRUCTURELLE seule
  view.js         ← viewFor(game, seat) : LE filtre anti-fuite (seul objet envoyé au client)
  index.js        ← glue Socket.IO (ensureGame / broadcast / sendSnapshot / onAction)
  state.test.js   ← tests visibilité + appartenance (critères 3 & 7)
  glue.test.js    ← tests routage snapshot + reconnexion (critère 8)
```

La frontière nette **état ↔ actions** est ce qui permet d'ajouter la Phase 5
(automatisation) *par-dessus* : une future couche `rules.js` s'intercalera entre la
validation structurelle (`actions.js`) et la mutation (`state.js`) pour appliquer
automatiquement pioche/phases/dégâts, **sans réécrire** ni l'état ni la vue.

## Le serveur ne connaît pas les cartes

Une carte est une **instance opaque** côté serveur :

```js
{ iid, cardKey, rarity, imgFile, faceDown:bool, position:'atk'|'def' }
```

`cardKey` / `rarity` / `imgFile` viennent **du deck du client** (qui possède déjà
`cards.json` + `image-urls.json`). Le serveur n'assigne que l'`iid` unique, mélange et
déplace ; il n'interprète jamais le sens d'une carte. La légalité du deck est « à
l'honneur » ; le serveur ne borne que la **taille** (≤ 100) et le payload.

## État de partie (`createGame`)

```js
game = {
  _iidSeq, turn /*seat 0|1*/, started, ended, winner,
  players: { 0: board, 1: board },
  log: [ /* événements publics éphémères */ ],
}

board = {
  token,                 // identité stable du joueur (reconnexion)
  lp: 8000,
  hand:      [inst…],    // main
  deck:      [inst…],    // pioche, top = index 0  (ordre + identité 100% serveur)
  graveyard: [inst…],    // cimetière (public)
  monster:   [null,null,null],     // 3 zones de Monstres
  spellTrap: [null,null,null],     // 3 zones de Magie/Piège
  field:     [null],               // 1 zone de Terrain
  maximum:   false,      // indice visuel : fusionner les 3 zones monstres en bloc Maximum
}
```

**Monstres Maximum** : ce sont 3 cartes ([L], base, [R]) posées dans les 3 zones de
monstres — le modèle générique « 3 slots » les gère déjà. Le flag `maximum` n'est
qu'un **rendu** (afficher les 3 slots comme une unité). Aucune logique de règle.

## Zones

| Zone | Type | Visibilité adversaire |
|---|---|---|
| `hand` | pile | **compte + dos** (jamais d'identité) |
| `deck` | pile ordonnée | **compte seul** (jamais l'ordre/identité, même pour le proprio) |
| `graveyard` | pile | **public** (face visible) |
| `monster` ×3 | slots | identité si face visible ; **dos seul** si face cachée |
| `spellTrap` ×3 | slots | idem |
| `field` ×1 | slot | idem |
| `lp` | scalaire | **public** |

## Le filtre de visibilité (`view.js`) — invariant anti-fuite (critère 7)

`viewFor(game, seat)` est **le seul** objet jamais transmis à un client. Pour toute
carte que le spectateur ne doit pas voir, il **supprime** `cardKey`/`rarity`/`imgFile`
et renvoie `{ iid, hidden:true, faceDown, position }`. Garanties :

- l'identité d'une carte cachée (main adverse, carte posée face cachée) n'apparaît
  **jamais** dans un payload destiné à l'adversaire ;
- l'**ordre et l'identité du deck** ne quittent jamais le serveur (les deux joueurs
  ne reçoivent que `deckCount`) ;
- « consulter son propre deck » = réponse **privée ponctuelle** (`duel:private`), hors
  snapshot, jamais relayée à l'adversaire.

Couvert par `state.test.js` (utilise des `cardKey` sentinelles puis grep le snapshot
sérialisé pour prouver l'absence de fuite).

## Actions (toutes manuelles — `actions.js`)

Chaque action : `(game, seat, payload) → { ok } | { error } | { ok, private }`.
Validation **structurelle uniquement** : appartenance (`not_your_card`), zone/slot
valides (`bad_slot`, `slot_occupied`), forme. **Aucune règle de jeu.**

| Action | Effet |
|---|---|
| `loadDeck { deck:[…] }` | charge un deck (instances opaques) dans la zone Deck |
| `ready` | mélange + marque la partie démarrée quand les 2 decks sont chargés |
| `shuffle` | mélange son deck (Fisher-Yates) |
| `draw { n }` | pioche n cartes (top → main) |
| `lookDeck` | **privé** : renvoie le contenu/ordre de SON deck au demandeur seul |
| `move { iid, zone, slot?, deckPos?, faceDown?, position? }` | déplace une carte (drag-and-drop) vers n'importe quelle zone à soi ; `deckPos` ∈ top/bottom/shuffle |
| `flip { iid, faceDown? }` | retourne face visible/cachée (zones de terrain) |
| `position { iid, position? }` | bascule Attaque/Défense (rotation 90°) |
| `maximum { on? }` | bascule le rendu « mode Maximum » |
| `reveal { iid }` | révèle **publiquement** une de ses cartes (log éphémère) |
| `lp { mode:'delta'\|'set', value }` | ajuste les LP (clampé à 0) |
| `coin` / `dice` | pile/face & dé 1–6, résultat public dans le log |
| `passTurn` | passe le jeton de tour (seul le porteur courant le peut) |
| `surrender` | abandonne (fixe `winner` = adversaire) |

`set` (poser face cachée), `défausser`, `envoyer au cimetière`, `renvoyer en main /
au-dessus / en dessous du deck` sont des cas de `move` (zone/slot + `faceDown` +
`deckPos`), pas des actions distinctes — un seul mutateur, surface minimale.

## Protocole Socket.IO

| Sens | Événement | Payload |
|---|---|---|
| client→serveur | `duel:action` | `{ action, payload }` (validé par `validate('duel:action', …)`) |
| serveur→client | `duel:state` | `viewFor(game, seat)` — snapshot filtré complet |
| serveur→client | `duel:private` | réponse privée (ex. `lookDeck`) au demandeur seul |
| serveur→client | `duel:error` | `{ code, action? }` (rejet structurel) |

Après chaque action acceptée, le serveur **rediffuse** un snapshot filtré à chaque
siège connecté (`broadcast`). Le client est un simple miroir de `duel:state`.

## Sièges, identité & reconnexion (critère 8)

- `room.seats = [{ seat, token, pseudo, socketId, connected }]` — `seat` 0 = hôte, 1 = invité.
- `token` = identité **stable** (16 octets hex), générée serveur, renvoyée au client
  via `room:created` / `room:joined`. Le client la persiste (localStorage) et la
  represente dans `room:join` pour se **reconnecter**.
- Tant qu'une partie tourne, une déconnexion **ne détruit pas** le siège : il est
  marqué `connected:false` et **réservé**. Au retour avec le même token, le siège est
  rebindé au nouveau socket et reçoit son snapshot (`sendSnapshot`).
- Sans partie en cours (phase lobby), comportement Phase 1 inchangé (room supprimée
  quand vide). Quand les deux sièges sont déconnectés, la room est récupérée.

## Sécurité (rappel)

- Le serveur **re-vérifie** l'appartenance siège/room à chaque `duel:action` (jamais
  confiance au socket).
- Rate-limiting réutilise le budget de messages par socket.
- Le filtre de visibilité est la **seule** source de vérité envoyée : impossible de
  fuiter de l'info cachée par construction.

## Reste à faire (Phase 2 — frontend, prévu en Sonnet)

- Board renderer Rush Duel (3+3+1 zones, main, deck, cimetière, LP, jeton de tour).
- Drag-and-drop → émission de `duel:action move`.
- Menu contextuel par carte (flip / position / set / reveal / to deck / to hand…).
- Compteur LP manuel, boutons pièce/dé, bouton abandon.
- Persistance du `token` en localStorage + reconnexion auto au chargement.
- Import du deck depuis le format du deck builder → liste d'instances opaques.
```
