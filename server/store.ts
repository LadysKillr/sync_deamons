import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { GroupModeSchema } from "../shared/model";
import { EntrySchema, MemberSchema, ReportSchema } from "./replica";

/** Tout l'état du plugin sur cette machine : `<PASEO_HOME>/plugin-data/sync/state.json`, mode 0600. */

export const DEFAULT_PORT = 6780;
/** Passage de secours : 10 min. */
export const DEFAULT_INTERVAL_SEC = 600;

export const NodeConfigSchema = z.object({
  nodeId: z.string(),
  label: z.string(),
  listenHost: z.string(),
  port: z.number().int(),
  advertiseUrl: z.string().nullable(),
  /** Passage de secours (s) ; les changements locaux sont détectés à part, aussitôt. */
  intervalSec: z.number().int(),
  watch: z.boolean().default(true),
});
export type NodeConfig = z.infer<typeof NodeConfigSchema>;

const AttemptSchema = z.object({ h: z.string(), at: z.number(), error: z.string().nullable(), count: z.number() });
const ActivitySchema = z.object({
  key: z.string(),
  at: z.number(),
  action: z.enum(["published", "applied", "deleted"]),
  origin: z.string(),
});
const PeerStatusSchema = z.object({ lastOkAt: z.number().nullable(), lastError: z.string().nullable(), nodeId: z.string().nullable() });

export const GroupStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Clé maîtresse (base64), jamais le mot de passe. */
  key: z.string(),
  mode: GroupModeSchema,
  enabled: z.boolean(),
  /** Adresses de départ ; les autres membres arrivent par la liste des membres. */
  peers: z.array(z.string()),
  createdAt: z.number(),
  /** Vrai tant qu'une machine qui a rejoint n'a pas encore fait son premier échange réussi. */
  joining: z.boolean(),
  /** Exclusions propres à cette machine (voir matchesExclusion) : ni appliquées ni publiées ici. */
  exclude: z.array(z.string()).default([]),
  /** Mode approbation : les changements reçus attendent un accord explicite avant d'être appliqués ici. */
  approval: z.boolean().default(false),
  /** Versions (empreintes) approuvées ou refusées, par clé. */
  approved: z.record(z.string(), z.string()).default({}),
  rejected: z.record(z.string(), z.string()).default({}),
  /** Versions précédentes de chaque élément, la plus récente d'abord (HISTORY_DEPTH au plus). */
  history: z.record(z.string(), z.array(EntrySchema)).default({}),
  /** Conflits récents : deux machines ont modifié le même élément presque en même temps. */
  conflicts: z
    .array(
      z.object({
        key: z.string(),
        at: z.number(),
        winner: z.object({ o: z.string(), h: z.string(), t: z.number() }),
        loser: z.object({ o: z.string(), h: z.string(), t: z.number() }),
      }),
    )
    .default([]),
  /** Suivi des mises à jour des plugins : dernière vérification menée ici, et ce qui a été installé. */
  lastUpdateCheckAt: z.number().nullable().default(null),
  lastUpdateCheckError: z.string().nullable().default(null),
  updateLog: z
    .array(z.object({ id: z.string(), from: z.string().nullable(), to: z.string().nullable(), at: z.number(), error: z.string().nullable() }))
    .default([]),
  /** Heure de la plus récente trace de suppression oubliée ici : horizon d'oubli (voir Engine.admissible). */
  forgottenBefore: z.number().default(0),
  entries: z.record(z.string(), EntrySchema),
  /** Empreinte de la valeur locale au dernier accord avec la réplique. */
  baseline: z.record(z.string(), z.string()),
  attempts: z.record(z.string(), AttemptSchema),
  members: z.record(z.string(), MemberSchema),
  /** Comptes rendus des machines (le sien compris), pour l'état par machine. */
  reports: z.record(z.string(), ReportSchema).default({}),
  peerStatus: z.record(z.string(), PeerStatusSchema),
  lastSyncAt: z.number().nullable(),
  lastError: z.string().nullable(),
  recent: z.array(ActivitySchema),
});
export type GroupState = z.infer<typeof GroupStateSchema> & { entries: Record<string, import("./replica").Entry> };

const StoreFileSchema = z.object({ version: z.literal(1), node: NodeConfigSchema, groups: z.array(GroupStateSchema) });
export type StoreFile = { version: 1; node: NodeConfig; groups: GroupState[] };

export function defaultNode(): NodeConfig {
  return {
    nodeId: `n_${randomBytes(8).toString("hex")}`,
    label: hostname(),
    listenHost: "0.0.0.0",
    port: DEFAULT_PORT,
    advertiseUrl: null,
    intervalSec: DEFAULT_INTERVAL_SEC,
    watch: true,
  };
}

export class Store {
  readonly file: string;
  data: StoreFile;

  constructor(readonly dir: string) {
    this.file = path.join(dir, "state.json");
    this.data = this.load();
  }

  private load(): StoreFile {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const fresh: StoreFile = { version: 1, node: defaultNode(), groups: [] };
        this.data = fresh;
        this.save();
        return fresh;
      }
      throw error;
    }
    const json = JSON.parse(raw) as { node?: { watch?: unknown; intervalSec?: unknown } };
    // 0.1.1 et avant : pas de détection de changements, passage toutes les 30 s. On passe au secours de 10 min.
    if (json.node && json.node.watch === undefined && json.node.intervalSec === 30) json.node.intervalSec = DEFAULT_INTERVAL_SEC;
    const parsed = StoreFileSchema.safeParse(json);
    if (!parsed.success) {
      // On garde une copie du fichier illisible plutôt que de l'écraser en silence.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      writeFileSync(backup, raw, { mode: 0o600 });
      throw new Error(`state.json illisible (copie : ${backup}) : ${parsed.error.issues[0]?.message ?? "format"}`);
    }
    return parsed.data as StoreFile;
  }

  save(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(temporary, this.file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  group(id: string): GroupState | undefined {
    return this.data.groups.find((group) => group.id === id);
  }
}

export function newGroupState(input: {
  id: string;
  name: string;
  key: string;
  mode: GroupState["mode"];
  peers: string[];
  now: number;
}): GroupState {
  return {
    id: input.id,
    name: input.name,
    key: input.key,
    mode: input.mode,
    enabled: true,
    peers: input.peers,
    createdAt: input.now,
    joining: input.peers.length > 0,
    forgottenBefore: 0,
    history: {},
    conflicts: [],
    lastUpdateCheckAt: null,
    lastUpdateCheckError: null,
    updateLog: [],
    exclude: [],
    approval: false,
    approved: {},
    rejected: {},
    entries: {},
    baseline: {},
    attempts: {},
    members: {},
    reports: {},
    peerStatus: {},
    lastSyncAt: null,
    lastError: null,
    recent: [],
  };
}
