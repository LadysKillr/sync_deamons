# sync_deamons — plugin Paseo de synchronisation entre daemons

[English](README.md)

Plugin [Paseo](https://github.com/getpaseo/paseo) qui garde plusieurs daemons Paseo configurés de la même façon.
La synchronisation est **chiffrée par mot de passe**, **dans les deux sens**, et organisée en **groupes** (« travail », « perso », « jeux »…), chacun avec son mot de passe et sa portée.

## Ce qui est synchronisé

| Catégorie | Détail | Clé |
|---|---|---|
| Plugins | installé / retiré, source (git, npm, registre), **version exacte** (commit ou version npm), activé / désactivé | `plugin/<id>` |
| Réglages des plugins | `<PASEO_HOME>/plugin-settings/<plugin>/*.json` des plugins retenus, puis rechargement du plugin | `settings/<plugin>/<id>` |
| Config du daemon | chemins de `config.json` au choix, par défaut `agents` (fournisseurs, profils…) et `features` | `config/<chemin>` |
| Fichiers | fichiers ou dossiers au choix, avec préréglages : skills, sous-agents, commandes et `CLAUDE.md` de Claude Code ; `AGENTS.md` et prompts de Codex | `file/<ensemble>/<chemin>` |
| Clés JSON | une clé d'un fichier JSON, le reste du fichier intact ; préréglages : serveurs MCP de Claude Code (`~/.claude.json` → `mcpServers`), permissions (`~/.claude/settings.json` → `permissions`) | `json/<id>` |
| Planifications | planifications Paseo, définition seulement (prompt, cadence, cible, limites, active/en pause). Chaque machine du groupe les exécute | `schedule/<id>` |
| Sync lui-même | en option : Sync se met à jour sur toutes les machines | `self/sync` |

Jamais synchronisé : `daemon.*` (écoute, mot de passe, relais), `plugins`, `version`, `app`, les plugins installés depuis un dossier local, les conversations des agents.

## Groupes

- Un groupe = un nom + un mot de passe + une **portée** (ce qui est synchronisé). La portée est partagée par tout le groupe.
- Exemple : « travail » = seulement `paseo-kanban`, `annotations` + config `agents` ; « jeux » = seulement `file-preview` + dossier `~/jeux-notes`.
- Une machine peut être dans plusieurs groupes. Si deux groupes couvrent le même élément, **le premier de la liste locale** le gère (flèches ↑ ↓).
- Rôle par machine : *envoie et reçoit* (défaut), *reçoit seulement*, *envoie seulement*.
- **Réglages propres à une machine** (« Cette machine ») :
  - **exclusions** : un élément ou un préfixe ni appliqué ni publié depuis cette machine (`plugin/kanban` emporte ses réglages, `file/skills` tout un ensemble) ;
  - **mode approbation** : les changements reçus attendent *Appliquer* / *Refuser* sur cette machine. Une décision vaut pour une version ; une version plus récente redemande.

## Mise en route

1. Installer le plugin sur chaque daemon : `paseo plugin install github:LadysKillr/sync_deamons`.
2. Sur la première machine : barre latérale → **Sync** → *Créer un groupe* (nom + mot de passe).
3. *Inviter* → copier le code `psync1.…` (nom du groupe et adresses, jamais le mot de passe).
4. Sur chaque autre machine : *Rejoindre un groupe* → coller le code → même mot de passe.

Les autres machines sont trouvées automatiquement. Activez **« Mettre à jour Sync lui-même sur toutes les machines »** dans la portée du groupe : plus besoin de mettre Sync à jour à la main.

Les machines se parlent directement en HTTP sur le port **6780** (réglable). Par défaut (`auto`), Sync écoute sur l'adresse Tailscale de la machine (100.64.0.0/10) s'il y en a une, sinon sur toutes les interfaces, et annonce cette adresse. Les deux se règlent dans « Cette machine ».

## Fonctionnement

- **Réplique** par groupe : la dernière valeur de chaque élément, datée par une horloge hybride (la plus récente gagne ; suppression = trace gardée 30 jours).
- **Détection des changements** : Sync surveille sur disque tout ce qu'il synchronise et lance un passage environ 2 s après un changement local (rafales regroupées, ses propres écritures ignorées). **Passage de secours toutes les 10 min** (réglable) pour les membres revenus en ligne et les nouvelles tentatives. Bouton **Synchroniser maintenant**.
- **Chaque passage** : relevé local et publication de ce qui a changé ici → échange `pull`/`push` (différences seulement) → récupération des contenus de fichiers manquants → application de ce qui a changé ailleurs.
- **Après une application**, l'état réellement obtenu devient la référence : l'effet d'un échec n'est jamais publié comme un choix. Nouvelles tentatives : 30 s, 1 min, 2 min… 1 h ; après 5 échecs à la même version (par exemple une installation que la machine refuse à chaque fois), Sync arrête de relancer jusqu'à une nouvelle version ou un clic sur *Réessayer*.
- **Démarrage** : Sync attend que le daemon réponde avant son premier passage. Pendant que le daemon démarre ou redémarre (« Start with: paseo daemon start »), le passage est refait 15 s plus tard, sans erreur ni pastille.
- **Éléments incertains** : un fichier lu pendant une écriture, devenu trop gros (4 Mo) ou un JSON illisible n'entraîne aucune suppression ce passage-là.
- **Une machine qui rejoint** adopte l'état du groupe, puis apporte ce qu'elle a en plus.
- **Retour après une longue absence** : chaque machine retient jusqu'où elle a oublié des traces de suppression et refuse un élément inconnu plus ancien. Une machine éteinte plus de 30 jours ne peut donc pas réinstaller ce qui a été supprimé entre-temps.
- **Contenus des fichiers** rangés par empreinte dans `plugin-data/sync/blobs/`, hors de `state.json`, transmis une seule fois aux machines qui ne les ont pas (empreinte vérifiée).
- **Plugins du registre** installés par le registre si sa révision revue est la bonne, sinon depuis la source directe à la révision exacte ; réglages sauvegardés autour d'une réinstallation.
- **Plugins et config** passent par le CLI `paseo`, qui doit être dans le `PATH` du daemon.

## Historique, conflits, mises à jour

- **Historique** : chaque élément garde ses 5 dernières versions ; chacune peut être rétablie pour tout le groupe.
- **Conflits** : chaque version note celle qu'elle a remplacée ; deux changements ne sont en conflit que si aucun n'a été écrit en connaissant l'autre. Toutes les machines voient le conflit ; la version perdante se rétablit depuis la machine qui l'a écrite.
- **Mise à jour de Sync** (option du groupe) : une machine en retard se met à jour dans un processus détaché après son passage (la mise à jour redémarre Sync). Une version plus récente devient la référence ; jamais de retour en arrière.
- **Mises à jour des plugins** (option du groupe) : une machine meneuse (plus petit identifiant parmi les membres récents qui publient) vérifie toutes les 6 h avec `paseo plugin update --check` et installe ; le groupe suit.

## État et alertes

Chaque machine publie un compte rendu (version de Sync, éléments en attente, échecs avec leur message, exclusions, changements à approuver, conflits, empreinte de sa réplique). L'écran affiche une ligne par machine et, par élément, où il est appliqué, en cours, à approuver, exclu ou en échec (par exemple `workspace-spaces · 6/6`).

Une **pastille rouge** à côté de « Sync » dans la barre latérale compte les problèmes (échec sur une machine, conflit, changement à approuver, retrait d'un groupe, erreur de vérification des mises à jour), et une notification apparaît pour chaque nouveau.

## Sécurité

- Clé : `scrypt(mot de passe, sel = sha256(nom du groupe))`, N = 2^15 ; sous-clés HKDF.
- Messages : AES-256-GCM, AAD liée au sens, au groupe et au nonce de la requête ; écart d'horloge toléré 15 min. Seul un identifiant opaque du groupe circule en clair ; un inconnu reçoit 404.
- Le mot de passe n'est jamais stocké ; la clé dérivée et la paire de clés X25519 de la machine sont dans `plugin-data/sync/state.json` (0600).
- **Changer le mot de passe / retirer des machines** : la nouvelle clé est chiffrée pour chaque machine gardée avec sa clé publique X25519 ; une machine retirée ne peut pas la lire, même avec l'ancien mot de passe. L'avis part aussitôt ; pendant 30 jours, l'ancienne clé n'est acceptée que pour le remettre aux machines éteintes, ou pour dire à une machine retirée qu'elle l'est (son groupe se désactive).
- **Le mot de passe d'un groupe donne le contrôle des machines du groupe** (installation de plugins = exécution de code ; fichiers, clés JSON et planifications écrits). À traiter comme un mot de passe administrateur ; mode approbation sur les machines sensibles.

## Compatibilité

Des machines en 0.1.x et en 0.2.0 continuent de synchroniser plugins, réglages et config ensemble. Les nouveautés (comptes rendus, exclusions, conflits, changement de mot de passe, contenus par empreinte, clés JSON, planifications, mise à jour de Sync) demandent tout le groupe en 0.2.0. Le passage à 0.2.0 fait passer une machine qui écoutait sur l'ancien défaut `0.0.0.0` en `auto` (Tailscale s'il y en a un).

## Développement

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"      # puis paseo plugin reload sync après modification
paseo plugin logs sync
```

## Licence

[MIT](LICENSE) © 2026 LadysKillr. Libre d'utilisation, de modification et de redistribution, en gardant la mention de copyright.
