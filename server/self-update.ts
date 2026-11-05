import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { SELF_KEY, SELF_PLUGIN_ID, compareVersions, type GroupScope } from "../shared/model";
import { SYNC_VERSION } from "../shared/version";
import { parseJsonOutput, type PaseoCli } from "./cli";
import { pluginValueOf, type ApplyOutcome, type Change, type Collector, type PluginValue, type RawPlugin } from "./collectors";
import type { Json } from "./replica";

/**
 * Mise à jour de Sync lui-même. La version installée ici est un élément du groupe (`self/sync`) quand la portée a
 * `selfUpdate`. Quand le groupe en annonce une autre :
 * - une version plus ancienne que celle qui tourne ici est refusée, et celle d'ici repart (`preferLocal`) ;
 * - sinon, `paseo plugin update sync` est lancé dans un processus détaché, quelques secondes plus tard : la mise à
 *   jour arrête Sync, qui doit d'abord finir son passage et enregistrer son état. Au redémarrage, la nouvelle version
 *   relève sa révision, identique à celle du groupe : l'élément est appliqué.
 */

export type SelfValue = PluginValue & { version: string };

export const SELF_UPDATE_DELAY_MS = 3000;

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface SelfUpdateDeps {
  cli: PaseoCli;
  /** `plugin ls`, partagé avec le collecteur des plugins. */
  list: () => Promise<RawPlugin[]>;
  paseoHome: string;
  dataDir: string;
  log: (line: string) => void;
  /** Version du code qui tourne (injectable pour les tests). */
  version?: string;
  /** Lance la commande de mise à jour, détachée (injectable pour les tests). */
  launch?: (args: string[]) => void;
}

export class SelfCollector implements Collector {
  readonly name = "self";

  constructor(private readonly deps: SelfUpdateDeps) {}

  /** Version du code qui tourne : lue à chaque fois (les tests simulent un redémarrage dans une autre version). */
  private get version(): string {
    return this.deps.version ?? SYNC_VERSION;
  }

  private get logFile(): string {
    return path.join(this.deps.dataDir, "self-update.log");
  }

  owns(key: string): boolean {
    return key === SELF_KEY;
  }

  async snapshot(scope: GroupScope): Promise<Map<string, Json>> {
    const out = new Map<string, Json>();
    if (!scope.selfUpdate) return out;
    const raw = (await this.deps.list()).find((plugin) => plugin.id === SELF_PLUGIN_ID);
    const value = raw ? pluginValueOf(raw) : null;
    // Sync installé depuis un dossier local (développement) : rien de reproductible ailleurs.
    if (value) out.set(SELF_KEY, { ...value, enabled: true, version: this.version } as unknown as Json);
    return out;
  }

  preferLocal(_key: string, local: Json, group: Json): boolean {
    const mine = (local as unknown as SelfValue | null)?.version;
    const theirs = (group as unknown as SelfValue | null)?.version;
    return typeof mine === "string" && typeof theirs === "string" && compareVersions(mine, theirs) > 0;
  }

  /** Dernière erreur de la mise à jour détachée précédente, s'il y en a une. */
  private lastFailure(): string | null {
    if (!existsSync(this.logFile)) return null;
    try {
      const raw = readFileSync(this.logFile, "utf8");
      const parsed = parseJsonOutput(raw) as Array<{ outcome?: string; error?: string }> | { error?: { userMessage?: string; message?: string } };
      if (Array.isArray(parsed)) return parsed.find((item) => item.outcome === "error")?.error ?? null;
      return parsed.error?.userMessage ?? parsed.error?.message ?? null;
    } catch {
      return null;
    }
  }

  private launch(args: string[]): void {
    if (this.deps.launch) return this.deps.launch(args);
    const output = openSync(this.logFile, "w", 0o600);
    // Détaché : la commande survit à l'arrêt de Sync par la mise à jour.
    const child = spawn(process.env.PASEO_SYNC_CLI ?? "paseo", [...args, "--json", "--home", this.deps.paseoHome], {
      detached: true,
      stdio: ["ignore", output, output],
      env: { ...process.env, PASEO_HOME: this.deps.paseoHome, NO_COLOR: "1" },
    });
    child.unref();
    closeSync(output);
  }

  async apply(changes: Change[]): Promise<ApplyOutcome[]> {
    const outcomes: ApplyOutcome[] = [];
    for (const change of changes) {
      try {
        const wanted = change.value as unknown as SelfValue | null;
        if (wanted === null) throw new Error("Sync ne se désinstalle pas par synchronisation");
        if (compareVersions(wanted.version, this.version) < 0) {
          throw new Error(`version ${wanted.version} plus ancienne que celle d'ici (${this.version}) : ignorée`);
        }
        const raw = (await this.deps.list()).find((plugin) => plugin.id === SELF_PLUGIN_ID);
        const have = raw ? pluginValueOf(raw) : null;
        if (!have) throw new Error("Sync est installé ici depuis un dossier local : mise à jour manuelle");
        if (have.kind !== wanted.kind || have.source !== wanted.source || have.pluginPath !== wanted.pluginPath) {
          throw new Error(`Sync vient ici d'une autre source (${have.source}) : mise à jour manuelle`);
        }
        if (have.revision === wanted.revision) {
          outcomes.push({ key: change.key, error: null });
          continue;
        }
        const previous = this.lastFailure();
        const args = have.registry
          ? ["plugin", "update", SELF_PLUGIN_ID, "--yes"]
          : wanted.kind === "git"
            ? ["plugin", "update", SELF_PLUGIN_ID, "--ref", wanted.revision]
            : ["plugin", "update", SELF_PLUGIN_ID, "--version", wanted.revision];
        this.deps.log(`mise à jour de Sync : ${have.revision.slice(0, 12)} -> ${wanted.revision.slice(0, 12)} (${wanted.version}), dans ${SELF_UPDATE_DELAY_MS / 1000} s`);
        setTimeout(() => {
          try {
            this.launch(args);
          } catch (error) {
            this.deps.log(`mise à jour de Sync impossible : ${describe(error)}`);
          }
        }, SELF_UPDATE_DELAY_MS).unref?.();
        // Une tentative précédente a échoué : on le dit, tout en réessayant.
        outcomes.push(previous ? { key: change.key, error: `tentative précédente : ${previous}` } : { key: change.key, error: null, deferred: true });
      } catch (error) {
        outcomes.push({ key: change.key, error: describe(error) });
      }
    }
    return outcomes;
  }
}
