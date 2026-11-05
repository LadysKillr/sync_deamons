import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCOPE, KEY_PREFIX, keyInScope, type GroupScope } from "../shared/model";
import type { ApplyOutcome, Change, Collector } from "../server/collectors";
import { aad, deriveMasterKey, groupKeys, open, seal, type GroupKeys } from "../server/crypto";
import { Engine } from "../server/engine";
import { HybridClock, mergeEntries, type Entries, type Json } from "../server/replica";
import { Store, newGroupState } from "../server/store";
import { RequestSchema, ResponseSchema, sendRequest, startServer, type SyncRequest, type SyncResponse } from "../server/transport";

/** Collecteur en mémoire : un dictionnaire de clés « plugin/… », « config/… ». */
class MemoryCollector implements Collector {
  readonly name = "memory";
  state = new Map<string, Json>();
  failNext = new Set<string>();
  owns(): boolean {
    return true;
  }
  async snapshot(scope: GroupScope): Promise<Map<string, Json>> {
    return new Map([...this.state].filter(([key]) => keyInScope(scope, key)));
  }
  async apply(changes: Change[]): Promise<ApplyOutcome[]> {
    return changes.map(({ key, value }) => {
      if (this.failNext.delete(key)) return { key, error: "échec simulé" };
      if (value === null) this.state.delete(key);
      else this.state.set(key, value);
      return { key, error: null };
    });
  }
}

let wall = 1_800_000_000_000;
const tick = () => (wall += 1000);

interface Node {
  engine: Engine;
  memory: MemoryCollector;
  url: string;
}

function makeNode(name: string, network: Map<string, Node>): Node {
  const store = new Store(mkdtempSync(path.join(tmpdir(), `psync-${name}-`)));
  store.data.node.label = name;
  const memory = new MemoryCollector();
  const url = `http://${name}.test:6780`;
  // L'envoi passe vraiment par le chiffrement, comme sur le réseau.
  const send = async (target: string, keys: GroupKeys, request: SyncRequest): Promise<SyncResponse> => {
    const peer = network.get(target);
    if (!peer) throw new Error("injoignable");
    const envelope = seal(keys, request, aad("req", keys.groupId));
    const group = peer.engine.store.group(envelope.g);
    if (!group) throw new Error("groupe inconnu");
    const peerKeys = peer.engine.keys(group);
    const opened = RequestSchema.parse(open(peerKeys, envelope, aad("req", peerKeys.groupId)));
    const response = await peer.engine.handleIncoming(envelope.g, opened);
    const sealed = seal(peerKeys, response, aad("res", peerKeys.groupId, envelope.n));
    return ResponseSchema.parse(open(keys, sealed, aad("res", keys.groupId, envelope.n)));
  };
  const engine = new Engine({ store, collectors: [memory], send, selfUrl: () => url, log: () => undefined, clock: new HybridClock(() => wall) });
  const node = { engine, memory, url };
  network.set(url, node);
  return node;
}

let cachedMaster: Buffer | null = null;
async function addGroup(node: Node, peers: string[], options: { create: boolean }) {
  cachedMaster ??= await deriveMasterKey("motdepasse-solide", "Travail");
  const { groupId } = groupKeys(cachedMaster);
  const group = newGroupState({ id: groupId, name: "Travail", key: cachedMaster.toString("base64"), mode: "both", peers, now: wall });
  node.engine.store.data.groups.push(group);
  if (options.create) node.engine.setScope(group, DEFAULT_SCOPE);
  return groupId;
}

async function rounds(nodes: Node[], groupId: string, count = 2) {
  for (let i = 0; i < count; i += 1) {
    for (const node of nodes) {
      tick();
      await node.engine.run(groupId);
    }
  }
}

const plugin = (revision: string, enabled = true): Json => ({ kind: "git", source: "https://x/y.git", pluginPath: ".", registry: null, revision, enabled });

describe("crypto", () => {
  it("chiffre, authentifie et refuse un autre mot de passe", async () => {
    const a = groupKeys(await deriveMasterKey("secret-1234", "Perso"));
    const b = groupKeys(await deriveMasterKey("secret-1234", "  perso "));
    const c = groupKeys(await deriveMasterKey("autre-secret", "Perso"));
    expect(a.groupId).toBe(b.groupId);
    expect(c.groupId).not.toBe(a.groupId);
    const envelope = seal(a, { hello: "monde" }, aad("req", a.groupId));
    expect(open(b, envelope, aad("req", b.groupId))).toEqual({ hello: "monde" });
    expect(open(c, { ...envelope, g: c.groupId }, aad("req", c.groupId))).toBeNull();
    // Une requête rejouée comme réponse ne s'ouvre pas.
    expect(open(a, envelope, aad("res", a.groupId, envelope.n))).toBeNull();
    expect(JSON.stringify(envelope)).not.toContain("monde");
  });
});

describe("fusion", () => {
  it("est commutative et idempotente", () => {
    const x: Entries = { k: { v: 1, h: "a", t: 5, o: "n1" }, j: { v: 2, h: "b", t: 1, o: "n1" } };
    const y: Entries = { k: { v: 3, h: "c", t: 5, o: "n2" }, j: { v: null, h: "deleted", t: 2, o: "n2" } };
    const left = structuredClone(x);
    mergeEntries(left, y);
    const right = structuredClone(y);
    mergeEntries(right, x);
    expect(left).toEqual(right);
    expect(mergeEntries(left, y)).toEqual([]);
    expect(left.k!.v).toBe(3);
    expect(left.j!.v).toBeNull();
  });
});

describe("moteur", () => {
  it("synchronise dans les deux sens entre trois machines, suppressions comprises", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    const c = makeNode("c", network);
    a.memory.state.set(`${KEY_PREFIX.plugin}kanban`, plugin("1.0.0"));
    a.memory.state.set(`${KEY_PREFIX.config}agents`, { providers: { codex: { enabled: false } } });
    b.memory.state.set(`${KEY_PREFIX.plugin}canvas`, plugin("abc"));

    const id = await addGroup(a, [], { create: true });
    await addGroup(b, [a.url], { create: false });
    // C ne connaît que B : il découvre A par la liste des membres.
    await addGroup(c, [b.url], { create: false });
    await rounds([a, b, c], id, 3);

    for (const node of [a, b, c]) {
      expect(node.memory.state.get(`${KEY_PREFIX.plugin}kanban`)).toEqual(plugin("1.0.0"));
      expect(node.memory.state.get(`${KEY_PREFIX.plugin}canvas`)).toEqual(plugin("abc"));
      expect(node.memory.state.get(`${KEY_PREFIX.config}agents`)).toEqual({ providers: { codex: { enabled: false } } });
    }
    expect(Object.keys(c.engine.store.group(id)!.members).sort()).toHaveLength(3);

    // Mise à jour sur C, suppression sur B.
    c.memory.state.set(`${KEY_PREFIX.plugin}kanban`, plugin("2.0.0", false));
    b.memory.state.delete(`${KEY_PREFIX.plugin}canvas`);
    await rounds([a, b, c], id, 3);
    for (const node of [a, b, c]) {
      expect(node.memory.state.get(`${KEY_PREFIX.plugin}kanban`)).toEqual(plugin("2.0.0", false));
      expect(node.memory.state.has(`${KEY_PREFIX.plugin}canvas`)).toBe(false);
    }
  });

  it("une machine qui rejoint adopte l'état du groupe au lieu de l'écraser", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    a.memory.state.set(`${KEY_PREFIX.plugin}kanban`, plugin("2.0.0"));
    b.memory.state.set(`${KEY_PREFIX.plugin}kanban`, plugin("1.0.0"));
    b.memory.state.set(`${KEY_PREFIX.plugin}local-only`, plugin("9"));
    const id = await addGroup(a, [], { create: true });
    await rounds([a], id, 1);
    tick();
    await addGroup(b, [a.url], { create: false });
    await rounds([b, a], id, 3);
    expect(b.memory.state.get(`${KEY_PREFIX.plugin}kanban`)).toEqual(plugin("2.0.0"));
    expect(a.memory.state.get(`${KEY_PREFIX.plugin}kanban`)).toEqual(plugin("2.0.0"));
    // Ce que B avait en plus rejoint le groupe.
    expect(a.memory.state.get(`${KEY_PREFIX.plugin}local-only`)).toEqual(plugin("9"));
  });

  it("respecte la portée du groupe et les groupes séparés", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    a.memory.state.set(`${KEY_PREFIX.plugin}jeu`, plugin("1"));
    a.memory.state.set(`${KEY_PREFIX.plugin}travail`, plugin("1"));
    const id = await addGroup(a, [], { create: true });
    const scope: GroupScope = { ...DEFAULT_SCOPE, plugins: { enabled: true, mode: "include", ids: ["travail"] } };
    a.engine.setScope(a.engine.store.group(id)!, scope);
    await addGroup(b, [a.url], { create: false });
    await rounds([a, b], id, 3);
    expect(b.memory.state.has(`${KEY_PREFIX.plugin}travail`)).toBe(true);
    expect(b.memory.state.has(`${KEY_PREFIX.plugin}jeu`)).toBe(false);
    expect(b.engine.scopeOf(b.engine.store.group(id)!)).toEqual(scope);
  });

  it("ne publie pas l'effet d'un échec et réessaie plus tard", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    const id = await addGroup(a, [], { create: true });
    await addGroup(b, [a.url], { create: false });
    await rounds([a, b], id, 2);
    a.memory.state.set(`${KEY_PREFIX.plugin}kanban`, plugin("1"));
    b.memory.failNext.add(`${KEY_PREFIX.plugin}kanban`);
    await rounds([a, b], id, 1);
    expect(b.memory.state.has(`${KEY_PREFIX.plugin}kanban`)).toBe(false);
    expect(b.engine.view(b.engine.store.group(id)!).problems).toHaveLength(1);
    // A garde sa valeur : l'échec de B n'a pas été publié comme une suppression.
    expect(a.memory.state.get(`${KEY_PREFIX.plugin}kanban`)).toEqual(plugin("1"));
    wall += 120_000;
    await rounds([b], id, 1);
    expect(b.memory.state.get(`${KEY_PREFIX.plugin}kanban`)).toEqual(plugin("1"));
    expect(b.engine.view(b.engine.store.group(id)!).problems).toHaveLength(0);
  });

  it("mode receive : ne publie rien, se range sur le groupe", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    a.memory.state.set(`${KEY_PREFIX.plugin}kanban`, plugin("1"));
    const id = await addGroup(a, [], { create: true });
    await addGroup(b, [a.url], { create: false });
    b.engine.store.group(id)!.mode = "receive";
    await rounds([a, b], id, 2);
    b.memory.state.set(`${KEY_PREFIX.plugin}kanban`, plugin("0-local"));
    await rounds([b, a], id, 2);
    expect(a.memory.state.get(`${KEY_PREFIX.plugin}kanban`)).toEqual(plugin("1"));
    expect(b.memory.state.get(`${KEY_PREFIX.plugin}kanban`)).toEqual(plugin("1"));
  });
});

describe("transport HTTP", () => {
  it("échange chiffré de bout en bout, refuse un mauvais mot de passe", async () => {
    const keys = groupKeys(await deriveMasterKey("motdepasse-solide", "Jeux"));
    const wrong = groupKeys(await deriveMasterKey("mauvais-mdp", "Jeux"));
    const server = await startServer(
      "127.0.0.1",
      0,
      {
        keysFor: (groupId) => (groupId === keys.groupId ? keys : null),
        handle: async (_groupId, request) => ({
          from: "srv",
          label: "serveur",
          url: "http://srv",
          ts: Date.now(),
          members: {},
          entries: (request.type === "pull" ? { x: { v: "ok", h: "h", t: 1, o: "srv" } } : {}) as Entries,
          versions: {},
        }),
      },
      () => undefined,
    );
    const url = `http://127.0.0.1:${server.address()!.port}`;
    const request: SyncRequest = { type: "pull", from: "cli", label: "client", url: "http://cli", ts: Date.now(), members: {}, versions: {} };
    const response = await sendRequest(url, keys, request);
    expect(response.entries.x?.v).toBe("ok");
    await expect(sendRequest(url, wrong, request)).rejects.toThrow(/groupe inconnu/);
    await server.close();
  });
});
