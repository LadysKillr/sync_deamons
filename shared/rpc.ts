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
  intervalSec: z.number(),
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
    intervalSec: z.number().int().min(5).max(3600).optional(),
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
