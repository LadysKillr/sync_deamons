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

  it("ne relève jamais un fichier en cours d'écriture (temporaire puis renommage)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "psync-home-d-"));
    const dir = path.join(home, "partage");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "0000000000000001.json"), "{}", { mode: 0o600 });
    for (const name of [".0000000000000001.4242.tmp", "a.json.sync-99.tmp", "notes.md~", ".notes.md.swp"]) writeFileSync(path.join(dir, name), "x");
    const collector = new FilesCollector(() => undefined, home);
    const snapshot = await collector.snapshot({ ...DEFAULT_SCOPE, files: { enabled: true, sets: [{ id: "partage", path: "~/partage" }] } });
    expect([...snapshot.keys()]).toEqual(["file/partage/0000000000000001.json"]);
  });

  it("un fichier privé (0600) arrive dans des dossiers créés en 0700 ; un fichier ordinaire garde les droits par défaut", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "psync-home-e-"));
    const sets = [
      { id: "prive", path: "~/.paseo/plugin-data/relais/spend" },
      { id: "public", path: "~/notes" },
    ];
    const collector = new FilesCollector(() => undefined, home);
    await collector.snapshot({ ...DEFAULT_SCOPE, files: { enabled: true, sets } });
    const outcomes = await collector.apply([
      { key: "file/prive/0000000000000002.json", value: { b64: Buffer.from("{}").toString("base64"), mode: 0o600 } },
      { key: "file/public/a/b.md", value: { b64: Buffer.from("# b").toString("base64"), mode: 0o644 } },
    ]);
    expect(outcomes.every((outcome) => outcome.error === null)).toBe(true);
    expect(statSync(path.join(home, ".paseo/plugin-data/relais/spend")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(home, ".paseo/plugin-data/relais/spend/0000000000000002.json")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(home, "notes/a")).mode & 0o077).not.toBe(0);
  });
});

import { mergeMembers, pruneMembers } from "../server/replica";

describe("fichiers incertains", () => {
  it("note incertain un fichier trop gros et ignore les noms temporaires", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "psync-home-d-"));
    mkdirSync(path.join(home, ".claude/skills"), { recursive: true });
    writeFileSync(path.join(home, ".claude/skills/gros.bin"), Buffer.alloc(5 * 1024 * 1024));
    writeFileSync(path.join(home, ".claude/skills/ok.md"), "ok");
    const collector = new FilesCollector(() => undefined, home);
    const snapshot = await collector.snapshot(scope);
    expect(snapshot.has("file/skills/ok.md")).toBe(true);
    expect(snapshot.has("file/skills/gros.bin")).toBe(false);
    expect(collector.uncertain("file/skills/gros.bin")).toBe(true);
    expect(collector.uncertain("file/skills/ok.md")).toBe(false);
    expect(collector.ignores("file/skills/notes.tmp")).toBe(true);
    expect(collector.ignores("file/skills/dossier.sync-1/a.md")).toBe(true);
    expect(collector.ignores("file/skills/ok.md")).toBe(false);
  });
});

describe("membres : clé publique", () => {
  it("une copie relayée sans clé publique ne l'efface pas, et sa propre fiche ne vient jamais d'ailleurs", () => {
    const members = {
      n_a: { label: "a", url: "http://a:6780", seenAt: 1, pub: "PUB_A" },
      n_self: { label: "moi", url: "http://moi:6780", seenAt: 1, pub: "PUB_SELF" },
    };
    mergeMembers(members, { n_a: { label: "a", url: "http://a:6780", seenAt: 5 }, n_self: { label: "moi", url: "http://moi:6780", seenAt: 9 } }, "n_self");
    expect(members.n_a).toEqual({ label: "a", url: "http://a:6780", seenAt: 5, pub: "PUB_A" });
    expect(members.n_self.seenAt).toBe(1);
  });
});

describe("membres", () => {
  it("ignore et nettoie les membres sans adresse", () => {
    const members = { n1: { label: "a", url: "http://100.64.0.1:6780", seenAt: 1 }, ghost: { label: "check", url: "", seenAt: 2 } };
    pruneMembers(members, 3, "n1");
    expect(Object.keys(members)).toEqual(["n1"]);
    mergeMembers(members, { ghost2: { label: "check", url: "", seenAt: 5 } });
    expect(Object.keys(members)).toEqual(["n1"]);
  });
});

import { readFileSync as readText } from "node:fs";
import { SYNC_VERSION } from "../shared/version";
import { compareVersions } from "../shared/model";

describe("version", () => {
  it("la version annoncée par Sync est celle de package.json", () => {
    const pkg = JSON.parse(readText(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(SYNC_VERSION).toBe(pkg.version);
  });
  it("compare les versions", () => {
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-beta")).toBe(0);
    expect(compareVersions("0.3.1", "0.3.0")).toBeGreaterThan(0);
  });
});

import { isDaemonNotReady as notReady } from "../server/cli";

describe("daemon pas prêt", () => {
  it("reconnaît les messages du CLI quand le daemon démarre, et seulement ceux-là", () => {
    expect(notReady(new Error("paseo plugin ls : Daemon is not running. Start with: paseo daemon start"))).toBe(true);
    expect(notReady("paseo plugin install : connect ECONNREFUSED 127.0.0.1:6767")).toBe(true);
    expect(notReady(new Error("paseo plugin install : npm ci failed: EPERM: operation not permitted"))).toBe(false);
    expect(notReady(new Error("plugin is not running"))).toBe(false);
  });
});
