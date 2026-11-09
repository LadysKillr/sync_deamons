import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { GroupModeSchema, GroupScopeSchema } from "./model";

export const NodeViewSchema = z.object({
  nodeId: z.string(),
  label: z.string(),
  listenHost: z.string(),
  port: z.number(),
  advertiseUrl: z.string().nullable(),
  /** L'adresse annoncée aux autres machines (réglée ou devinée). */
  effectiveUrl: z.string(),
  listening: z.boolean(),
  listenError: z.string().nullable(),
  /** Adresse d'écoute réelle (« auto » résolu). */
  boundHost: z.string().nullable(),
  intervalSec: z.number(),
  watch: z.boolean(),
  watching: z.number(),
});
export type NodeView = z.infer<typeof NodeViewSchema>;

export const MemberViewSchema = z.object({
  nodeId: z.string(),
  label: z.string(),
  url: z.string(),
  seenAt: z.number(),
  self: z.boolean(),
  lastOkAt: z.number().nullable(),
  lastError: z.string().nullable(),
});

export const ProblemViewSchema = z.object({ key: z.string(), error: z.string(), at: z.number() });
export const ActivityViewSchema = z.object({
  key: z.string(),
  at: z.number(),
  action: z.enum(["published", "applied", "deleted"]),
  origin: z.string(),
});

export const MachineStatusSchema = z.object({
  nodeId: z.string(),
  label: z.string(),
  self: z.boolean(),
  /** Version de Sync sur cette machine ; null si elle ne publie pas encore de compte rendu (0.1.3 et avant). */
  version: z.string().nullable(),
  mode: GroupModeSchema.nullable(),
  /** Même réplique que cette machine-ci ; null si inconnu. */
  upToDate: z.boolean().nullable(),
  reportAt: z.number().nullable(),
  applied: z.number(),
  pending: z.number(),
  errors: z.number(),
});
export type MachineStatus = z.infer<typeof MachineStatusSchema>;

export const ItemStatusSchema = z.object({
  /** Clé de l'élément ; les fichiers sont regroupés par ensemble (`file/<ensemble>`). */
  key: z.string(),
  /** Nombre de fichiers pour un ensemble, 1 sinon. */
  count: z.number(),
  ok: z.array(z.string()),
  pending: z.array(z.string()),
  errors: z.array(z.object({ machine: z.string(), message: z.string() })),
  /** Machines dont l'état est inconnu (ancienne version, ou synchronisation en cours). */
  unknown: z.array(z.string()),
  /** Machines « envoie seulement », qui n'appliquent rien. */
  notApplied: z.array(z.string()),
  /** Machines qui ont exclu cet élément. */
  excluded: z.array(z.string()),
  /** Machines en mode approbation qui n'ont pas encore accepté ce changement. */
  awaiting: z.array(z.string()),
});
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

export const GroupViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: GroupModeSchema,
  enabled: z.boolean(),
  peers: z.array(z.string()),
  scope: GroupScopeSchema,
  members: z.array(MemberViewSchema),
  lastSyncAt: z.number().nullable(),
  lastError: z.string().nullable(),
  items: z.number(),
  pending: z.number(),
  problems: z.array(ProblemViewSchema),
  recent: z.array(ActivityViewSchema),
  /** Éléments que ce groupe ignore ici parce qu'un groupe placé avant lui les gère déjà. */
  shadowed: z.array(z.string()),
  machines: z.array(MachineStatusSchema),
  itemStatus: z.array(ItemStatusSchema),
  /** Exclusions de cette machine. */
  exclude: z.array(z.string()),
  /** Mode approbation sur cette machine. */
  approval: z.boolean(),
  /** Changements reçus qui attendent l'accord de cette machine. */
  awaiting: z.array(
    z.object({ key: z.string(), deletion: z.boolean(), revision: z.string().nullable(), origin: z.string(), at: z.number() }),
  ),
  /** Cette machine a été retirée du groupe (par qui). */
  revokedBy: z.string().nullable(),
  /** Clés dont la version actuelle a été refusée ici. */
  rejected: z.array(z.string()),
  /** Suivi des mises à jour des plugins (option du groupe). */
  updates: z.object({
    /** Machine qui vérifie et installe les mises à jour pour le groupe. */
    leader: z.string().nullable(),
    lastCheckAt: z.number().nullable(),
    lastCheckError: z.string().nullable(),
    log: z.array(z.object({ id: z.string(), from: z.string().nullable(), to: z.string().nullable(), at: z.number(), error: z.string().nullable() })),
  }),
  /** Conflits récents (7 jours). */
  conflicts: z.array(
    z.object({
      key: z.string(),
      at: z.number(),
      winner: z.string(),
      loser: z.string(),
      loserHash: z.string(),
      /** La version perdante est dans l'historique de cette machine : elle peut être rétablie d'ici. */
      canRestore: z.boolean(),
      /** Machines qui ont vu le conflit (celle qui a perdu peut le rétablir). */
      seenBy: z.array(z.string()),
    }),
  ),
});
export type GroupView = z.infer<typeof GroupViewSchema>;

export const StatusSchema = z.object({ node: NodeViewSchema, groups: z.array(GroupViewSchema) });
export type StatusView = z.infer<typeof StatusSchema>;

export const LocalPluginSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  kind: z.string(),
  revision: z.string().nullable(),
  enabled: z.boolean(),
  syncable: z.boolean(),
});
export type LocalPlugin = z.infer<typeof LocalPluginSchema>;

const ok = z.object({ ok: z.literal(true) });

export const statusRpc = defineRpc({ name: "sync.status", input: z.object({}), output: StatusSchema });

export const nodeUpdateRpc = defineRpc({
  name: "sync.node.update",
  input: z.object({
    label: z.string().min(1).max(60).optional(),
    listenHost: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    advertiseUrl: z.string().url().nullable().optional(),
    intervalSec: z.number().int().min(10).max(86400).optional(),
    watch: z.boolean().optional(),
  }),
  output: ok,
});

export const groupCreateRpc = defineRpc({
  name: "sync.group.create",
  input: z.object({
    name: z.string().trim().min(1).max(60),
    password: z.string().min(8, "8 caractères au moins"),
    /** Adresses d'une ou plusieurs machines déjà dans le groupe (rejoindre). Vide : nouveau groupe. */
    peers: z.array(z.string().url()).default([]),
    mode: GroupModeSchema.default("both"),
  }),
  output: z.object({ id: z.string() }),
});

export const groupUpdateRpc = defineRpc({
  name: "sync.group.update",
  input: z.object({
    id: z.string(),
    peers: z.array(z.string().url()).optional(),
    mode: GroupModeSchema.optional(),
    enabled: z.boolean().optional(),
    scope: GroupScopeSchema.optional(),
    /** Monte (-1) ou descend (+1) le groupe : le premier groupe qui couvre un élément le gère. */
    move: z.union([z.literal(-1), z.literal(1)]).optional(),
    /** Exclusions propres à cette machine. */
    exclude: z.array(z.string()).optional(),
    approval: z.boolean().optional(),
  }),
  output: ok,
});

export const groupRemoveRpc = defineRpc({ name: "sync.group.remove", input: z.object({ id: z.string() }), output: ok });

export const syncNowRpc = defineRpc({
  name: "sync.now",
  input: z.object({ id: z.string().optional() }),
  output: ok,
});

export const pluginsListRpc = defineRpc({
  name: "sync.plugins.list",
  input: z.object({}),
  output: z.object({ plugins: z.array(LocalPluginSchema) }),
});

/** Code d'invitation : nom du groupe et adresses connues (jamais le mot de passe). */
export const InviteSchema = z.object({ v: z.literal(1), name: z.string(), peers: z.array(z.string()) });
export type Invite = z.infer<typeof InviteSchema>;

export const inviteRpc = defineRpc({
  name: "sync.group.invite",
  input: z.object({ id: z.string() }),
  output: z.object({ code: z.string() }),
});

export const inviteDecodeRpc = defineRpc({
  name: "sync.invite.decode",
  input: z.object({ code: z.string() }),
  output: InviteSchema,
});

export const decideRpc = defineRpc({
  name: "sync.group.decide",
  input: z.object({
    id: z.string(),
    keys: z.union([z.array(z.string()), z.literal("all")]),
    decision: z.enum(["approve", "reject"]),
  }),
  output: z.object({ count: z.number() }),
});

export const HistoryEntrySchema = z.object({
  h: z.string(),
  t: z.number(),
  origin: z.string(),
  deletion: z.boolean(),
  revision: z.string().nullable(),
  current: z.boolean(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const historyRpc = defineRpc({
  name: "sync.item.history",
  input: z.object({ id: z.string(), key: z.string() }),
  output: z.object({ versions: z.array(HistoryEntrySchema) }),
});

/** Republie une ancienne version pour tout le groupe. */
export const restoreRpc = defineRpc({
  name: "sync.item.restore",
  input: z.object({ id: z.string(), key: z.string(), hash: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

/** Vérifie tout de suite les mises à jour des plugins (si cette machine mène pour au moins un groupe). */
export const checkUpdatesRpc = defineRpc({ name: "sync.updates.check", input: z.object({}), output: z.object({ ok: z.literal(true) }) });

/**
 * Nouveau mot de passe pour le groupe, en retirant éventuellement des machines. Le nouvel identifiant du groupe est
 * renvoyé ; `unreachable` : machines sans clé publique (Sync trop ancien), qui devront rejoindre à la main.
 */
export const rekeyRpc = defineRpc({
  name: "sync.group.rekey",
  input: z.object({ id: z.string(), password: z.string().min(8, "8 caractères au moins"), remove: z.array(z.string()).default([]) }),
  output: z.object({ id: z.string(), reached: z.number(), unreachable: z.array(z.string()) }),
});

/** Relance les éléments en échec (un seul, ou tous) : utile après un abandon au bout de plusieurs essais. */
export const retryRpc = defineRpc({
  name: "sync.item.retry",
  input: z.object({ id: z.string(), key: z.string().optional() }),
  output: z.object({ count: z.number() }),
});
