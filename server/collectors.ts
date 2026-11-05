import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { KEY_PREFIX, SELF_PLUGIN_ID, isForbiddenConfigPath, pluginInScope, type GroupScope } from "../shared/model";
import type { LocalPlugin } from "../shared/rpc";
import { runJson, type PaseoCli } from "./cli";
import type { BlobStore } from "./blobs";
import type { Json } from "./replica";

/**
 * Lecture de l'état local (instantané) et application des changements reçus, par catégorie.
 * Un instantané ne contient que des valeurs JSON stables : deux machines dans le même état donnent les mêmes valeurs.
 */

export interface Change {
  key: string;
  /** null : supprimer. */
  value: Json;
}

export interface ApplyOutcome {
  key: string;
  error: string | null;
  /** Application lancée mais pas terminée (mise à jour de Sync lui-même) : ni réussite ni échec pour l'instant. */
  deferred?: boolean;
}

export interface Collector {
  readonly name: string;
  /** Les éléments locaux de cette catégorie couverts par la portée. */
  snapshot(scope: GroupScope): Promise<Map<string, Json>>;
  owns(key: string): boolean;
  apply(changes: Change[]): Promise<ApplyOutcome[]>;
  /**
   * Clé absente du dernier instantané sans être supprimée pour autant (fichier qui a disparu pendant la lecture,
   * devenu trop gros, limite atteinte) : le moteur n'en publie pas la suppression.
   */
  uncertain?(key: string): boolean;
  /** Clé que ce collecteur ne synchronise jamais (fichier temporaire) : oubliée, sans suppression publiée. */
  ignores?(key: string): boolean;
  /** La valeur locale doit l'emporter sur celle du groupe, même si cette machine n'a rien changé (version plus récente). */
  preferLocal?(key: string, local: Json, group: Json): boolean;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------------------------------------------

export interface RawPlugin {
  id: string;
  name?: string;
  enabled: boolean;
  status?: string;
  source?: string;
  installation?: {
    identity?: {
      kind?: string;
      registry?: { url: string; id: string };
      remote?: string;
      packageName?: string;
      pluginPath?: string;
    };
    currentRevision?: string;
  };
}

export type PluginValue = {
  kind: "git" | "npm";
  /** git : adresse du dépôt ; npm : nom du paquet. */
  source: string;
  pluginPath: string;
  registry: { url: string; id: string } | null;
  /** git : commit ; npm : version. */
  revision: string;
  enabled: boolean;
};

export const DEFAULT_REGISTRY = "https://plugins.paseo.sh";

export function pluginValueOf(raw: RawPlugin): PluginValue | null {
  const identity = raw.installation?.identity;
  const revision = raw.installation?.currentRevision;
  if (!identity || !revision) return null;
  const registry = identity.registry ? { url: identity.registry.url, id: identity.registry.id } : null;
  if (identity.kind === "git" && identity.remote) {
    return { kind: "git", source: identity.remote, pluginPath: identity.pluginPath ?? ".", registry, revision, enabled: raw.enabled };
  }
  if (identity.kind === "npm" && identity.packageName) {
    return { kind: "npm", source: identity.packageName, pluginPath: identity.pluginPath ?? ".", registry, revision, enabled: raw.enabled };
  }
  return null;
}

const sameSource = (a: PluginValue, b: PluginValue) => a.kind === b.kind && a.source === b.source && a.pluginPath === b.pluginPath;

function registrySpec(registry: { url: string; id: string }): string {
  if (registry.url.replace(/\/$/, "") === DEFAULT_REGISTRY) return registry.id;
  return `${new URL(registry.url).host}/${registry.id}`;
}

export class PluginsCollector implements Collector {
  readonly name = "plugins";
  constructor(
    private readonly cli: PaseoCli,
    private readonly paseoHome: string,
    private readonly log: (line: string) => void,
  ) {}

  owns(key: string): boolean {
    return key.startsWith(KEY_PREFIX.plugin);
  }

  async list(): Promise<RawPlugin[]> {
    return (await runJson(this.cli, ["plugin", "ls"])) as RawPlugin[];
  }

  async localPlugins(): Promise<LocalPlugin[]> {
    return (await this.list()).map((raw) => {
      const value = pluginValueOf(raw);
      return {
        id: raw.id,
        name: raw.name ?? null,
        kind: raw.installation?.identity?.kind ?? raw.source ?? "directory",
        revision: raw.installation?.currentRevision ?? null,
        enabled: raw.enabled,
        syncable: value !== null && raw.id !== SELF_PLUGIN_ID,
      };
    });
  }

  async snapshot(scope: GroupScope): Promise<Map<string, Json>> {
    const out = new Map<string, Json>();
    if (!scope.plugins.enabled) return out;
    for (const raw of await this.list()) {
      if (!pluginInScope(scope, raw.id)) continue;
      const value = pluginValueOf(raw);
      // Un plugin installé depuis un dossier local n'a pas de source reproductible ailleurs : il reste local.
      if (value) out.set(`${KEY_PREFIX.plugin}${raw.id}`, value as unknown as Json);
    }
    return out;
  }

  async apply(changes: Change[]): Promise<ApplyOutcome[]> {
    const current = new Map((await this.list()).map((raw) => [raw.id, raw]));
    const outcomes: ApplyOutcome[] = [];
    for (const change of changes) {
      const id = change.key.slice(KEY_PREFIX.plugin.length);
      try {
        await this.applyOne(id, change.value as unknown as PluginValue | null, current.get(id));
        outcomes.push({ key: change.key, error: null });
      } catch (error) {
        outcomes.push({ key: change.key, error: describe(error) });
      }
    }
    return outcomes;
  }

  private async applyOne(id: string, wanted: PluginValue | null, installed: RawPlugin | undefined): Promise<void> {
    if (id === SELF_PLUGIN_ID || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("identifiant de plugin refusé");
    if (wanted === null) {
      if (installed) {
        this.log(`plugin ${id} : suppression`);
        await runJson(this.cli, ["plugin", "remove", id]);
      }
      return;
    }
    const have = installed ? pluginValueOf(installed) : null;
    if (installed && (!have || !sameSource(have, wanted))) {
      this.log(`plugin ${id} : source différente, réinstallation`);
      await this.reinstall(id, wanted);
      return;
    }
    if (!installed || !have) {
      this.log(`plugin ${id} : installation ${wanted.revision}`);
      await this.install(id, wanted);
    } else if (have.revision !== wanted.revision) {
      this.log(`plugin ${id} : ${have.revision} -> ${wanted.revision}`);
      await this.update(id, have, wanted);
    }
    await this.setEnabled(id, wanted.enabled);
  }

  private async revisionOf(id: string): Promise<string | null> {
    const raw = (await this.list()).find((plugin) => plugin.id === id);
    return raw?.installation?.currentRevision ?? null;
  }

  private async setEnabled(id: string, enabled: boolean): Promise<void> {
    const raw = (await this.list()).find((plugin) => plugin.id === id);
    if (!raw || raw.enabled === enabled) return;
    await runJson(this.cli, ["plugin", enabled ? "enable" : "disable", id]);
  }

  /** Installation exacte : la source explicite, à la révision voulue. */
  private async installExplicit(id: string, wanted: PluginValue): Promise<void> {
    if (wanted.kind === "git") {
      const args = ["plugin", "install", wanted.source, "--id", id, "--ref", wanted.revision];
      if (wanted.pluginPath && wanted.pluginPath !== ".") args.push("--path", wanted.pluginPath);
      await runJson(this.cli, args);
    } else {
      await runJson(this.cli, ["plugin", "install", `npm:${wanted.source}@${wanted.revision}`, "--id", id]);
    }
  }

  private async install(id: string, wanted: PluginValue): Promise<void> {
    // Par le registre d'abord, pour garder le lien avec la fiche (le registre impose sa révision revue).
    if (wanted.registry) {
      try {
        await runJson(this.cli, ["plugin", "install", registrySpec(wanted.registry), "--id", id]);
        if ((await this.revisionOf(id)) === wanted.revision) return;
        await this.reinstall(id, wanted, { explicit: true });
        return;
      } catch (error) {
        this.log(`plugin ${id} : registre indisponible (${describe(error)}), source directe`);
        if (await this.revisionOf(id)) await this.reinstall(id, wanted, { explicit: true });
        else await this.installExplicit(id, wanted);
        return;
      }
    }
    await this.installExplicit(id, wanted);
  }

  private async update(id: string, have: PluginValue, wanted: PluginValue): Promise<void> {
    try {
      if (have.registry) {
        await runJson(this.cli, ["plugin", "update", id, "--yes"]);
      } else if (wanted.kind === "git") {
        await runJson(this.cli, ["plugin", "update", id, "--ref", wanted.revision]);
      } else {
        await runJson(this.cli, ["plugin", "update", id, "--version", wanted.revision]);
      }
      if ((await this.revisionOf(id)) === wanted.revision) return;
    } catch (error) {
      this.log(`plugin ${id} : mise à jour refusée (${describe(error)}), réinstallation`);
    }
    await this.reinstall(id, wanted, { explicit: true });
  }

  /** Retirer puis réinstaller efface les réglages du plugin : on les met de côté et on les remet. */
  private async reinstall(id: string, wanted: PluginValue, options: { explicit?: boolean } = {}): Promise<void> {
    const settingsDir = path.join(this.paseoHome, "plugin-settings", id);
    const backup = `${settingsDir}.sync-backup-${Date.now()}`;
    const hadSettings = existsSync(settingsDir);
    if (hadSettings) cpSync(settingsDir, backup, { recursive: true });
    try {
      await runJson(this.cli, ["plugin", "remove", id]);
      if (options.explicit) await this.installExplicit(id, wanted);
      else await this.install(id, wanted);
    } finally {
      if (hadSettings) {
        mkdirSync(settingsDir, { recursive: true });
        cpSync(backup, settingsDir, { recursive: true, force: true });
        rmSync(backup, { recursive: true, force: true });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Réglages des plugins
// ---------------------------------------------------------------------------------------------------------------

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class PluginSettingsCollector implements Collector {
  readonly name = "pluginSettings";
  constructor(
    private readonly cli: PaseoCli,
    private readonly paseoHome: string,
    private readonly runningPlugins: () => Promise<Set<string>>,
  ) {}

  private get root(): string {
    return path.join(this.paseoHome, "plugin-settings");
  }

  owns(key: string): boolean {
    return key.startsWith(KEY_PREFIX.settings);
  }

  async snapshot(scope: GroupScope): Promise<Map<string, Json>> {
    const out = new Map<string, Json>();
    if (!scope.pluginSettings.enabled || !existsSync(this.root)) return out;
    for (const pluginId of readdirSync(this.root)) {
      if (!SAFE_SEGMENT.test(pluginId) || !pluginInScope(scope, pluginId)) continue;
      const dir = path.join(this.root, pluginId);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json") || file.includes(".tmp") || !SAFE_SEGMENT.test(file)) continue;
        try {
          const parsed = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Json;
          out.set(`${KEY_PREFIX.settings}${pluginId}/${file.slice(0, -5)}`, parsed);
        } catch {
          // Fichier en cours d'écriture ou abîmé : relu au prochain passage.
        }
      }
    }
    return out;
  }

  async apply(changes: Change[]): Promise<ApplyOutcome[]> {
    const outcomes: ApplyOutcome[] = [];
    const touched = new Set<string>();
    for (const change of changes) {
      const [pluginId = "", settingsId = ""] = change.key.slice(KEY_PREFIX.settings.length).split("/");
      try {
        if (!SAFE_SEGMENT.test(pluginId) || !SAFE_SEGMENT.test(settingsId)) throw new Error("nom de réglages refusé");
        const target = path.join(this.root, pluginId, `${settingsId}.json`);
        if (change.value === null) {
          rmSync(target, { force: true });
        } else {
          mkdirSync(path.dirname(target), { recursive: true });
          const temporary = `${target}.sync-${process.pid}.tmp`;
          writeFileSync(temporary, JSON.stringify(change.value), { mode: 0o600 });
          renameSync(temporary, target);
        }
        touched.add(pluginId);
        outcomes.push({ key: change.key, error: null });
      } catch (error) {
        outcomes.push({ key: change.key, error: describe(error) });
      }
    }
    // Le plugin relit son fichier à chaque lecture, mais ses abonnés ne sont prévenus qu'au rechargement.
    const running = touched.size ? await this.runningPlugins() : new Set<string>();
    for (const pluginId of touched) {
      if (!running.has(pluginId) || pluginId === SELF_PLUGIN_ID) continue;
      const result = await this.cli.run(["plugin", "reload", pluginId, "--json"]);
      if (result.code !== 0) {
        for (const outcome of outcomes) {
          if (outcome.key.startsWith(`${KEY_PREFIX.settings}${pluginId}/`) && !outcome.error) {
            outcome.error = `réglages écrits, rechargement de ${pluginId} impossible`;
          }
        }
      }
    }
    return outcomes;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// config.json du daemon (agents, fournisseurs, profils, fonctionnalités…)
// ---------------------------------------------------------------------------------------------------------------

export function readPath(root: unknown, dotted: string): Json | undefined {
  let node: unknown = root;
  for (const part of dotted.split(".")) {
    if (node === null || typeof node !== "object" || Array.isArray(node) || !(part in (node as object))) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node as Json;
}

export class ConfigCollector implements Collector {
  readonly name = "config";
  constructor(
    private readonly cli: PaseoCli,
    private readonly paseoHome: string,
  ) {}

  owns(key: string): boolean {
    return key.startsWith(KEY_PREFIX.config);
  }

  private read(): unknown {
    return JSON.parse(readFileSync(path.join(this.paseoHome, "config.json"), "utf8"));
  }

  async snapshot(scope: GroupScope): Promise<Map<string, Json>> {
    const out = new Map<string, Json>();
    if (!scope.config.enabled) return out;
    const config = this.read();
    for (const dotted of scope.config.paths) {
      if (isForbiddenConfigPath(dotted)) continue;
      const value = readPath(config, dotted);
      if (value !== undefined) out.set(`${KEY_PREFIX.config}${dotted}`, value);
    }
    return out;
  }

  async apply(changes: Change[]): Promise<ApplyOutcome[]> {
    const outcomes: ApplyOutcome[] = [];
    for (const change of changes) {
      const dotted = change.key.slice(KEY_PREFIX.config.length);
      try {
        if (isForbiddenConfigPath(dotted)) throw new Error("chemin de configuration protégé");
        const args =
          change.value === null ? ["daemon", "config", "unset", dotted] : ["daemon", "config", "set", dotted, JSON.stringify(change.value)];
        const result = await this.cli.run(args);
        if (result.code !== 0) throw new Error(result.stderr.split("\n")[0] || `code ${result.code}`);
        outcomes.push({ key: change.key, error: null });
      } catch (error) {
        outcomes.push({ key: change.key, error: describe(error) });
      }
    }
    return outcomes;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fichiers et dossiers
// ---------------------------------------------------------------------------------------------------------------

export const FILE_LIMITS = { perFile: 4 * 1024 * 1024, perSet: 64 * 1024 * 1024, filesPerSet: 5000 } as const;
const SKIPPED_NAMES = new Set([".git", "node_modules", ".DS_Store", "__pycache__"]);
/**
 * Fichiers en cours d'écriture (les nôtres, `*.sync-<pid>.tmp`, ou ceux d'un programme qui écrit un temporaire puis le
 * renomme) : jamais relevés, comme la surveillance les ignore déjà (`IGNORED` dans watcher.ts).
 */
export const TEMPORARY_NAME = /(\.tmp$|\.sync-|~$|\.swp$)/;

/** Le fichier a disparu entre la liste du dossier et sa lecture (temporaire renommé, suppression) : on passe. */
const vanished = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** Valeur d'un fichier : référence au contenu rangé par empreinte (0.2.0), ou contenu inline (avant). */
export type FileValue = { sha: string; size: number; mode: number } | { b64: string; mode: number };

export function expandHome(input: string, home = homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

/** Chemin relatif sûr : pas d'absolu, pas de `..`, séparateurs `/`. */
export function safeRelative(relative: string): boolean {
  if (!relative || relative.startsWith("/") || relative.includes("\\") || relative.includes("\0")) return false;
  return relative.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export class FilesCollector implements Collector {
  readonly name = "files";
  /** Ensembles connus au dernier instantané, pour retrouver la racine d'une clé à l'application. */
  private sets = new Map<string, string>();
  /** Empreinte déjà calculée d'un fichier inchangé (même taille, même date) : il n'est pas relu. */
  private statCache = new Map<string, { size: number; mtimeMs: number; sha: string }>();

  constructor(
    private readonly log: (line: string) => void,
    private readonly home = homedir(),
    /** Sans magasin de contenus, les fichiers voyagent inline (format d'avant 0.2.0). */
    private readonly blobs?: BlobStore,
  ) {}

  /** Contenus référencés par le dernier instantané (à garder au nettoyage du magasin). */
  referencedBlobs(): Set<string> {
    return new Set([...this.statCache.values()].map((entry) => entry.sha));
  }

  /** Clés (ou préfixes de dossier) incertaines au dernier instantané. */
  private unsure: string[] = [];

  owns(key: string): boolean {
    return key.startsWith(KEY_PREFIX.file);
  }

  uncertain(key: string): boolean {
    return this.unsure.some((prefix) => key === prefix || key.startsWith(`${prefix}/`));
  }

  ignores(key: string): boolean {
    return this.owns(key) && key.slice(KEY_PREFIX.file.length).split("/").slice(1).some((segment) => TEMPORARY_NAME.test(segment));
  }

  async snapshot(scope: GroupScope): Promise<Map<string, Json>> {
    const out = new Map<string, Json>();
    const unsure: string[] = [];
    this.unsure = unsure;
    const seen = new Set<string>();
    this.sets = new Map(scope.files.sets.map((set) => [set.id, expandHome(set.path, this.home)]));
    if (!scope.files.enabled) return out;
    for (const set of scope.files.sets) {
      const root = expandHome(set.path, this.home);
      if (!existsSync(root)) continue;
      let total = 0;
      let count = 0;
      const keyOf = (relative: string) => `${KEY_PREFIX.file}${set.id}/${relative || path.basename(root)}`;
      // Un dossier ou un fichier qui manque à l'appel n'est pas une suppression : on le note incertain.
      const unsureOf = (relative: string) => unsure.push(relative ? keyOf(relative) : `${KEY_PREFIX.file}${set.id}`);
      const visit = (absolute: string, relative: string) => {
        let info: ReturnType<typeof lstatSync>;
        try {
          info = lstatSync(absolute);
        } catch (error) {
          if (vanished(error)) return void unsureOf(relative);
          throw error;
        }
        if (info.isSymbolicLink()) return;
        if (info.isDirectory()) {
          let names: string[];
          try {
            names = readdirSync(absolute).sort();
          } catch (error) {
            if (vanished(error)) return void unsureOf(relative);
            throw error;
          }
          for (const name of names) {
            if (SKIPPED_NAMES.has(name) || TEMPORARY_NAME.test(name)) continue;
            visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
          }
          return;
        }
        if (!info.isFile()) return;
        if (info.size > FILE_LIMITS.perFile) {
          unsureOf(relative);
          return this.log(`fichiers ${set.id} : ${relative} trop gros, ignoré`);
        }
        if (total + info.size > FILE_LIMITS.perSet || count >= FILE_LIMITS.filesPerSet) {
          unsureOf(relative);
          return this.log(`fichiers ${set.id} : limite atteinte, ${relative} ignoré`);
        }
        const cached = this.statCache.get(absolute);
        let value: FileValue;
        if (this.blobs && cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && this.blobs.has(cached.sha)) {
          value = { sha: cached.sha, size: info.size, mode: info.mode & 0o777 };
          seen.add(absolute);
        } else {
          let content: Buffer;
          try {
            content = readFileSync(absolute);
          } catch (error) {
            if (vanished(error)) return void unsureOf(relative);
            throw error;
          }
          if (this.blobs) {
            const sha = this.blobs.put(content);
            this.statCache.set(absolute, { size: info.size, mtimeMs: info.mtimeMs, sha });
            seen.add(absolute);
            value = { sha, size: content.length, mode: info.mode & 0o777 };
          } else {
            value = { b64: content.toString("base64"), mode: info.mode & 0o777 };
          }
        }
        total += info.size;
        count += 1;
        // Un fichier seul (pas un dossier) a pour chemin relatif son propre nom.
        out.set(keyOf(relative), value);
      };
      visit(root, "");
    }
    // Le cache ne garde que les fichiers encore présents.
    for (const absolute of this.statCache.keys()) if (!seen.has(absolute)) this.statCache.delete(absolute);
    return out;
  }

  async apply(changes: Change[]): Promise<ApplyOutcome[]> {
    const outcomes: ApplyOutcome[] = [];
    for (const change of changes) {
      try {
        const rest = change.key.slice(KEY_PREFIX.file.length);
        const slash = rest.indexOf("/");
        const setId = rest.slice(0, slash);
        const relative = rest.slice(slash + 1);
        const root = this.sets.get(setId);
        if (!root) throw new Error(`ensemble de fichiers inconnu ici : ${setId}`);
        if (!safeRelative(relative)) throw new Error("chemin de fichier refusé");
        // Racine qui est un fichier seul : la clé porte son nom.
        const isSingle = existsSync(root) ? statSync(root).isFile() : !relative.includes("/") && path.basename(root) === relative;
        const target = isSingle ? root : path.join(root, ...relative.split("/"));
        if (!isSingle && !target.startsWith(root + path.sep)) throw new Error("chemin de fichier refusé");
        if (change.value === null) {
          rmSync(target, { force: true });
        } else {
          const value = change.value as unknown as FileValue;
          let content: Buffer;
          if ("sha" in value) {
            const blob = this.blobs?.get(value.sha) ?? null;
            if (!blob) throw new Error("contenu pas encore reçu des autres machines");
            content = blob;
          } else {
            content = Buffer.from(value.b64, "base64");
          }
          // Un fichier privé (aucun droit pour le groupe ni les autres, ex. 0600) arrive dans des dossiers privés (0700).
          const privateFile = (value.mode & 0o077) === 0;
          mkdirSync(path.dirname(target), privateFile ? { recursive: true, mode: 0o700 } : { recursive: true });
          const temporary = `${target}.sync-${process.pid}.tmp`;
          writeFileSync(temporary, content, { mode: value.mode & 0o777 });
          chmodSync(temporary, value.mode & 0o777);
          renameSync(temporary, target);
        }
        outcomes.push({ key: change.key, error: null });
      } catch (error) {
        outcomes.push({ key: change.key, error: describe(error) });
      }
    }
    return outcomes;
  }
}
