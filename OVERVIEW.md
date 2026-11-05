Sync keeps several Paseo daemons configured the same way. It copies installed plugins at their exact version, their enabled state and their settings, plus agent and provider configuration from `config.json` and any files or folders you choose (skills, `CLAUDE.md`, and so on). Changes travel in both directions: install, update, disable or remove a plugin on one machine and the other machines follow.

## Groups

Machines are organised in sync groups, for example "work", "personal" or "games". Each group has its own password and its own scope, so a work group can share different plugins from a games group. A machine can belong to several groups. When two groups cover the same item, the group listed first on that machine manages it. Within a group, each machine can send and receive, receive only (it follows the group), or send only (it acts as the reference).

## How it works

Each daemon runs a small HTTP endpoint (port 6780 by default). Machines exchange their state directly, so they must be able to reach each other, for example over Tailscale, a LAN or a VPN. The group password goes through scrypt to derive a key, and every message is encrypted and authenticated with AES-256-GCM. Only an opaque group identifier is sent in clear text. The password itself is never stored; the derived key is kept in `plugin-data/sync/state.json` with 0600 permissions.

To add a machine, create the group on the first machine, then on the next one choose "Join", paste the invite code (or the address of any member) and type the same password. Other members are discovered automatically. A joining machine adopts the group's state, and anything extra it has is added to the group.

## Limits

- Anyone who has a group's password can install plugins and write the selected files on every machine in the group. Treat it like an administrator password.
- Plugins installed from a local folder are not synced, and neither is Sync itself.
- The daemon's listen address, password, relay settings and identity are never synced.
- Plugin installs and updates go through the `paseo` CLI, which must be on the daemon's `PATH`.
- Agent conversations and running sessions are not copied.
