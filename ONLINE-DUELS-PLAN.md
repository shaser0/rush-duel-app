# Plan — Duels en ligne avec connexion Discord

Document de cadrage à donner à Claude Code. Objectif : permettre à deux joueurs de s'affronter en ligne, avec une identité (Discord ou autre). Ce plan explique les options, recommande un chemin, et découpe le travail en phases livrables.

> ⚠️ **À lire d'abord.** L'app actuelle est *locale, mono-utilisateur, sans serveur en ligne ni moteur de jeu*. Elle ouvre des boosters, suit une collection et construit des decks — **elle ne sait pas jouer un duel** (aucune logique de règles n'existe).
>
> **Pour l'utilisateur, ça reste UNE seule app.** Même SPA, même menu principal, avec un bouton « Duel en ligne » à côté de Ouvrir des packs / Collection / Deck builder. On n'introduit jamais une deuxième application côté utilisateur. Ce qu'on ajoute, c'est un **mode « en ligne »** au sein du même code et du même frontend.
>
> Le seul point réellement nouveau est technique : un duel temps réel a besoin d'un **point joignable par les deux joueurs**. Deux cas :

- **Auto-hébergé (ZeroTier/Tailscale, première version) :** ce point, c'est *l'app d'un des joueurs qui tourne*. Le même binaire gagne « Héberger un duel » / « Rejoindre un duel » ; l'app de l'hôte sert l'autre. **Aucun service séparé.**
- **Hébergement permanent (plus tard) :** *le même code* tourne sans surveillance sur un petit host. Toujours pas un autre produit — juste le même mode en ligne, lancé ailleurs.

---

## 1. Le changement d'architecture

| | App actuelle | Mode duel en ligne |
| --- | --- | --- |
| Exécution | binaire `pkg` sur `localhost` de chaque joueur | **serveur hébergé**, toujours allumé, public |
| Joueurs | 1 (offline) | 2+ qui se connectent au même serveur |
| Transport | HTTP local | **WebSocket** (temps réel) |
| État | fichiers JSON locaux | état autoritatif côté serveur + base |
| Identité | aucune | compte / pseudo / OAuth |

**Principe directeur à imposer à Claude Code : une seule app, un mode « en ligne » activé par configuration.** Pas de second produit, pas de second frontend. La même SPA gagne une entrée de menu « Duel en ligne ». Le même backend gagne un mode en ligne (Socket.IO + routes de duel), activé par variable d'environnement (`ONLINE_MODE`). On réutilise tout l'existant utile : `cards.json`, `image-urls.json`, le format de deck du deck builder, le shell SPA et le style.

**La seule séparation est interne, pour la sécurité.** Quand le code tourne en mode hôte/en ligne (machine joignable par d'autres), il ne doit **pas** exposer les fonctions local-only dangereuses : auto-update (télécharge **et exécute**), `exec()` du lanceur de navigateur, heartbeat d'auto-extinction. Donc :

- ranger la logique de duel en ligne dans son **propre module** (ex. `online/`) du même dépôt — organisation du code, pas un autre service ;

- **gater** les routes dangereuses derrière `if (!process.env.ONLINE_MODE)` pour qu'elles n'existent jamais sur une machine qui héberge.

Résultat : un seul code, un seul frontend, une seule expérience utilisateur ; le « serveur de duel » n'est qu'un mode de cette même app.

---

## 2. Type de duel — DÉCISION ARRÊTÉE : plateau manuel, modèle Duelingbook

> ✅ **Choix confirmé.** On part **sans automatisation** : un plateau manuel type **[Duelingbook](https://www.duelingbook.com/)**, où les joueurs déplacent les cartes à la main et appliquent les règles à l'honneur. L'automatisation pourra s'ajouter **plus tard, par couches** (voir « Chemin recommandé » et Phase 5). C'est l'Option A ci-dessous comme point de départ, avec la porte ouverte vers l'hybride. Le reste du plan est construit sur cette base.

**Référence à donner à Claude Code :** Duelingbook (duelingbook.com) est le modèle exact à viser — un serveur « bête » qui relaie l'état du plateau, aucune connaissance des règles, tout est manuel. Adapter au plateau **Rush Duel** (voir note en fin de section).

### Option A — Plateau manuel (« sandbox »), modèle Duelingbook

Le serveur ne connaît **pas** les règles. Il gère un plateau partagé : zones (main, monstres, magies/pièges, cimetière, deck, zone Maximum), position des cartes, face visible/cachée, ATK/DEF, compteur de LP. Les joueurs déplacent les cartes à la main, déclarent les attaques et ajustent les LP eux-mêmes ; les règles sont appliquées « à l'honneur ». Le serveur valide seulement la **légalité structurelle** (c'est une carte de ta zone, à toi de jouer) et diffuse l'état à l'adversaire.

- **Effort :** quelques semaines pour un MVP jouable.
- **Risque :** faible. C'est exactement ainsi que fonctionnent les simulateurs fan populaires.
- **Limite :** aucune automatisation des effets ; les joueurs doivent connaître les règles.

### Option B — Moteur de règles automatisé

Le serveur applique **toutes** les règles du Rush Duel : phases, invocations (Rush autorise plusieurs invocations Normales par tour, cartes Légende limitées, invocation Maximum…), résolution d'effets, coûts, ciblage, timing, calcul de dégâts, deck-out. **Et** il faut une description machine de l'effet de **chaque carte** (plusieurs milliers) — c'est le vrai gouffre, l'équivalent des scripts par carte d'EDOPro.

- **Effort :** plusieurs mois, plus un travail de contenu permanent (scripter chaque nouvelle carte).
- **Risque :** très élevé. Beaucoup de projets fan meurent ici.
- **Recommandation : ne pas commencer par là.**

### Chemin recommandé — Hybride incrémental, en partant de A

1. Livrer d'abord le **plateau manuel** (Option A). On a un produit jouable vite.
2. Automatiser ensuite, par couches, ce qui est **mécanique et universel** (vrai pour toutes les cartes) : pioche auto, suivi des LP sur attaque déclarée, suivi des phases/tour, mélange/pioche du deck, détection du deck-out.
3. **Seulement si l'envie et le temps suivent**, scripter l'effet de quelques cartes très jouées. Les effets restent manuels par défaut.

Ce découpage donne un MVP rapide et une voie d'évolution claire sans s'engager dans le moteur complet. **C'est ce que le plan ci-dessous suppose.**

> Note Rush Duel à transmettre : le plateau diffère du YGO classique (3 zones monstres / 3 zones magie-piège, gestion des monstres **Maximum** qui occupent plusieurs zones, cartes **Légende** limitées à une par deck, pas de chaînes complexes — le timing est plus simple). Le board renderer doit être pensé Rush, pas Master Duel.

---

## 3. Hébergement (tu as répondu « rester gratuit / minimal »)

Le multijoueur temps réel impose un serveur public toujours allumé qui accepte les WebSockets. Options réellement gratuites ou quasi :

- **Oracle Cloud — Always Free (recommandé).** VM ARM gratuite *en permanence*, toujours allumée, contrôle total. Idéale pour un petit serveur Node + WebSocket + SQLite. Contrepartie : c'est un VPS, donc un peu d'administration (déploiement, mises à jour système).
- **Fly.io — allocation gratuite.** Déploiement simple (Docker), WebSockets supportés, volume persistant pour SQLite. Très bon compromis simplicité/coût.
- **Render — free web service.** Le plus simple à déployer, mais **se met en veille après inactivité** : la première connexion est lente (cold start). Pour un duel actif le trafic le maintient éveillé ; c'est l'entrée dans le lobby qui peut traîner. Acceptable pour un prototype.
- **Cloudflare Durable Objects.** Une « room » de duel = un Durable Object : techniquement élégant et pas cher pour du temps réel, mais paradigme plus spécifique et tier gratuit limité. À considérer plus tard, pas pour le MVP.

**Implications du gratuit/minimal à accepter :** peu de joueurs simultanés, possible mise en veille (Render), administration manuelle (Oracle), pas de SLA. Très bien pour valider le concept ; on monte en gamme si ça prend.

**Base de données :** inutile de partir sur du Postgres managé. **`better-sqlite3` est déjà une dépendance du projet** — un simple fichier SQLite sur le serveur suffit largement à cette échelle (comptes, decks, historique de parties). (Au passage, ça répond à la question de l'audit « `better-sqlite3` sert-il à quelque chose ? » : ici, oui.)

**Reco synthèse :** Fly.io ou Oracle Always Free pour le serveur ; SQLite pour la persistance.

### 3 bis. Démarrer SANS hébergement : un joueur héberge, les autres rejoignent

Pour les toutes premières versions, on peut **éviter l'hébergement public** : un joueur lance le serveur de duel sur sa machine, les autres s'y connectent. Deux familles d'outils :

**A. Réseau local virtuel (ZeroTier / Tailscale / Hamachi).** Chaque participant installe le client et rejoint le même réseau virtuel ; chacun obtient une IP privée stable (ZeroTier `10.147.x.x`, Tailscale `100.x`). Les amis se connectent à `IP_hôte:3000`.

- Gratuit (ZeroTier ≤ 25 machines), privé, rien d'exposé sur Internet.
- Tailscale (basé WireGuard) est en général plus simple à installer que ZeroTier.
- Contrainte : chaque joueur installe un client VPN.

**B. Tunnel (Cloudflare Tunnel / ngrok).** L'hôte lance le serveur, le tunnel fournit une **URL publique `https`**. Les amis cliquent un lien, **sans rien installer**. Cloudflare Tunnel est gratuit ; ngrok gratuit donne une URL aléatoire à chaque session.

- Moins « privé » qu'un LAN virtuel, mais bien plus simple côté joueurs.

**⚠️ Interaction critique avec le login Discord.** L'OAuth Discord **exige une URL de redirection en `https`** (sauf `localhost`). Conséquences :

- LAN virtuel + **login Discord** : il faut du `https` sur le réseau privé (faisable via les certificats Tailscale/MagicDNS, mais c'est du bricolage).
- LAN virtuel + **mode invité/pseudo** : marche immédiatement, zéro friction → **idéal pour la 1ʳᵉ version**.
- **Tunnel Cloudflare** : URL `https` publique → **Discord OAuth fonctionne directement** et les amis n'installent rien → **meilleur compromis pour avoir Discord tôt sans payer d'hébergement**.

**Séquence d'hébergement recommandée :**

1. **ZeroTier/Tailscale + invité/pseudo** → valider le duel entre potes, zéro coût, zéro auth.
2. **Tunnel Cloudflare + Discord OAuth** → activer la vraie identité Discord sans louer de serveur.
3. **Fly.io / Oracle Always Free** → seulement quand le service doit être dispo en permanence, sans qu'un hôte lance sa machine.

---

## 4. Connexion / identité (tu as demandé « plus de détails sur ces options »)

| Option | Comment ça marche | Pour | Contre |
| --- | --- | --- | --- |
| **Invité / pseudo** | Le joueur tape un nom d'affichage, reçoit un id temporaire | Zéro friction, **zéro infra**, on peut tester les duels tout de suite | Pas d'identité persistante, usurpation facile, rien entre appareils |
| **Discord OAuth2** | Bouton « Se connecter avec Discord » → autorisation → on récupère id Discord, pseudo, avatar | Pas de mot de passe à gérer, parfait pour une communauté Discord, avatar/nom gratuits | Exige un compte Discord ; nécessite le serveur public avec une URL de callback (ne marche pas en pur localhost) ; gestion de session |
| **Google OAuth2** | Même flux qu'OAuth Discord | Audience plus large | Même complexité, moins « gaming » |
| **Lien magique e-mail** | On envoie un lien de connexion par mail | Pas de mot de passe non plus | Demande un service d'envoi d'e-mails (infra en plus) |

> ✅ **Choix confirmé : Discord + intégrations.** Cible finale = login Discord OAuth2 **plus** intégrations (inviter un ami via Discord, présence, éventuellement un bot). Mais l'identité se déploie en deux temps à cause de la contrainte `https` de l'OAuth (cf. section 3 bis).

**Chemin recommandé :**

1. **1ʳᵉ version en invité/pseudo** sur ZeroTier/Tailscale — pour construire et tester le duel *immédiatement*, sans infra d'auth ni contrainte `https`.
2. **Discord OAuth2** dès qu'on a une URL `https` — le plus simple étant un **tunnel Cloudflare** (section 3 bis) avant même de louer un serveur. Login Discord = avatar + pseudo gratuits, identité parfaite pour une communauté de jeu.
3. **Intégrations Discord** par-dessus (Phase 4) : invitation d'un ami via lien/Deep-link Discord, présence (« en duel »), et — optionnel — un bot qui annonce/lance des parties. Le bot peut même fonctionner avant l'OAuth complet (il poste juste l'adresse de la room).
4. **Couche auth modulaire** (`AuthProvider`) pour pouvoir ajouter Google/e-mail plus tard si tu veux toucher hors-Discord, sans tout réécrire.

---

## 5. Sécurité — non négociable côté serveur public

Mettre l'app en ligne fait exploser la surface d'attaque. À imposer à Claude Code dès la Phase 1 :

- **Ne jamais faire confiance au client.** Même en mode sandbox manuel, le serveur reste autoritatif sur l'appartenance des zones : un joueur ne peut agir que sur **ses** cartes, dans **sa** room. Valider chaque message WebSocket (type, schéma, droits).
- **Rate-limiting** des messages et des connexions ; taille de payload bornée.
- Reprendre les points de l'`AUDIT-BRIEF.md` (CORS, validation d'entrées, écritures atomiques) — ils deviennent **critiques** une fois en ligne.
- Sessions signées (cookie httpOnly + JWT ou session serveur), secrets OAuth **hors du dépôt** (variables d'environnement).
- Anti-triche minimal : le serveur tient l'état du deck/pioche, le client ne voit que ce qu'il doit voir (pas la main adverse, pas l'ordre du deck).

---

## 6. Stack technique recommandée à Claude Code

- **Temps réel :** Socket.IO (rooms intégrées = une room par duel, reconnexion gérée) — plus rapide à construire que `ws` brut.
- **Serveur :** Node + Express (déjà maîtrisé dans le projet) pour le HTTP/OAuth, Socket.IO pour le temps réel.
- **État :** autoritatif en mémoire par room + snapshot périodique ; SQLite (`better-sqlite3`) pour comptes, decks, historique.
- **Front :** étendre la SPA existante avec un mode « Duel en ligne » : un *board renderer* Rush Duel, du glisser-déposer de cartes, synchronisation par événements socket. Réutiliser les images/données de cartes de l'app.

---

## 7. Plan par phases (chaque phase est livrable et testable)

**Phase 0 — Décisions & échafaudage**
Créer `online/` (serveur de duel séparé du binaire local). Définir le format de deck partagé (export depuis le deck builder existant → import en ligne). **Pas d'hébergement à ce stade** : on tournera en local puis sur ZeroTier/Tailscale (section 3 bis).
*Livrable : squelette de serveur qui répond « hello » en local. Test : accessible depuis un autre onglet.*

**Phase 1 — Plomberie temps réel (sur réseau local virtuel)**
Serveur Socket.IO : créer/rejoindre une room via un **code partageable**, présence, chat de room. Identité en **mode invité/pseudo**. L'hôte lance le serveur ; les amis rejoignent via **ZeroTier/Tailscale**.
*Livrable : deux machines distantes rejoignent la même room via le réseau virtuel et échangent des messages. Test : deux joueurs sur deux PC, se voir et chatter.*

**Phase 2 — Plateau de duel manuel (MVP)**
Layout du plateau Rush Duel (zones monstres/magie-piège, main, cimetière, deck, zone Maximum, LP). Charger un deck, mélanger, piocher, glisser les cartes entre zones, retourner/changer de position, compteur de LP manuel, dé/pièce, jeton de tour. Serveur autoritatif sur l'appartenance, diffusion à l'adversaire.
*Livrable : **un duel complet jouable à deux** (règles à l'honneur). Test : jouer une partie de bout en bout à deux.*

**Phase 3 — Authentification Discord** *(nécessite une URL `https` → tunnel Cloudflare, cf. section 3 bis)*
Discord OAuth2, sessions, persistance des comptes + decks côté serveur (SQLite), liaison invité → compte. Couche `AuthProvider` modulaire. C'est ici qu'on passe du LAN virtuel au **tunnel Cloudflare** (URL `https` publique) pour que l'OAuth fonctionne sans louer de serveur.
*Livrable : « Se connecter avec Discord » fonctionnel, deck sauvegardé sur le compte. Test : login, retrouver son deck sur un autre appareil.*

**Phase 4 — Matchmaking & finitions**
Lobby / file d'attente, invitation d'un ami (lien profond Discord), reconnexion après coupure, spectateurs, anti-triche de base (le serveur valide l'appartenance des zones), historique de parties.
*Livrable : trouver/inviter un adversaire sans partager un code à la main.*

**Phase 5 (optionnelle) — Automatisation hybride**
Par couches : pioche auto, suivi des phases, LP sur attaque déclarée, détection deck-out. Plus tard seulement : scripting d'effet pour quelques cartes très jouées.
*Livrable : confort de jeu accru, sans bloquer sur le moteur complet.*

---

## 8. Ce qu'il faut demander explicitement à Claude Code

> 🌿 **Tout le travail se fait sur la branche `feature/online-duels`** (déjà créée depuis `main`). Première étape côté Claude Code : `git checkout feature/online-duels`, puis y faire tous les commits. Ne jamais committer directement sur `main`. Ouvrir une PR vers `main` quand une phase est validée.

- « Reste **une seule app** : ajoute un mode « Duel en ligne » au frontend et au backend existants, pas un second produit. Range la logique en ligne dans un module `online/` du **même dépôt**, activé par `ONLINE_MODE`. Suis ONLINE-DUELS-PLAN.md, commence par la Phase 1, et ne passe à la suite qu'une fois la phase testée à deux. »
- « Gate les routes local-only dangereuses (auto-update, `exec()` du lanceur, heartbeat) derrière `if (!ONLINE_MODE)` pour qu'elles n'existent jamais quand une machine héberge. »
- « Le serveur est autoritatif : un client ne peut agir que sur ses propres cartes et sa propre room. Valide chaque message socket. »
- « Réutilise les données de cartes et le format de deck existants ; ne réutilise pas l'auto-update, le `exec()` du lanceur, ni le heartbeat. »
- « Mets les secrets OAuth en variables d'environnement, jamais dans le dépôt. »
- À chaque phase : « montre-moi le plan de déploiement et un test à deux joueurs avant de continuer. »

---

## 9. Décisions encore ouvertes (à trancher au fil de l'eau)

- Hébergeur final : Fly.io (simple) vs Oracle Always Free (gratuit permanent, plus d'admin).
- Discord seul, ou ajouter Google pour élargir l'audience hors-Discord.
- Jusqu'où automatiser en Phase 5 — à décider une fois le plateau manuel éprouvé.
