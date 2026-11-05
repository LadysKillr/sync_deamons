import { SELF_PLUGIN_ID, matchesExclusion, pluginInScope, KEY_PREFIX, type GroupScope } from "../shared/model";
import { cliError, parseJsonOutput, runJson, type PaseoCli } from "./cli";
import type { GroupState } from "./store";

/**
 * Suivi des mises à jour des plugins (option `autoUpdatePlugins` du groupe). Une seule machine s'en charge, la
 * « meneuse » : la machine de plus petit identifiant parmi celles vues récemment qui publient (pas « reçoit
 * seulement ») et qui savent le faire (comptes rendus 0.2.0 et plus). Elle vérifie les nouvelles versions des plugins
 * du groupe et les installe ; la détection des changements les publie, et le reste du groupe suit.
 */

export const CHECK_EVERY_MS = 6 * 3600_000;
/** Une machine pas vue depuis plus longtemps ne peut pas mener. */
export const LEADER_FRESHNESS_MS = 2 * 24 * 3600_000;
const LOG_MAX = 15;

export interface UpdateCheck {
  id: string;
  outcome: string;
  current?: { currentRevision?: string };
  target?: { commit?: string; version?: string };
  error?: string;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function updateLeader(group: GroupState, selfId: string, now: number): string | null {
  const candidates = Object.entries(group.members)
    .filter(([nodeId, member]) => {
      if (nodeId === selfId) return group.mode !== "receive";
      const report = group.reports[nodeId];
      return report !== undefined && report.mode !== "receive" && now - member.seenAt < LEADER_FRESHNESS_MS;
    })
    .map(([nodeId]) => nodeId)
    .sort();
  return candidates[0] ?? null;
}

/** Les plugins à mettre à jour pour ce groupe sur cette machine, d'après la vérification. */
export function updatesFor(group: GroupState, scope: GroupScope, checks: UpdateCheck[], owns: (key: string) => boolean): UpdateCheck[] {
  if (!scope.plugins.enabled) return [];
  return checks.filter((check) => {
    const key = `${KEY_PREFIX.plugin}${check.id}`;
    return (
      check.outcome === "update" &&
      check.id !== SELF_PLUGIN_ID &&
      pluginInScope(scope, check.id) &&
      owns(key) &&
      !matchesExclusion(group.exclude, key)
    );
  });
}

export class PluginUpdater {
  private cache: { at: number; checks: UpdateCheck[] } | null = null;

  constructor(
    private readonly cli: PaseoCli,
    private readonly log: (line: string) => void,
  ) {}

  /** `plugin update --all --check`, gardé 10 min (plusieurs groupes la demandent au même passage). */
  async check(now: number): Promise<UpdateCheck[]> {
    if (this.cache && now - this.cache.at < 10 * 60_000) return this.cache.checks;
    // Lu tel quel : la vérification d'un plugin peut échouer (dépôt injoignable) sans empêcher celle des autres.
    const result = await this.cli.run(["plugin", "update", "--all", "--check", "--json"]);
    let checks: UpdateCheck[];
    try {
      const parsed = parseJsonOutput(result.stdout);
      if (!Array.isArray(parsed)) throw new Error(cliError(result));
      checks = parsed as UpdateCheck[];
    } catch (error) {
      throw new Error(`vérification des mises à jour : ${result.code !== 0 ? cliError(result) : describe(error)}`);
    }
    this.cache = { at: now, checks };
    return checks;
  }

  /** Met à jour, un plugin à la fois ; note chaque résultat dans le journal du groupe. */
  async apply(group: GroupState, updates: UpdateCheck[], now: number): Promise<number> {
    let done = 0;
    for (const update of updates) {
      const from = update.current?.currentRevision ?? null;
      const to = update.target?.commit ?? update.target?.version ?? null;
      try {
        await runJson(this.cli, ["plugin", "update", update.id, "--yes"]);
        this.log(`plugin ${update.id} mis à jour : ${from ?? "?"} -> ${to ?? "?"}`);
        group.updateLog.unshift({ id: update.id, from, to, at: now, error: null });
        done += 1;
      } catch (error) {
        group.updateLog.unshift({ id: update.id, from, to, at: now, error: describe(error) });
      }
    }
    if (group.updateLog.length > LOG_MAX) group.updateLog.length = LOG_MAX;
    this.cache = null;
    return done;
  }
}
