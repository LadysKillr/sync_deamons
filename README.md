# sync_deamons — Paseo daemon sync plugin

[Français](README.fr.md)

A [Paseo](https://github.com/getpaseo/paseo) plugin that keeps several Paseo daemons configured the same way.
Sync is **encrypted with a password**, runs **in both directions**, and is organised in **sync groups** (e.g. "work", "personal", "games"), each with its own password and its own scope.

## What gets synced

| Category | Details | Item key |
|---|---|---|
| Plugins | installed / removed, source (git, npm, registry), **exact version** (commit or npm version), enabled / disabled | `plugin/<id>` |
| Plugin settings | `<PASEO_HOME>/plugin-settings/<plugin>/*.json` for the selected plugins, followed by a plugin reload | `settings/<plugin>/<id>` |
| Daemon config | chosen `config.json` paths, by default `agents` (providers, profiles…) and `features` | `config/<path>` |
| Files | chosen files or folders (`~/.claude/skills`, `~/.claude/CLAUDE.md`, …) | `file/<set>/<path>` |

Never synced: `daemon.*` (listen address, daemon password, relay), `plugins`, `version`, `app`, plugins installed from a local folder, the Sync plugin itself, and agent conversations.

## Groups

- A group = a name + a password + a **scope** (what is synced). The scope is shared by the whole group.
- Example: "work" = only `paseo-kanban` and `annotations` + the `agents` config; "games" = only `file-preview` + a `~/game-notes` folder.
- A machine can belong to several groups. When two groups cover the same item, **the first group in the local list** manages it (reorder with ↑ ↓).
- Each machine has a role in each group: *send and receive* (default), *receive only* (follows the group), or *send only* (acts as the reference).

## Getting started

1. Install the plugin on each daemon:
   ```bash
   paseo plugin install github:LadysKillr/sync_deamons
   ```
2. On the first machine: sidebar → **Sync** → *Create a group* (name + password).
3. Click *Invite* and copy the `psync1.…` code. It contains the group name and member addresses, never the password.
4. On every other machine: *Join a group* → paste the code → type the same password.

Other members are discovered automatically: one known address is enough.

Machines must be able to reach each other over HTTP on port **6780** (configurable). The advertised address defaults to the machine's Tailscale IP (100.64.0.0/10), or else its first IPv4 address. You can set it explicitly under "This machine".

## How it works

- **One replica per group**: the latest value of each item, timestamped with a hybrid logical clock. The most recent write wins (LWW). Deletions are tombstones kept for 30 days.
- **Change detection**: Sync watches everything it syncs on disk (`config.json`, `plugins/sources.json`, `plugin-settings/**` and the chosen file sets) and starts a pass about 2 s after a local change. Bursts of writes are coalesced, and Sync ignores its own writes while it applies remote changes. A **fallback pass runs every 10 minutes** (configurable) to catch members coming back online, retry failures and recover any missed event. There is also a **Sync now** button.
- **Each pass** (on a local change, right after receiving changes, on the fallback timer or on demand):
  1. read local state and publish what changed on this machine;
  2. run a `pull`/`push` exchange with each member (deltas only);
  3. apply here what changed elsewhere.
- **After applying a change**, the state actually obtained becomes the new local reference. So the side effects of a failure (for example a plugin removed but not reinstalled) are never published as a user decision. Failures are retried with backoff (30 s, 1 min, 2 min, … up to 1 h) and shown in the UI.
- **A joining machine** waits for its first contact with the group, adopts the group's state, then contributes whatever extra items it has.
- **Registry plugins** are first installed through the registry, so the listing link is kept. If the registry's reviewed revision doesn't match the group's, the plugin is reinstalled from its direct source at the exact revision. Its settings are backed up around the reinstall, because `paseo plugin remove` deletes them.
- **Plugin and config changes** go through the `paseo` CLI (`plugin install/update/enable/disable/remove/reload`, `daemon config set/unset`), which must be on the daemon's `PATH`.

## Security

- **Key derivation**: `scrypt(password, salt = sha256(group name))` with N = 2^15, then HKDF subkeys.
- **Messages**:
  - encrypted and authenticated with AES-256-GCM;
  - the AAD binds each message to its direction (request/response), to the group and, for a response, to the request nonce;
  - 15 minutes of clock skew are tolerated;
  - only an opaque group identifier travels in clear text, and unknown callers get a 404.
- **Storage**: the password is never stored. The derived key lives in `<PASEO_HOME>/plugin-data/sync/state.json` with 0600 permissions.
- **A group password gives control over every machine in the group**: installing plugins means running code, and the selected files can be written. Treat it like an admin password.
- **Changing a password** means recreating the group on every machine.

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"      # then `paseo plugin reload sync` after each change
paseo plugin logs sync
```

Layout: `shared/` holds the contracts and model, `server/` the daemon side (crypto, replica, engine, collectors, HTTP transport) and `client/` the React Native UI. Tests are in `test/`.

Requires Paseo >= 0.15.0.
