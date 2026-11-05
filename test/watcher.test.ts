import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChangeWatcher, watchTargets } from "../server/watcher";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("détection des changements", () => {
  it("regroupe les écritures, ignore les temporaires et ses propres applications", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "psync-watch-"));
    mkdirSync(path.join(home, "plugins"));
    writeFileSync(path.join(home, "config.json"), "{}");
    let calls = 0;
    let paused = false;
    const watcher = new ChangeWatcher(() => (calls += 1), { debounceMs: 150, paused: () => paused });
    watcher.update(watchTargets(home, []));
    await wait(50);

    // Plusieurs écritures d'affilée : un seul passage.
    writeFileSync(path.join(home, "config.json"), '{"a":1}');
    mkdirSync(path.join(home, "plugin-settings", "kanban"), { recursive: true });
    writeFileSync(path.join(home, "plugin-settings", "kanban", "config.json"), "{}");
    await wait(400);
    expect(calls).toBe(1);

    // Un fichier qui n'est pas suivi dans le dossier du daemon : rien.
    writeFileSync(path.join(home, "daemon.log"), "x");
    writeFileSync(path.join(home, "plugins", "autre.txt"), "x");
    await wait(400);
    expect(calls).toBe(1);

    // Pendant une application de Sync : ignoré.
    paused = true;
    writeFileSync(path.join(home, "config.json"), '{"a":2}');
    await wait(400);
    expect(calls).toBe(1);

    paused = false;
    writeFileSync(path.join(home, "plugins", "sources.json"), "{}");
    await wait(400);
    expect(calls).toBe(2);
    watcher.close();
  });
});
