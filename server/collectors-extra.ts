import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { KEY_PREFIX, type GroupScope, type JsonKey } from "../shared/model";
import { cliError, type PaseoCli } from "./cli";
import { TEMPORARY_NAME, expandHome, readPath, type ApplyOutcome, type Change, type Collector } from "./collectors";
import type { Json } from "./replica";

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Écriture atomique : fichier temporaire puis renommage, en gardant les droits du fichier remplacé. */
function writeAtomic(target: string, content: string, defaultMode = 0o600): void {
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : defaultMode;
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.sync-${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, target);
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Pose (ou retire, si `value` vaut null) la clé `dotted` dans `root`, en créant les objets intermédiaires. */
export function setPath(root: Record<string, unknown>, dotted: string, value: Json): void {
  const parts = dotted.split(".");
  const last = parts.pop()!;
  let node: Record<string, unknown> = root;
  for (const part of parts) {
    const next = node[part];
    if (next === undefined) {
      if (value === null) return;
      node[part] = {};
    } else if (!isObject(next)) {
      throw new Error(`« ${part} » n'est pas un objet dans ce fichier`);
    }
    node = node[part] as Record<string, unknown>;
  }
  if (value === null) delete node[last];
  else node[last] = value;
}

// ---------------------------------------------------------------------------------------------------------------
// Clés de fichiers JSON (serveurs MCP de Claude Code, permissions…)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Une clé d'un fichier JSON, le reste du fichier intact : `~/.claude.json` contient aussi l'historique et l'état propre
 * à chaque machine, seuls ses `mcpServers` sont partagés. Un fichier illisible (en cours d'écriture) rend la clé
 * incertaine pour ce passage.
 */
export class JsonKeysCollector implements Collector {
  readonly name = "json";
  private entries = new Map<string, JsonKey>();
  private unsure = new Set<string>();

  constructor(private readonly home = homedir()) {}

  owns(key: string): boolean {
    return key.startsWith(KEY_PREFIX.json);
  }

  uncertain(key: string): boolean {
    return this.unsure.has(key);
  }

  /** Fichiers suivis, pour la détection des changements. */
  files(scope: GroupScope): string[] {
    return scope.json.enabled ? scope.json.entries.map((entry) => expandHome(entry.file, this.home)) : [];
  }

  async snapshot(scope: GroupScope): Promise<Map<string, Json>> {
    const out = new Map<string, Json>();
    this.entries = new Map(scope.json.entries.map((entry) => [`${KEY_PREFIX.json}${entry.id}`, entry]));
    this.unsure = new Set();
    if (!scope.json.enabled) return out;
    for (const [key, entry] of this.entries) {
      const file = expandHome(entry.file, this.home);
      if (!existsSync(file)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        this.unsure.add(key);
        continue;
      }
      const value = readPath(parsed, entry.path);
      if (value !== undefined) out.set(key, value);
    }
    return out;
  }

  async apply(changes: Change[]): Promise<ApplyOutcome[]> {
    return changes.map((change) => {
      try {
        const entry = this.entries.get(change.key);
        if (!entry) throw new Error("clé JSON inconnue ici");
        const file = expandHome(entry.file, this.home);
        let root: Record<string, unknown> = {};
        if (existsSync(file)) {
          const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
          if (!isObject(parsed)) throw new Error("le fichier ne contient pas un objet JSON");
          root = parsed;
        } else if (change.value === null) {
          return { key: change.key, error: null };
        }
        setPath(root, entry.path, change.value);
        writeAtomic(file, `${JSON.stringify(root, null, 2)}\n`);
        return { key: change.key, error: null };
      } catch (error) {
        return { key: change.key, error: describe(error) };
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Planifications Paseo
// ---------------------------------------------------------------------------------------------------------------

/** Ce qui définit une planification ; le reste du fichier (prochaine exécution, historique) reste propre à la machine. */
const DEFINITION_FIELDS = ["name", "prompt", "cadence", "target", "maxRuns", "expiresAt", "status"] as const;
const SCHEDULE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class SchedulesCollector implements Collector {
  readonly name = "schedules";
  private unsure = new Set<string>();

  constructor(
    private readonly cli: PaseoCli,
    private readonly paseoHome: string,
  ) {}

  get dir(): string {
    return path.join(this.paseoHome, "schedules");
  }

  owns(key: string): boolean {
    return key.startsWith(KEY_PREFIX.schedule);
  }

  uncertain(key: string): boolean {
    return this.unsure.has(key);
  }

  ignores(key: string): boolean {
    return this.owns(key) && !SCHEDULE_ID.test(key.slice(KEY_PREFIX.schedule.length));
  }

  async snapshot(scope: GroupScope): Promise<Map<string, Json>> {
    const out = new Map<string, Json>();
    this.unsure = new Set();
    if (!scope.schedules.enabled || !existsSync(this.dir)) return out;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json") || TEMPORARY_NAME.test(name)) continue;
      const id = name.slice(0, -5);
      if (!SCHEDULE_ID.test(id)) continue;
      const key = `${KEY_PREFIX.schedule}${id}`;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(readFileSync(path.join(this.dir, name), "utf8")) as Record<string, unknown>;
      } catch {
        this.unsure.add(key);
        continue;
      }
      // Terminée ou expirée ici : ce n'est pas une suppression, rien à publier.
      if (raw.status !== "active" && raw.status !== "paused") {
        this.unsure.add(key);
        continue;
      }
      out.set(key, Object.fromEntries(DEFINITION_FIELDS.map((field) => [field, (raw[field] ?? null) as Json])));
    }
    return out;
  }

  private async schedule(command: "pause" | "resume" | "delete", id: string): Promise<void> {
    const result = await this.cli.run(["schedule", command, id, "--json"]);
    if (result.code !== 0) throw new Error(`paseo schedule ${command} : ${cliError(result)}`);
  }

  async apply(changes: Change[]): Promise<ApplyOutcome[]> {
    const outcomes: ApplyOutcome[] = [];
    for (const change of changes) {
      const id = change.key.slice(KEY_PREFIX.schedule.length);
      const file = path.join(this.dir, `${id}.json`);
      try {
        if (!SCHEDULE_ID.test(id)) throw new Error("identifiant de planification refusé");
        if (change.value === null) {
          if (existsSync(file)) await this.schedule("delete", id);
          outcomes.push({ key: change.key, error: null });
          continue;
        }
        const wanted = change.value as Record<string, Json>;
        const target = wanted.target as { config?: { cwd?: string } } | null;
        const cwd = target?.config?.cwd;
        if (cwd && !existsSync(cwd)) throw new Error(`dossier de travail absent ici : ${cwd}`);
        const now = new Date().toISOString();
        const previous = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : null;
        const next: Record<string, unknown> = {
          id,
          createdAt: now,
          nextRunAt: null,
          lastRunAt: null,
          pausedAt: null,
          runs: [],
          ...previous,
          ...Object.fromEntries(DEFINITION_FIELDS.map((field) => [field, wanted[field] ?? null])),
          updatedAt: now,
        };
        writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`, 0o644);
        // Le daemon recalcule la prochaine exécution à la reprise ; une planification en pause y reste.
        if (wanted.status === "active") {
          await this.schedule("pause", id).catch(() => undefined);
          await this.schedule("resume", id);
        } else if (previous?.status === "active") {
          await this.schedule("pause", id);
        }
        outcomes.push({ key: change.key, error: null });
      } catch (error) {
        outcomes.push({ key: change.key, error: describe(error) });
      }
    }
    return outcomes;
  }
}
