import { homedir } from "node:os";
import path from "node:path";
import type { PluginCleanup, PluginRpcContract } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { input as ZodInput, output as ZodOutput, ZodType } from "zod";
import { DEFAULT_SCOPE } from "./shared/model";
import {
  InviteSchema,
  checkUpdatesRpc,
  decideRpc,
  groupCreateRpc,
  groupRemoveRpc,
  groupUpdateRpc,
  historyRpc,
  inviteDecodeRpc,
  inviteRpc,
  nodeUpdateRpc,
  pluginsListRpc,
  rekeyRpc,
  restoreRpc,
  retryRpc,
  statusRpc,
  syncNowRpc,
  type NodeView,
} from "./shared/rpc";
import { createPaseoCli, isDaemonNotReady } from "./server/cli";
import { ConfigCollector, FilesCollector, PluginSettingsCollector, PluginsCollector } from "./server/collectors";
import { JsonKeysCollector, SchedulesCollector } from "./server/collectors-extra";
import { BlobStore } from "./server/blobs";
import { deriveMasterKey, groupKeys, normalizeGroupName } from "./server/crypto";
import { Engine } from "./server/engine";
import { SelfCollector } from "./server/self-update";
import { CHECK_EVERY_MS, PluginUpdater, updateLeader, updatesFor } from "./server/plugin-updates";
import { Store, newGroupState } from "./server/store";
import { ChangeWatcher, watchTargets } from "./server/watcher";
import { expandHome } from "./server/collectors";
import { guessAddress, resolveListenHost, sendRequest, startServer, type ListeningServer } from "./server/transport";

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface SyncServerOptions {
  paseoHome: string;
  dataDir: string;
  home?: string;
  cliBin?: string;
}

export function createSyncServer(server: PluginServerContext, options: SyncServerOptions): PluginCleanup {
  const log = (line: string) => console.log(`[sync] ${line}`);
  const store = new Store(options.dataDir);
  const cli = createPaseoCli({ home: options.paseoHome, bin: options.cliBin });
  const plugins = new PluginsCollector(cli, options.paseoHome, log);
  const blobs = new BlobStore(path.join(options.dataDir, "blobs"));
  const files = new FilesCollector(log, options.home ?? homedir(), blobs);
  const jsonKeys = new JsonKeysCollector(options.home ?? homedir());
  const schedules = new SchedulesCollector(cli, options.paseoHome);
  const runningPlugins = async () => new Set((await plugins.list()).filter((plugin) => plugin.status === "running").map((plugin) => plugin.id));
  const collectors = [
    plugins,
    new PluginSettingsCollector(cli, options.paseoHome, runningPlugins),
    new ConfigCollector(cli, options.paseoHome),
    files,
    jsonKeys,
    schedules,
    // En dernier : la mise à jour de Sync l'arrête, le reste doit être appliqué avant.
    new SelfCollector({ cli, list: () => plugins.list(), paseoHome: options.paseoHome, dataDir: options.dataDir, log }),
  ];

  let listening: ListeningServer | null = null;
  let listenError: string | null = null;
  const selfUrl = () => store.data.node.advertiseUrl ?? `http://${guessAddress()}:${store.data.node.port}`;

  const engine = new Engine({
    store,
    collectors,
    send: sendRequest,
    selfUrl,
    log,
    afterPass: () => rewatch(),
    blobs,
    blobsInUse: () => files.referencedBlobs(),
  });

  const handler = {
    keysFor(groupId: string) {
      const found = store.findGroup(groupId, Date.now());
      if (!found || !found.group.enabled) return null;
      // Ancienne clé d'un changement de mot de passe récent : seulement pour remettre l'avis.
      return found.stale ? groupKeys(Buffer.from(found.group.previous!.key, "base64")) : engine.keys(found.group);
    },
    handle: (groupId: string, request: Parameters<Engine["handleIncoming"]>[1]) => engine.handleIncoming(groupId, request),
  };

  /** Adresse sur laquelle le serveur écoute vraiment (résolution de « auto »). */
  let boundHost: string | null = null;
  async function listen(): Promise<void> {
    if (listening) await listening.close();
    listening = null;
    const { port } = store.data.node;
    const host = resolveListenHost(store.data.node.listenHost);
    boundHost = host;
    try {
      listening = await startServer(host, port, handler, log);
      listenError = null;
      log(`à l'écoute sur ${host}:${port}, annoncé comme ${selfUrl()}`);
    } catch (error) {
      listenError = describe(error);
      log(`écoute impossible sur ${host}:${port} : ${listenError}`);
    }
  }
  void listen();

  // Détection des changements locaux : un passage dès qu'un fichier suivi bouge.
  const runAll = () => {
    for (const group of store.data.groups) if (group.enabled) void engine.run(group.id);
  };
  const watcher = new ChangeWatcher(runAll, { paused: () => engine.isApplying(), log });
  let watching = 0;
  function rewatch() {
    if (!store.data.node.watch || store.data.groups.length === 0) {
      watcher.close();
      watching = 0;
      return;
    }
    const enabled = store.data.groups.filter((group) => group.enabled).map((group) => engine.scopeOf(group));
    const roots = enabled.flatMap((scope) => [
      ...(scope.files.enabled ? scope.files.sets.map((set) => expandHome(set.path, options.home ?? homedir())) : []),
      ...jsonKeys.files(scope),
    ]);
    const dirs = enabled.some((scope) => scope.schedules.enabled) ? [schedules.dir] : [];
    try {
      const targets = watchTargets(options.paseoHome, [...new Set(roots)], dirs);
      watcher.update(targets);
      watching = targets.length;
    } catch (error) {
      log(`surveillance : ${describe(error)}`);
    }
  }

  const nodeView = (): NodeView => ({
    ...store.data.node,
    effectiveUrl: selfUrl(),
    listening: listening !== null,
    listenError,
    boundHost,
    watching: store.data.node.watch ? watching : 0,
  });

  function handle<I extends ZodType, O extends ZodType>(contract: PluginRpcContract<I, O>, run: (input: ZodOutput<I>) => Promise<ZodInput<O>>): void {
    server.handle(contract, (input) => run(input));
  }

  const requireGroup = (id: string) => {
    const group = store.group(id);
    if (!group) throw new Error("Groupe inconnu.");
    return group;
  };

  handle(statusRpc, async () => engine.status(nodeView()));

  handle(nodeUpdateRpc, async (input) => {
    const node = store.data.node;
    const relisten = (input.port !== undefined && input.port !== node.port) || (input.listenHost !== undefined && input.listenHost !== node.listenHost);
    Object.assign(node, Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)));
    store.save();
    if (relisten) await listen();
    restartTimer();
    rewatch();
    return { ok: true as const };
  });

  handle(groupCreateRpc, async ({ name, password, peers, mode }) => {
    const master = await deriveMasterKey(password, name);
    const { groupId } = groupKeys(master);
    if (store.group(groupId)) throw new Error("Cette machine est déjà dans ce groupe.");
    if (store.data.groups.some((group) => normalizeGroupName(group.name) === normalizeGroupName(name))) {
      throw new Error("Un groupe de ce nom existe déjà ici avec un autre mot de passe.");
    }
    const group = newGroupState({ id: groupId, name: name.trim(), key: master.toString("base64"), mode, peers, now: Date.now() });
    store.data.groups.push(group);
    // Un nouveau groupe fixe sa portée ; une machine qui rejoint reçoit celle du groupe.
    if (peers.length === 0) engine.setScope(group, DEFAULT_SCOPE);
    store.save();
    rewatch();
    void engine.run(groupId);
    return { id: groupId };
  });

  handle(groupUpdateRpc, async ({ id, peers, mode, enabled, scope, move, exclude, approval }) => {
    const group = requireGroup(id);
    if (exclude !== undefined) group.exclude = [...new Set(exclude.map((pattern) => pattern.trim()).filter(Boolean))];
    if (approval !== undefined) group.approval = approval;
    if (peers !== undefined) group.peers = [...new Set(peers)];
    if (mode !== undefined) group.mode = mode;
    if (enabled !== undefined) group.enabled = enabled;
    if (scope !== undefined) engine.setScope(group, scope);
    if (move !== undefined) {
      const groups = store.data.groups;
      const index = groups.indexOf(group);
      const target = index + move;
      if (target >= 0 && target < groups.length) [groups[index], groups[target]] = [groups[target]!, groups[index]!];
    }
    store.save();
    rewatch();
    void engine.run(id);
    return { ok: true as const };
  });

  handle(decideRpc, async ({ id, keys, decision }) => {
    const group = requireGroup(id);
    const count = engine.decide(group, keys, decision);
    store.save();
    void engine.run(id);
    return { count };
  });

  handle(historyRpc, async ({ id, key }) => ({ versions: engine.historyOf(requireGroup(id), key) }));

  handle(restoreRpc, async ({ id, key, hash }) => {
    const group = requireGroup(id);
    engine.restore(group, key, hash);
    store.save();
    void engine.run(id);
    return { ok: true as const };
  });

  handle(rekeyRpc, async ({ id, password, remove }) => {
    const group = requireGroup(id);
    const master = await deriveMasterKey(password, group.name);
    const { rekey, oldKeys, unreachable, notify } = engine.rekey(group, master, remove);
    store.save();
    const reached = await engine.announceRekey(group, rekey, oldKeys, notify);
    store.save();
    void engine.run(group.id);
    return { id: group.id, reached, unreachable };
  });

  handle(retryRpc, async ({ id, key }) => {
    const group = requireGroup(id);
    const count = engine.retry(group, key);
    store.save();
    void engine.run(group.id);
    return { count };
  });

  handle(groupRemoveRpc, async ({ id }) => {
    store.data.groups = store.data.groups.filter((group) => group.id !== id);
    store.save();
    rewatch();
    return { ok: true as const };
  });

  handle(syncNowRpc, async ({ id }) => {
    const ids = id ? [requireGroup(id).id] : store.data.groups.map((group) => group.id);
    await Promise.all(ids.map((groupId) => engine.run(groupId)));
    return { ok: true as const };
  });

  handle(pluginsListRpc, async () => ({ plugins: await plugins.localPlugins() }));

  handle(inviteRpc, async ({ id }) => {
    const group = requireGroup(id);
    const peers = [...new Set([selfUrl(), ...Object.values(group.members).map((member) => member.url), ...group.peers])].filter(Boolean);
    const invite = InviteSchema.parse({ v: 1, name: group.name, peers });
    return { code: `psync1.${Buffer.from(JSON.stringify(invite)).toString("base64url")}` };
  });

  handle(inviteDecodeRpc, async ({ code }) => {
    const raw = code.trim().replace(/^psync1\./, "");
    try {
      return InviteSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    } catch {
      throw new Error("Code d'invitation illisible.");
    }
  });

  // Suivi des mises à jour des plugins : seule la machine meneuse de chaque groupe vérifie et installe.
  const updater = new PluginUpdater(cli, log);
  let checkingUpdates = false;
  async function checkPluginUpdates(force = false): Promise<void> {
    if (checkingUpdates) return;
    checkingUpdates = true;
    try {
      const now = Date.now();
      for (const group of store.data.groups) {
        const scope = engine.scopeOf(group);
        if (!group.enabled || !scope.autoUpdatePlugins) continue;
        if (updateLeader(group, store.data.node.nodeId, now) !== store.data.node.nodeId) continue;
        if (!force && group.lastUpdateCheckAt !== null && now - group.lastUpdateCheckAt < CHECK_EVERY_MS) continue;
        group.lastUpdateCheckAt = now;
        try {
          const updates = updatesFor(group, scope, await updater.check(now), (key) => engine.owns(group, key));
          group.lastUpdateCheckError = null;
          if (updates.length > 0 && (await engine.exclusive(() => updater.apply(group, updates, now))) > 0) void engine.run(group.id);
        } catch (error) {
          if (isDaemonNotReady(error)) {
            // Daemon en démarrage : vérification refaite au prochain tour, sans erreur affichée.
            group.lastUpdateCheckAt = null;
          } else {
            group.lastUpdateCheckError = describe(error);
            log(`groupe ${group.name} : ${group.lastUpdateCheckError}`);
          }
        }
        store.save();
      }
    } finally {
      checkingUpdates = false;
    }
  }
  const updateTimer = setInterval(() => void checkPluginUpdates(), 15 * 60_000);
  const firstUpdateCheck = setTimeout(() => void checkPluginUpdates(), 90_000);

  handle(checkUpdatesRpc, async () => {
    await checkPluginUpdates(true);
    return { ok: true as const };
  });

  // Passages réguliers ; chaque groupe a son propre passage, un seul à la fois.
  let timer: ReturnType<typeof setInterval> | null = null;
  function restartTimer() {
    if (timer) clearInterval(timer);
    // Passage de secours : membres revenus en ligne, nouvelles tentatives, événement manqué. Il repose aussi les
    // surveillances (portée reçue d'un autre membre, dossier créé entre-temps).
    timer = setInterval(() => {
      // Tailscale arrivé (ou parti) après le démarrage de Sync : on se remet à l'écoute au bon endroit.
      if (store.data.node.listenHost === "auto" && resolveListenHost("auto") !== boundHost) void listen();
      rewatch();
      runAll();
    }, store.data.node.intervalSec * 1000);
  }
  restartTimer();
  // Premier passage peu après le démarrage, le temps que le daemon finisse de charger les plugins.
  // Premier passage quand le daemon répond : au démarrage de Paseo, il charge encore ses plugins (parfois une minute)
  // et le CLI dit alors « Start with: paseo daemon start ». On l'interroge toutes les 5 s, 5 min au plus.
  let first: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const startedAt = Date.now();
  async function firstPass(): Promise<void> {
    first = null;
    if (stopped) return;
    try {
      await plugins.list();
    } catch (error) {
      if (isDaemonNotReady(error) && Date.now() - startedAt < 5 * 60_000) {
        first = setTimeout(() => void firstPass(), 5000);
        return;
      }
    }
    rewatch();
    runAll();
  }
  first = setTimeout(() => void firstPass(), 5000);

  return async () => {
    stopped = true;
    if (first) clearTimeout(first);
    clearTimeout(firstUpdateCheck);
    clearInterval(updateTimer);
    if (timer) clearInterval(timer);
    engine.stop();
    watcher.close();
    if (listening) await listening.close();
  };
}

export function paseoHomeDir(): string {
  return process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
}

export default function contribute(server: PluginServerContext): PluginCleanup {
  const paseoHome = paseoHomeDir();
  return createSyncServer(server, { paseoHome, dataDir: path.join(paseoHome, "plugin-data", "sync") });
}
