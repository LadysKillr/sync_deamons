import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../server/store";
import { resolveListenHost } from "../server/transport";

const oldState = (listenHost: string) =>
  JSON.stringify({
    version: 1,
    node: { nodeId: "n_x", label: "srv", listenHost, port: 6780, advertiseUrl: null, intervalSec: 30 },
    groups: [],
  });

describe("passage à 0.2.0", () => {
  it("l'ancien défaut d'écoute devient « auto », une adresse choisie est gardée, la paire de clés est créée", () => {
    for (const [before, after] of [
      ["0.0.0.0", "auto"],
      ["100.72.0.9", "100.72.0.9"],
    ] as const) {
      const dir = mkdtempSync(path.join(tmpdir(), "psync-store-"));
      writeFileSync(path.join(dir, "state.json"), oldState(before));
      const store = new Store(dir);
      expect(store.data.node.listenHost).toBe(after);
      expect(store.data.node.identity?.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Passage de 30 s d'avant la détection des changements : devient le secours de 10 min.
      expect(store.data.node.intervalSec).toBe(600);
      // Relu tel quel ensuite (la migration ne se refait pas).
      expect(new Store(dir).data.node.identity).toEqual(store.data.node.identity);
    }
  });

  it("une adresse précise n'est pas réinterprétée", () => {
    expect(resolveListenHost("127.0.0.1")).toBe("127.0.0.1");
    expect(["0.0.0.0"].includes(resolveListenHost("auto")) || resolveListenHost("auto").startsWith("100.")).toBe(true);
  });
});
