import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCOPE, keyInScope, type GroupScope } from "../shared/model";
import { JsonKeysCollector, SchedulesCollector, setPath } from "../server/collectors-extra";

const temp = (name: string) => mkdtempSync(path.join(tmpdir(), `psync-${name}-`));

describe("clés de fichiers JSON", () => {
  const scope: GroupScope = {
    ...DEFAULT_SCOPE,
    json: { enabled: true, entries: [{ id: "claude-mcp", file: "~/.claude.json", path: "mcpServers" }] },
  };

  it("copie les serveurs MCP sans toucher au reste du fichier", async () => {
    const homeA = temp("json-a");
    const homeB = temp("json-b");
    writeFileSync(path.join(homeA, ".claude.json"), JSON.stringify({ projects: { "/a": {} }, mcpServers: { linear: { type: "http", url: "https://x" } } }));
    writeFileSync(path.join(homeB, ".claude.json"), JSON.stringify({ projects: { "/b": { history: [1, 2] } }, numStartups: 7 }));
    const a = new JsonKeysCollector(homeA);
    const b = new JsonKeysCollector(homeB);
    const snapshot = await a.snapshot(scope);
    expect(snapshot.get("json/claude-mcp")).toEqual({ linear: { type: "http", url: "https://x" } });

    await b.snapshot(scope);
    const [outcome] = await b.apply([{ key: "json/claude-mcp", value: snapshot.get("json/claude-mcp")! }]);
    expect(outcome!.error).toBeNull();
    const written = JSON.parse(readFileSync(path.join(homeB, ".claude.json"), "utf8"));
    expect(written).toEqual({ projects: { "/b": { history: [1, 2] } }, numStartups: 7, mcpServers: { linear: { type: "http", url: "https://x" } } });

    await b.apply([{ key: "json/claude-mcp", value: null }]);
    expect(JSON.parse(readFileSync(path.join(homeB, ".claude.json"), "utf8")).mcpServers).toBeUndefined();
  });

  it("un fichier illisible (en cours d'écriture) rend la clé incertaine, pas supprimée", async () => {
    const home = temp("json-c");
    writeFileSync(path.join(home, ".claude.json"), '{"mcpServers": {');
    const collector = new JsonKeysCollector(home);
    const snapshot = await collector.snapshot(scope);
    expect(snapshot.has("json/claude-mcp")).toBe(false);
    expect(collector.uncertain("json/claude-mcp")).toBe(true);
    expect(keyInScope(scope, "json/claude-mcp")).toBe(true);
    expect(keyInScope(scope, "json/autre")).toBe(false);
  });

  it("pose une clé imbriquée", () => {
    const root: Record<string, unknown> = { permissions: { deny: ["x"] } };
    setPath(root, "permissions.allow", ["Bash(ls)"]);
    expect(root).toEqual({ permissions: { deny: ["x"], allow: ["Bash(ls)"] } });
    expect(() => setPath({ a: 1 }, "a.b", 2)).toThrow(/pas un objet/);
  });
});

describe("planifications", () => {
  const scope: GroupScope = { ...DEFAULT_SCOPE, schedules: { enabled: true } };
  const schedule = (cwd: string, status = "active") => ({
    id: "a3d6201f",
    name: "rapport",
    prompt: "Fais le rapport",
    cadence: { type: "cron", expression: "0 * * * *" },
    target: { type: "new-agent", config: { provider: "claude", cwd } },
    status,
    createdAt: "2026-11-05T12:53:40.789Z",
    updatedAt: "2026-11-05T12:53:40.789Z",
    nextRunAt: "2026-11-05T13:00:00.000Z",
    lastRunAt: "2026-11-05T12:00:00.000Z",
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    runs: [{ at: "x" }],
  });

  function fakeCli() {
    const calls: string[][] = [];
    return { calls, cli: { run: async (args: string[]) => (calls.push(args), { code: 0, stdout: "{}", stderr: "" }) } };
  }

  it("ne partage que la définition, recrée la planification ailleurs et la relance", async () => {
    const homeA = temp("sched-a");
    const homeB = temp("sched-b");
    const cwd = temp("sched-cwd");
    mkdirSync(path.join(homeA, "schedules"));
    writeFileSync(path.join(homeA, "schedules", "a3d6201f.json"), JSON.stringify(schedule(cwd)));
    const a = new SchedulesCollector(fakeCli().cli, homeA);
    const snapshot = await a.snapshot(scope);
    const value = snapshot.get("schedule/a3d6201f") as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(["cadence", "expiresAt", "maxRuns", "name", "prompt", "status", "target"]);

    const { cli, calls } = fakeCli();
    const b = new SchedulesCollector(cli, homeB);
    const [outcome] = await b.apply([{ key: "schedule/a3d6201f", value: value as never }]);
    expect(outcome!.error).toBeNull();
    const written = JSON.parse(readFileSync(path.join(homeB, "schedules", "a3d6201f.json"), "utf8"));
    expect(written).toMatchObject({ id: "a3d6201f", prompt: "Fais le rapport", runs: [], lastRunAt: null });
    expect(calls).toEqual([
      ["schedule", "pause", "a3d6201f", "--json"],
      ["schedule", "resume", "a3d6201f", "--json"],
    ]);
    // Même définition des deux côtés : rien à resynchroniser.
    expect((await b.snapshot(scope)).get("schedule/a3d6201f")).toEqual(value);

    await b.apply([{ key: "schedule/a3d6201f", value: null }]);
    expect(calls.at(-1)).toEqual(["schedule", "delete", "a3d6201f", "--json"]);
  });

  it("refuse un dossier de travail absent, et une planification terminée n'est pas une suppression", async () => {
    const home = temp("sched-c");
    const { cli } = fakeCli();
    const collector = new SchedulesCollector(cli, home);
    const value = { ...schedule("/nulle/part"), runs: undefined };
    const [outcome] = await collector.apply([{ key: "schedule/a3d6201f", value: value as never }]);
    expect(outcome!.error).toMatch(/absent ici/);
    expect(existsSync(path.join(home, "schedules", "a3d6201f.json"))).toBe(false);

    mkdirSync(path.join(home, "schedules"));
    writeFileSync(path.join(home, "schedules", "a3d6201f.json"), JSON.stringify(schedule(home, "completed")));
    const snapshot = await collector.snapshot(scope);
    expect(snapshot.size).toBe(0);
    expect(collector.uncertain("schedule/a3d6201f")).toBe(true);
  });
});
