# sync_deamons — plugin Paseo de synchronisation entre daemons

[English](README.md)

Plugin Paseo de synchronisation **chiffrée, bidirectionnelle, par groupes** entre daemons.

## Ce qui est synchronisé

| Catégorie | Détail | Clé |
|---|---|---|
| Plugins | installé / retiré, source (git, npm, registre), **version exacte** (commit ou version npm), activé / désactivé | `plugin/<id>` |
| Réglages des plugins | `~/.paseo/plugin-settings/<plugin>/*.json` des plugins retenus, puis rechargement du plugin | `settings/<plugin>/<id>` |
| Config du daemon | chemins de `config.json` au choix, par défaut `agents` (fournisseurs, profils…) et `features` | `config/<chemin>` |
| Fichiers | dossiers ou fichiers au choix (`~/.claude/skills`, `~/.claude/CLAUDE.md`…) | `file/<ensemble>/<chemin>` |

Jamais synchronisé : `daemon.*` (écoute, mot de passe, relais), `plugins`, `version`, `app`, les plugins installés depuis un dossier local, Sync lui-même, les conversations des agents.

## Groupes

- Un groupe = un nom + un mot de passe + une **portée** (ce qui est synchronisé). La portée est partagée par tout le groupe.
- Exemple : « travail » = seulement `paseo-kanban`, `annotations` + config `agents` ; « jeux » = seulement `file-preview` + dossier `~/jeux-notes`.
- Une machine peut être dans plusieurs groupes. Si deux groupes couvrent le même élément, **le premier de la liste locale** le gère (flèches ↑ ↓).
- Rôle par machine : *envoie et reçoit* (défaut), *reçoit seulement*, *envoie seulement*.

## Mise en route

1. Installer le plugin sur chaque daemon : `paseo plugin install github:LadysKillr/sync_deamons`.
2. Sur la première machine : barre latérale → **Sync** → *Créer un groupe* (nom + mot de passe).
3. *Inviter* → copier le code `psync1.…`.
4. Sur chaque autre machine : *Rejoindre un groupe* → coller le code → même mot de passe.

Les machines doivent se joindre en HTTP sur le port 6780 (réglable). Par défaut l'adresse annoncée est l'IP Tailscale (100.64.0.0/10), sinon la première IPv4 ; elle peut être fixée dans « Cette machine ».

## Fonctionnement

- **Réplique** par groupe : la dernière valeur de chaque élément, datée par une horloge hybride (LWW, la plus récente gagne ; suppression = pierre tombale gardée 30 jours).
- Chaque passage (30 s par défaut, et aussitôt après une réception) : relevé local → publication de ce qui a changé ici → échange `pull`/`push` (deltas seulement) avec chaque membre → application ici de ce qui a changé ailleurs.
- Après une application, l'état **réellement obtenu** devient la référence : l'effet d'un échec (plugin retiré mais pas réinstallé) n'est jamais publié comme un choix. Les échecs sont réessayés (30 s, 1 min, 2 min… 1 h) et affichés.
- Une machine qui **rejoint** attend un premier contact, adopte l'état du groupe, puis apporte ce qu'elle a en plus.
- Plugins du registre : réinstallés par le registre (fiche conservée) ; si sa révision revue ne correspond pas, réinstallation depuis la source directe à la révision exacte. Les réglages sont sauvegardés autour d'une réinstallation (`plugin remove` les efface).

## Sécurité

- Clé : `scrypt(mot de passe, sel = sha256(nom du groupe))`, N = 2^15 ; sous-clés HKDF.
- Messages : AES-256-GCM, AAD liée au sens (requête/réponse), au groupe et au nonce de la requête ; écart d'horloge toléré 15 min. Seul un identifiant opaque du groupe circule en clair. Un inconnu reçoit 404.
- Le mot de passe n'est jamais stocké ; la clé dérivée l'est dans `plugin-data/sync/state.json` (0600).
- **Le mot de passe d'un groupe donne le contrôle des machines du groupe** (installation de plugins = exécution de code, écriture des fichiers choisis). À traiter comme un mot de passe administrateur.
- Changer de mot de passe = recréer le groupe sur chaque machine.

## Développement

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"      # puis paseo plugin reload sync après modification
paseo plugin logs sync
```
