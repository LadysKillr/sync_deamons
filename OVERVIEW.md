Sync keeps several Paseo daemons configured the same way. It copies installed plugins at their exact version, their enabled state and their settings, agent and provider configuration from `config.json`, chosen files and folders (Claude Code skills, sub-agents, `CLAUDE.md`, Codex prompts), single keys of JSON files such as Claude Code MCP servers, and Paseo schedules. Changes travel in both directions: install, update, disable or remove a plugin on one machine and the other machines follow.

## Groups

Machines are organised in sync groups, for example "work", "personal" or "games". Each group has its own password and its own scope, so a work group can share different plugins from a games group. A machine can belong to several groups. When two groups cover the same item, the group listed first on that machine manages it. Within a group, each machine can send and receive, receive only, or send only. A machine can also exclude items for itself, or require approval before applying incoming changes.

## How it works

Each daemon runs a small HTTP endpoint (port 6780). By default it listens on the machine's Tailscale address when there is one. Machines exchange their state directly, so they must be able to reach each other, for example over Tailscale, a LAN or a VPN. Local changes are detected on disk and sent within a few seconds; a fallback pass runs every 10 minutes. The group password goes through scrypt, and every message is encrypted and authenticated with AES-256-GCM. The password itself is never stored.

To add a machine, create the group on the first machine, then on the next one choose "Join", paste the invite code and type the same password. Other members are discovered automatically.

## Status, history and updates

The Sync screen shows, for every item, on which machines it is applied, pending, awaiting approval, excluded or failed, with the error message. A badge in the sidebar counts problems, and a notification appears for each new one. Each item keeps its last versions, which can be restored for the whole group, and simultaneous changes from two machines are flagged as conflicts. Optionally, Sync updates itself on every machine, and one machine follows plugin updates for the whole group.

The password of a group can be changed, and machines removed from it: the new key is encrypted for each kept machine with its own public key, so a removed machine cannot read it.

## Limits

- Anyone who has a group's password can install plugins and write the selected files, JSON keys and schedules on every machine in the group. Treat it like an administrator password.
- Plugins installed from a local folder are not synced.
- The daemon's listen address, password, relay settings and identity are never synced.
- Synced schedules run on every machine of the group unless a machine excludes them.
- Plugin installs and updates go through the `paseo` CLI, which must be on the daemon's `PATH`.
- Agent conversations and running sessions are not copied.
- The newer features need every machine of a group on Sync 0.2.0.
