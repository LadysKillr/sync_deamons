import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCOPE, type GroupScope } from "../shared/model";
import { FilesCollector, safeRelative } from "../server/collectors";

const scope: GroupScope = {
  ...DEFAULT_SCOPE,
  files: {
    enabled: true,
    sets: [
      { id: "skills", path: "~/.claude/skills" },
      { id: "claude-md", path: "~/.claude/CLAUDE.md" },
    ],
  },
};

describe("fichiers", () => {
  it("copie dossiers et fichier seul d'une machine à l'autre, suppressions comprises", async () => {
    const homeA = mkdtempSync(path.join(tmpdir(), "psync-home-a-"));
    const homeB = mkdtempSync(path.join(tmpdir(), "psync-home-b-"));
    mkdirSync(path.join(homeA, ".claude/skills/review/node_modules"), { recursive: true });
    writeFileSync(path.join(homeA, ".claude/skills/review/SKILL.md"), "# Review");
    writeFileSync(path.join(homeA, ".claude/skills/review/run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(homeA, ".claude/skills/review/node_modules/x.js"), "ignoré");
    writeFileSync(path.join(homeA, ".claude/CLAUDE.md"), "Réponds en français.");

    const a = new FilesCollector(() => undefined, homeA);
    const b = new FilesCollector(() => undefined, homeB);
    const snapshot = await a.snapshot(scope);
    expect([...snapshot.keys()].sort()).toEqual(["file/claude-md/CLAUDE.md", "file/skills/review/SKILL.md", "file/skills/review/run.sh"]);

    await b.snapshot(scope);
    const outcomes = await b.apply([...snapshot].map(([key, value]) => ({ key, value })));
    expect(outcomes.every((outcome) => outcome.error === null)).toBe(true);
    expect(readFileSync(path.join(homeB, ".claude/skills/review/SKILL.md"), "utf8")).toBe("# Review");
    expect(readFileSync(path.join(homeB, ".claude/CLAUDE.md"), "utf8")).toBe("Réponds en français.");
    expect(statSync(path.join(homeB, ".claude/skills/review/run.sh")).mode & 0o777).toBe(0o755);
    expect(existsSync(path.join(homeB, ".claude/skills/review/node_modules"))).toBe(false);

    await b.apply([{ key: "file/skills/review/run.sh", value: null }]);
    expect(existsSync(path.join(homeB, ".claude/skills/review/run.sh"))).toBe(false);
  });

  it("refuse de sortir de l'ensemble", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "psync-home-c-"));
    const collector = new FilesCollector(() => undefined, home);
    await collector.snapshot(scope);
    const [outcome] = await collector.apply([{ key: "file/skills/../../.ssh/authorized_keys", value: { b64: "", mode: 0o600 } }]);
    expect(outcome?.error).toMatch(/refusé/);
    expect(safeRelative("a/../b")).toBe(false);
    expect(safeRelative("a/b.md")).toBe(true);
  });
});

import { mergeMembers, pruneMembers } from "../server/replica";

describe("membres", () => {
  it("ignore et nettoie les membres sans adresse", () => {
    const members = { n1: { label: "a", url: "http://100.64.0.1:6780", seenAt: 1 }, ghost: { label: "check", url: "", seenAt: 2 } };
    pruneMembers(members, 3, "n1");
    expect(Object.keys(members)).toEqual(["n1"]);
    mergeMembers(members, { ghost2: { label: "check", url: "", seenAt: 5 } });
    expect(Object.keys(members)).toEqual(["n1"]);
  });
});
