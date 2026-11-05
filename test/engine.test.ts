import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCOPE, KEY_PREFIX, keyInScope, type GroupScope } from "../shared/model";
import type { ApplyOutcome, Change, Collector } from "../server/collectors";
import { aad, deriveMasterKey, groupKeys, open, seal, type GroupKeys } from "../server/crypto";
import { Engine } from "../server/engine";
import { HybridClock, concurrent, mergeEntries, type Entries, type Json } from "../server/replica";
import { Store, newGroupState } from "../server/store";
import { RequestSchema, ResponseSchema, sendRequest, startServer, type SyncRequest, type SyncResponse } from "../server/transport";

/** Collecteur en mémoire : un dictionnaire de clés « plugin/… », « config/… ». */
class MemoryCollector implements Collector {
  readonly name = "memory";
  state = new Map<string, Json>();
  failNext = new Set<string>();
  unsure = new Set<string>();
  temporary = new Set<string>();
  owns(): boolean {
    return true;
  }
  uncertain(key: string): boolean {
    return this.unsure.has(key);
  }
  ignores(key: string): boolean {
    return this.temporary.has(key);
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

describe("concurrence", () => {
  it("distingue des changements successifs de changements concurrents", () => {
    const v0 = { v: 0, h: "h0", t: 1, o: "a" };
    const va = { v: 1, h: "ha", t: 10, o: "a", p: "h0" };
    const vb = { v: 2, h: "hb", t: 11, o: "b", p: "h0" };
    const vbAfterA = { v: 2, h: "hb2", t: 11, o: "b", p: "ha" };
    expect(concurrent(va, vb)).toBe(true);
    expect(concurrent(va, vbAfterA)).toBe(false);
    // Sans parent (versions relayées par une machine plus ancienne) : proximité dans le temps.
    expect(concurrent({ ...v0, o: "a", h: "x" }, { ...v0, o: "b", h: "y", t: 60_000 })).toBe(true);
    expect(concurrent({ ...v0, o: "a", h: "x" }, { ...v0, o: "b", h: "y", t: 10 * 60_000 })).toBe(false);
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

describe("éléments incertains ou ignorés", () => {
  it("un fichier absent le temps d'une écriture n'est pas supprimé ailleurs", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    const key = `${KEY_PREFIX.plugin}kanban`;
    a.memory.state.set(key, plugin("1"));
    const id = await addGroup(a, [], { create: true });
    await addGroup(b, [a.url], { create: false });
    await rounds([a, b], id, 2);
    expect(b.memory.state.has(key)).toBe(true);

    // Sur A, le relevé ne le voit pas (lu pendant son remplacement) : aucune suppression publiée.
    a.memory.state.delete(key);
    a.memory.unsure.add(key);
    await rounds([a, b], id, 2);
    expect(b.memory.state.get(key)).toEqual(plugin("1"));
    expect(a.engine.store.group(id)!.entries[key]!.v).not.toBeNull();

    // Il revient : rien ne bouge non plus.
    a.memory.unsure.clear();
    a.memory.state.set(key, plugin("1"));
    await rounds([a, b], id, 2);
    expect(a.engine.store.group(id)!.recent.filter((item) => item.key === key && item.action === "deleted")).toHaveLength(0);
  });

  it("une clé devenue ignorée (temporaire) est oubliée sans suppression ni application", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    const key = `${KEY_PREFIX.plugin}brouillon`;
    a.memory.state.set(key, plugin("1"));
    const id = await addGroup(a, [], { create: true });
    await addGroup(b, [a.url], { create: false });
    await rounds([a, b], id, 2);
    expect(b.memory.state.has(key)).toBe(true);

    // Nouvelle règle sur les deux : la clé n'est plus suivie. A la supprime chez lui, B ne doit pas suivre.
    a.memory.temporary.add(key);
    b.memory.temporary.add(key);
    a.memory.state.delete(key);
    await rounds([a, b], id, 2);
    expect(b.memory.state.get(key)).toEqual(plugin("1"));
    expect(a.engine.store.group(id)!.baseline[key]).toBeUndefined();
  });
});

describe("longue absence", () => {
  it("une machine revenue après 40 jours ne réinstalle pas ce que le groupe a supprimé", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    const x = `${KEY_PREFIX.plugin}ancien`;
    const y = `${KEY_PREFIX.plugin}nouveau`;
    a.memory.state.set(x, plugin("1"));
    const id = await addGroup(a, [], { create: true });
    await addGroup(b, [a.url], { create: false });
    await rounds([a, b], id, 2);
    expect(b.memory.state.has(x)).toBe(true);

    // B s'éteint. A supprime X, installe Y, et 40 jours passent : la trace de suppression de X est oubliée.
    network.delete(b.url);
    a.memory.state.delete(x);
    a.memory.state.set(y, plugin("2"));
    await rounds([a], id, 1);
    wall += 40 * 24 * 3600 * 1000;
    await rounds([a], id, 1);
    expect(a.engine.store.group(id)!.entries[x]).toBeUndefined();

    // B revient avec sa vieille réplique.
    network.set(b.url, b);
    await rounds([b, a], id, 3);
    expect(a.memory.state.has(x)).toBe(false);
    expect(a.engine.store.group(id)!.entries[x]).toBeUndefined();
    expect(b.memory.state.get(y)).toEqual(plugin("2"));
    // X reste sur B (on ne sait plus s'il a été supprimé), sans être republié, et sort de sa réplique.
    expect(b.memory.state.has(x)).toBe(true);
    expect(b.engine.store.group(id)!.entries[x]).toBeUndefined();
    expect(b.engine.view(b.engine.store.group(id)!).machines.every((machine) => machine.upToDate)).toBe(true);

    // Ensuite, B redevient une machine normale : ses changements repartent.
    b.memory.state.set(`${KEY_PREFIX.plugin}apres`, plugin("3"));
    await rounds([b, a], id, 2);
    expect(a.memory.state.get(`${KEY_PREFIX.plugin}apres`)).toEqual(plugin("3"));
  });
});

describe("exclusions et approbation", () => {
  it("une machine qui exclut un plugin ne l'installe pas, ne publie rien dessus, et les autres le voient", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    const kanban = `${KEY_PREFIX.plugin}kanban`;
    const kanbanSettings = `${KEY_PREFIX.settings}kanban/config`;
    const id = await addGroup(a, [], { create: true });
    await addGroup(b, [a.url], { create: false });
    b.engine.store.group(id)!.exclude = [kanban];
    a.memory.state.set(kanban, plugin("1"));
    a.memory.state.set(kanbanSettings, { values: { x: 1 } });
    await rounds([a, b], id, 2);
    expect(b.memory.state.has(kanban)).toBe(false);
    expect(b.memory.state.has(kanbanSettings)).toBe(false);
    expect(b.engine.view(b.engine.store.group(id)!).pending).toBe(0);

    // B installe sa propre version : elle reste locale.
    b.memory.state.set(kanban, plugin("0-local"));
    await rounds([b, a], id, 2);
    expect(a.memory.state.get(kanban)).toEqual(plugin("1"));
    const item = a.engine.view(a.engine.store.group(id)!).itemStatus.find((entry) => entry.key === kanban)!;
    expect(item.excluded).toEqual(["b"]);
    expect(item.ok).toEqual(["a"]);
  });

  it("mode approbation : rien n'est appliqué sans accord ; un refus tient jusqu'à la version suivante", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    const key = `${KEY_PREFIX.plugin}kanban`;
    const id = await addGroup(a, [], { create: true });
    await addGroup(b, [a.url], { create: false });
    await rounds([a, b], id, 2);
    const gb = b.engine.store.group(id)!;
    gb.approval = true;

    a.memory.state.set(key, plugin("1"));
    await rounds([a, b], id, 2);
    expect(b.memory.state.has(key)).toBe(false);
    expect(b.engine.view(gb).awaiting.map((change) => change.key)).toEqual([key]);
    expect(a.engine.view(a.engine.store.group(id)!).itemStatus.find((entry) => entry.key === key)!.awaiting).toEqual(["b"]);

    expect(b.engine.decide(gb, "all", "approve")).toBe(1);
    await rounds([b], id, 1);
    expect(b.memory.state.get(key)).toEqual(plugin("1"));
    expect(b.engine.view(gb).awaiting).toHaveLength(0);

    // Version 2 refusée : B reste en 1 et ne republie pas sa 1 par-dessus.
    a.memory.state.set(key, plugin("2"));
    await rounds([a, b], id, 2);
    b.engine.decide(gb, [key], "reject");
    await rounds([b, a], id, 2);
    expect(b.memory.state.get(key)).toEqual(plugin("1"));
    expect(a.memory.state.get(key)).toEqual(plugin("2"));
    expect(b.engine.view(gb).awaiting).toHaveLength(0);

    // Version 3 : le refus de la 2 ne vaut plus, elle attend un nouvel accord.
    a.memory.state.set(key, plugin("3"));
    await rounds([a, b], id, 2);
    expect(b.engine.view(gb).awaiting.map((change) => change.revision)).toEqual(["3"]);
  });
});

describe("historique et conflits", () => {
  it("garde les versions précédentes et permet de revenir à l'une d'elles partout", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    const key = `${KEY_PREFIX.plugin}kanban`;
    const id = await addGroup(a, [], { create: true });
    await addGroup(b, [a.url], { create: false });
    for (const revision of ["1", "2", "3"]) {
      a.memory.state.set(key, plugin(revision));
      await rounds([a, b], id, 2);
    }
    const gb = b.engine.store.group(id)!;
    const versions = b.engine.historyOf(gb, key);
    expect(versions.map((version) => version.revision)).toEqual(["3", "2", "1"]);
    expect(versions[0]!.current).toBe(true);

    // Depuis B, retour à la 1 : A suit.
    b.engine.restore(gb, key, versions[2]!.h);
    await rounds([b, a], id, 2);
    expect(a.memory.state.get(key)).toEqual(plugin("1"));
    expect(b.memory.state.get(key)).toEqual(plugin("1"));
  });

  it("signale deux changements presque simultanés et garde la version perdante", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    const key = `${KEY_PREFIX.config}agents`;
    const id = await addGroup(a, [], { create: true });
    await addGroup(b, [a.url], { create: false });
    await rounds([a, b], id, 2);

    // Chacun modifie de son côté, avant tout échange.
    a.memory.state.set(key, { from: "a" });
    b.memory.state.set(key, { from: "b" });
    tick();
    await a.engine.scan(a.engine.store.group(id)!);
    tick();
    await b.engine.scan(b.engine.store.group(id)!);
    await rounds([a, b], id, 2);

    const ga = a.engine.store.group(id)!;
    const gb = b.engine.store.group(id)!;
    // B a écrit en dernier : B l'emporte, partout.
    expect(a.memory.state.get(key)).toEqual({ from: "b" });
    // Le conflit est visible des deux côtés ; seule A (qui a perdu) a la version perdante sous la main.
    expect(a.engine.view(ga).conflicts[0]).toMatchObject({ key, winner: "b", loser: "a", canRestore: true });
    expect(b.engine.view(gb).conflicts[0]).toMatchObject({ key, winner: "b", loser: "a", canRestore: false, seenBy: ["a"] });
    // La version de A peut être rétablie depuis A.
    a.engine.restore(ga, key, a.engine.view(ga).conflicts[0]!.loserHash);
    await rounds([a, b], id, 2);
    expect(b.memory.state.get(key)).toEqual({ from: "a" });
    expect(a.engine.view(ga).conflicts).toHaveLength(0);
  });
});

describe("état par machine", () => {
  it("chaque machine voit ce qui est appliqué ou en échec chez les autres", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    const c = makeNode("c", network);
    const key = `${KEY_PREFIX.plugin}workspace-spaces`;
    const id = await addGroup(a, [], { create: true });
    await addGroup(b, [a.url], { create: false });
    await addGroup(c, [a.url], { create: false });
    await rounds([a, b, c], id, 2);

    a.memory.state.set(key, plugin("6ee031d"));
    c.memory.failNext.add(key);
    await rounds([a, b, c], id, 2);
    // A voit : appliqué chez a et b, échec chez c avec le message.
    let item = a.engine.view(a.engine.store.group(id)!).itemStatus.find((entry) => entry.key === key)!;
    expect(item.ok.sort()).toEqual(["a", "b"]);
    expect(item.errors).toEqual([{ machine: "c", message: "échec simulé" }]);
    const machines = a.engine.view(a.engine.store.group(id)!).machines;
    expect(machines.find((machine) => machine.label === "c")!.errors).toBe(1);
    expect(machines.every((machine) => machine.version !== null)).toBe(true);

    // C réessaie plus tard et réussit : 3/3, vu aussi depuis B.
    wall += 120_000;
    await rounds([c, a, b], id, 2);
    item = b.engine.view(b.engine.store.group(id)!).itemStatus.find((entry) => entry.key === key)!;
    expect(item.ok.sort()).toEqual(["a", "b", "c"]);
    expect(item.errors).toHaveLength(0);
  });

  it("une machine sans compte rendu (ancienne version) est marquée inconnue", async () => {
    const network = new Map<string, Node>();
    const a = makeNode("a", network);
    const b = makeNode("b", network);
    const key = `${KEY_PREFIX.plugin}kanban`;
    a.memory.state.set(key, plugin("1"));
    const id = await addGroup(a, [], { create: true });
    await addGroup(b, [a.url], { create: false });
    await rounds([a, b], id, 2);
    delete a.engine.store.group(id)!.reports[b.engine.store.data.node.nodeId];
    const item = a.engine.statusByMachine(a.engine.store.group(id)!).itemStatus.find((entry) => entry.key === key)!;
    expect(item.ok).toEqual(["a"]);
    expect(item.unknown).toEqual(["b"]);
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
