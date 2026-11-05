import { describe, expect, it } from "vitest";
import { DEFAULT_SCOPE } from "../shared/model";
import { PluginUpdater, updateLeader, updatesFor, type UpdateCheck } from "../server/plugin-updates";
import { newGroupState, type GroupState } from "../server/store";
import type { Report } from "../server/replica";

const now = 1_800_000_000_000;
const report = (mode: Report["mode"]): Report => ({
  at: now,
  digest: "d",
  version: "0.2.0",
  mode,
  applied: 0,
  pendingTotal: 0,
  pending: [],
  errors: {},
  excluded: [],
  awaiting: [],
  conflicts: [],
});

function group(): GroupState {
  const state = newGroupState({ id: "g", name: "g", key: "", mode: "both", peers: [], now });
  state.members = {
    n_b: { label: "b", url: "http://b", seenAt: now },
    n_a: { label: "a", url: "http://a", seenAt: now },
    n_0: { label: "vieux", url: "http://0", seenAt: now - 3 * 24 * 3600_000 },
    n_1: { label: "suiveur", url: "http://1", seenAt: now },
  };
  state.reports = { n_a: report("both"), n_b: report("both"), n_0: report("both"), n_1: report("receive") };
  return state;
}

describe("mises à jour des plugins", () => {
  it("une seule machine mène : la plus petite, récente, qui publie", () => {
    const state = group();
    // n_0 n'est plus vue depuis 3 jours, n_1 ne fait que recevoir : n_a mène.
    expect(updateLeader(state, "n_b", now)).toBe("n_a");
    expect(updateLeader(state, "n_a", now)).toBe("n_a");
    // Une machine sans compte rendu (ancienne version) ne mène pas.
    delete state.reports.n_a;
    expect(updateLeader(state, "n_b", now)).toBe("n_b");
  });

  it("ne garde que les plugins du groupe, gérés ici et non exclus", () => {
    const state = group();
    state.exclude = ["plugin/exclu"];
    const checks: UpdateCheck[] = [
      { id: "kanban", outcome: "update" },
      { id: "canvas", outcome: "current" },
      { id: "exclu", outcome: "update" },
      { id: "autre-groupe", outcome: "update" },
      { id: "sync", outcome: "update" },
    ];
    const scope = { ...DEFAULT_SCOPE, autoUpdatePlugins: true };
    const ids = updatesFor(state, scope, checks, (key) => key !== "plugin/autre-groupe").map((check) => check.id);
    expect(ids).toEqual(["kanban"]);
    expect(updatesFor(state, { ...scope, plugins: { enabled: true, mode: "include", ids: ["canvas"] } }, checks, () => true)).toEqual([]);
  });

  it("lit la vérification même si un plugin échoue, et note chaque mise à jour", async () => {
    const calls: string[][] = [];
    const cli = {
      run: async (args: string[]) => {
        calls.push(args);
        if (args.includes("--check")) {
          return {
            code: 1,
            stderr: "",
            stdout: JSON.stringify([
              { id: "kanban", outcome: "update", current: { currentRevision: "0.3.2" }, target: { version: "0.4.0" } },
              { id: "casse", outcome: "error", error: "dépôt injoignable" },
            ]),
          };
        }
        return { code: 0, stderr: "", stdout: JSON.stringify([{ id: "kanban", outcome: "updated" }]) };
      },
    };
    const updater = new PluginUpdater(cli, () => undefined);
    const checks = await updater.check(now);
    expect(checks.map((check) => check.id)).toEqual(["kanban", "casse"]);
    const state = group();
    expect(await updater.apply(state, [checks[0]!], now)).toBe(1);
    expect(state.updateLog[0]).toEqual({ id: "kanban", from: "0.3.2", to: "0.4.0", at: now, error: null });
    expect(calls.at(-1)).toEqual(["plugin", "update", "kanban", "--yes", "--json"]);
  });
});
