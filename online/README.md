# Online Duel — Phase 1 (rooms + guest identity)

> **Build note :** online mode runs via `npm start`, NOT via the packaged `.exe`.  
> The pkg binary is for local single-player use only — it does not include Socket.IO.

---

## Lancement (hôte)

```bash
# Windows PowerShell
$env:ONLINE_MODE=1 ; npm start

# Windows CMD
set ONLINE_MODE=1 && npm start

# Linux / macOS / Git Bash
ONLINE_MODE=1 npm start
```

Le serveur écoute sur **`0.0.0.0:3000`** (toutes interfaces).  
Sans `ONLINE_MODE`, il écoute sur `127.0.0.1` uniquement et les routes dangereuses  
(`/api/update/*`, `/api/data/*`, heartbeat, `exec()`) sont actives normalement.

---

## Rejoindre une room (adversaire)

1. Installe **ZeroTier** (<https://www.zerotier.com/download/>) ou **Tailscale** (<https://tailscale.com/download>).
2. Rejoins le même réseau virtuel que l'hôte.
3. Récupère l'IP ZeroTier/Tailscale de l'hôte :
   - ZeroTier : `zerotier-cli listnetworks` → colonne *Managed IPs* (`10.147.x.x`)
   - Tailscale : `tailscale ip -4` (→ `100.x.x.x`)
4. Ouvre dans ton navigateur :

```
http://<IP-de-l-hôte>:3000
```

5. Clique sur **Duel en ligne**, entre ton pseudo et colle le code de room communiqué par l'hôte.

---

## Critères d'acceptation (test à deux machines)

| # | Critère | Comment vérifier |
|---|---------|-----------------|
| 1 | L'hôte crée une room et obtient un code | Bouton « Héberger un duel » |
| 2 | L'adversaire rejoint via le code | Bouton « Rejoindre » depuis l'IP ZeroTier |
| 3 | Les deux se voient dans la présence | Bandeau « Joueurs » dans la room |
| 4 | Le chat est temps réel dans les deux sens | Envoyer un message de chaque côté |
| 5 | Si l'adversaire ferme l'onglet, l'hôte le voit partir | Message système + présence mise à jour |
| 6 | Sans ONLINE_MODE, `/api/update/check` répond (routes locales actives) | `curl http://localhost:3000/api/update/check` |
| 7 | Un message vers une room dont on n'est pas membre est rejeté | Tenter `socket.emit('chat:message',…)` sans join |

---

## Architecture du module

```
online/
  index.js      ← Socket.IO mount + event handlers (autoritatif)
  rooms.js      ← État des rooms en mémoire (Map code → room)
  validate.js   ← Schémas de validation par type de message
  rateLimit.js  ← Rate-limiter sliding-window (chat + join)
  README.md     ← Ce fichier
```

**Branchement dans `server.js` :**

```js
// Partagé avec Express
const httpServer = http.createServer(app);

// Online uniquement
if (process.env.ONLINE_MODE) {
  require('./online').mount(httpServer);
}

// Bind 0.0.0.0 en mode online, 127.0.0.1 en local
httpServer.listen(PORT, ONLINE_MODE ? '0.0.0.0' : '127.0.0.1', ...);
```

---

## Gates de sécurité

Quand `ONLINE_MODE` est défini, les routes suivantes **n'existent pas** :

- `GET /api/update/check` et `POST /api/update/apply` (télécharge & exécute un binaire)
- `GET /api/data/check` et `POST /api/data/apply`
- `POST /api/heartbeat` (auto-extinction du processus)
- `openBrowser()` / `exec()` (lance un navigateur)

---

## Hors périmètre Phase 1

- Plateau, zones, cartes, glisser-déposer → Phase 2
- Auth Discord, sessions, persistance → Phase 3 (nécessite HTTPS via tunnel Cloudflare)
- Matchmaking, reconnexion avancée, spectateurs → Phase 4
