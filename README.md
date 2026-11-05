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
| Files | chosen files or folders, with presets: Claude Code skills, sub-agents, commands and `CLAUDE.md`; Codex `AGENTS.md` and prompts | `file/<set>/<path>` |
| JSON keys | one key of a JSON file, the rest of the file untouched; presets: Claude Code MCP servers (`~/.claude.json` → `mcpServers`), permissions (`~/.claude/settings.json` → `permissions`) | `json/<id>` |
| Schedules | Paseo schedules, definition only (prompt, cadence, target, limits, active/paused). Every machine of the group runs them | `schedule/<id>` |
| Sync itself | optional: Sync updates itself on every machine | `self/sync` |

Never synced: `daemon.*` (listen address, daemon password, relay), `plugins`, `version`, `app`, plugins installed from a local folder, and agent conversations.

## Groups

- A group = a name + a password + a **scope** (what is synced). The scope is shared by the whole group.
- Example: "work" = only `paseo-kanban` and `annotations` + the `agents` config; "games" = only `file-preview` + a `~/game-notes` folder.
- A machine can belong to several groups. When two groups cover the same item, **the first group in the local list** manages it (reorder with ↑ ↓).
- Each machine has a role in each group: *send and receive* (default), *receive only* (follows the group), or *send only* (acts as the reference).
- **Per-machine settings** ("This machine", local to that machine):
  - **exclusions**: an item or prefix that is neither applied nor published there (`plugin/kanban` also covers its settings, `file/skills` a whole file set);
  - **approval mode**: incoming changes wait for *Apply* / *Reject* on that machine. A decision covers one version; a newer version asks again.

## Getting started

1. Install the plugin on each daemon:
   ```bash
   paseo plugin install github:LadysKillr/sync_deamons
   ```
2. On the first machine: sidebar → **Sync** → *Create a group* (name + password).
3. Click *Invite* and copy the `psync1.…` code. It contains the group name and member addresses, never the password.
4. On every other machine: *Join a group* → paste the code → type the same password.

Other members are discovered automatically: one known address is enough. Turn on **"Update Sync itself on every machine"** in the group's scope so you never have to update Sync by hand again.

Machines talk directly over HTTP on port **6780** (configurable). By default (`auto`) Sync listens on the machine's Tailscale address (100.64.0.0/10) when there is one, otherwise on all interfaces, and advertises that address. You can set both explicitly under "This machine".

## How it works

- **One replica per group**: the latest value of each item, timestamped with a hybrid logical clock. The most recent write wins (LWW). Deletions are tombstones kept for 30 days.
- **Change detection**: Sync watches everything it syncs on disk (`config.json`, `plugins/sources.json`, `plugin-settings/**`, file sets, JSON files, the schedules folder) and starts a pass about 2 s after a local change. Bursts are coalesced and Sync ignores its own writes. A **fallback pass every 10 minutes** (configurable) catches members coming back online and retries failures. There is also a **Sync now** button.
- **Each pass**: read local state and publish what changed here → `pull`/`push` exchange with each member (deltas only) → fetch missing file contents → apply here what changed elsewhere.
- **After applying a change**, the state actually obtained becomes the new local reference: the side effects of a failure (a plugin removed but not reinstalled) are never published as a user decision. Failures are retried with backoff (30 s, 1 min, 2 min… up to 1 h).
- **Uncertain items**: a file read while being written, grown past the 4 MB limit, or a JSON file that doesn't parse is "uncertain" for that pass: no deletion is published for it.
- **A joining machine** adopts the group's state, then contributes the items it has in addition.
- **Coming back after a long absence**: each machine records up to when it has forgotten tombstones and refuses unknown items older than that. A machine that was off for more than 30 days therefore can't reinstall items deleted in the meantime.
- **File contents** are stored by hash in `plugin-data/sync/blobs/`, outside `state.json`, and transferred once to the machines that lack them (hash verified on receipt).
- **Registry plugins** are installed through the registry when its reviewed revision matches the group's; otherwise from their direct source at the exact revision. Settings are backed up around a reinstall (`paseo plugin remove` deletes them).
- **Plugin and config changes** go through the `paseo` CLI, which must be on the daemon's `PATH`.

## History, conflicts, updates

- **History**: each item keeps its last 5 versions; any of them can be restored for the whole group ("Revert to this version everywhere").
- **Conflicts**: each version records the version it replaced, so two changes are flagged as a conflict only when neither was written on top of the other. Every machine sees the conflict; the losing version can be restored from the machine that made it.
- **Sync self-update** (group option): a machine running an older Sync updates itself to the group's version in a detached process after its pass (the update restarts Sync). A newer version becomes the group's reference. Downgrades are refused.
- **Plugin updates** (group option): one leader machine (smallest id among recently seen publishing members) checks every 6 h with `paseo plugin update --check` and installs updates for the group's plugins; change detection publishes them and the group follows.

## Status and alerts

Each machine publishes a small report to its group: Sync version, items still to apply, failures with their message, exclusions, changes awaiting approval, conflicts and a digest of its replica. The Sync screen shows one line per machine and, per item, where it is applied, pending, awaiting approval, excluded or failed (e.g. `workspace-spaces · 6/6`).

A **red badge** next to "Sync" in the sidebar counts the problems (failure on any machine, conflict, change awaiting approval, removal from a group, update check error) and a notification appears for each new one.

## Security

- **Key derivation**: `scrypt(password, salt = sha256(group name))` with N = 2^15, then HKDF subkeys.
- **Messages**: encrypted and authenticated with AES-256-GCM; the AAD binds each message to its direction, the group and, for a response, the request nonce; 15 minutes of clock skew tolerated; only an opaque group identifier travels in clear text; unknown callers get a 404.
- **Storage**: the password is never stored. The derived key and the machine's X25519 key pair live in `<PASEO_HOME>/plugin-data/sync/state.json` (0600).
- **Changing the password / removing machines**: the new key is wrapped for each kept machine with its X25519 public key (ECIES + AES-256-GCM), so a removed machine cannot read it even with the old password. The notice is sent right away; for 30 days the old key is accepted only to hand the notice to machines that were offline, or to tell a removed machine it has been removed (its group is then disabled).
- **A group password gives control over every machine in the group**: installing plugins means running code, and the selected files, JSON keys and schedules are written there. Treat it like an admin password; use approval mode on machines that need it.

## Compatibility

Machines on 0.1.x and 0.2.0 keep syncing plugins, settings and config together. The new features (reports, exclusions, conflicts, password change, file contents by hash, JSON keys, schedules, self-update) need every machine of the group on 0.2.0. Updating to 0.2.0 switches a machine that still listened on the old `0.0.0.0` default to `auto` (Tailscale when present).

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"      # then `paseo plugin reload sync` after each change
paseo plugin logs sync
```

Layout: `shared/` holds the contracts and model, `server/` the daemon side (crypto, replica, engine, collectors, transport, blobs, rekey, self-update, plugin updates, watcher) and `client/` the React Native UI. Tests are in `test/`.

Requires Paseo >= 0.15.0.

## License

[MIT](LICENSE) © 2026 LadysKillr. Free to use, modify and redistribute, keeping the copyright notice.
