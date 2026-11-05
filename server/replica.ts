import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Réplique d'un groupe : la dernière valeur connue de chaque élément, datée.
 *
 * Fusion « la plus récente gagne » (LWW) avec une horloge hybride : `t` est une heure en millisecondes qui ne recule
 * jamais sur une machine et dépasse toujours la plus grande heure déjà vue, `o` la machine d'origine départage deux
 * écritures à la même heure. Une suppression est une valeur `null` (pierre tombale) gardée `TOMBSTONE_TTL_MS`.
 *
 * La fusion est commutative, associative et idempotente : rejouer un échange ou recevoir deux fois la même réplique
 * ne change rien.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const EntrySchema = z.object({
  v: z.json(),
  h: z.string().max(64),
  t: z.number().int().nonnegative(),
  o: z.string().max(64),
});
export type Entry = { v: Json; h: string; t: number; o: string };
export type Entries = Record<string, Entry>;

export const MemberSchema = z.object({ label: z.string().max(120), url: z.string().max(500), seenAt: z.number().int().nonnegative() });
export type Member = z.infer<typeof MemberSchema>;
export type Members = Record<string, Member>;

/**
 * Compte rendu qu'une machine publie sur elle-même : ce qu'elle n'a pas encore appliqué et ses échecs, plus
 * l'empreinte de sa réplique. Deux machines de même empreinte ont la même réplique : chez l'autre, un élément qui
 * n'est ni en attente ni en échec est donc appliqué. Seule la machine concernée écrit son compte rendu ; `at` vient
 * de son horloge hybride et départage les copies qui circulent.
 */
export const REPORT_LIMIT = 100;
export const ReportSchema = z.object({
  at: z.number().int().nonnegative(),
  digest: z.string().max(64),
  version: z.string().max(40),
  mode: z.enum(["both", "receive", "send"]),
  applied: z.number().int().nonnegative(),
  /** Nombre réel d'éléments en attente (la liste `pending` est tronquée à REPORT_LIMIT). */
  pendingTotal: z.number().int().nonnegative(),
  pending: z.array(z.string().max(500)).max(REPORT_LIMIT),
  errors: z.record(z.string().max(500), z.string().max(500)),
});
export type Report = z.infer<typeof ReportSchema>;
export type Reports = Record<string, Report>;

export function mergeReports(local: Reports, remote: Reports | undefined): void {
  for (const [nodeId, incoming] of Object.entries(remote ?? {})) {
    const current = local[nodeId];
    if (current === undefined || incoming.at > current.at) local[nodeId] = { ...incoming, pending: [...incoming.pending], errors: { ...incoming.errors } };
  }
}

/** Empreinte de la réplique entière (clés triées, versions). */
export function replicaDigest(entries: Entries): string {
  const hash = createHash("sha256");
  for (const key of Object.keys(entries).sort()) {
    const entry = entries[key]!;
    hash.update(`${key}=${entry.t}.${entry.o}.${entry.h}\n`);
  }
  return hash.digest("base64url").slice(0, 32);
}

export const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
/** Une machine muette depuis plus longtemps est oubliée de la liste des membres. */
export const MEMBER_TTL_MS = 60 * 24 * 3600 * 1000;

export function newer(a: Entry, b: Entry): boolean {
  if (a.t !== b.t) return a.t > b.t;
  if (a.o !== b.o) return a.o > b.o;
  return a.h > b.h;
}

/** Fusionne `remote` dans `local` (modifié en place) ; renvoie les clés qui ont changé. */
export function mergeEntries(local: Entries, remote: Entries): string[] {
  const changed: string[] = [];
  for (const [key, incoming] of Object.entries(remote)) {
    const current = local[key];
    if (current === undefined || newer(incoming, current)) {
      local[key] = { v: incoming.v, h: incoming.h, t: incoming.t, o: incoming.o };
      changed.push(key);
    }
  }
  return changed;
}

/** Un membre sans adresse http(s) joignable n'est pas une machine du groupe (ex. un client de diagnostic). */
export function validMemberUrl(url: string): boolean {
  return /^https?:\/\/[^\s/]+/.test(url);
}

export function mergeMembers(local: Members, remote: Members): void {
  for (const [nodeId, incoming] of Object.entries(remote)) {
    if (!validMemberUrl(incoming.url)) continue;
    const current = local[nodeId];
    if (current === undefined || incoming.seenAt > current.seenAt) local[nodeId] = { ...incoming };
  }
}

export function maxTime(entries: Entries): number {
  let max = 0;
  for (const entry of Object.values(entries)) if (entry.t > max) max = entry.t;
  return max;
}

export function pruneTombstones(entries: Entries, now: number): void {
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.v === null && now - entry.t > TOMBSTONE_TTL_MS) delete entries[key];
  }
}

export function pruneMembers(members: Members, now: number, selfId: string): void {
  for (const [nodeId, member] of Object.entries(members)) {
    if (nodeId !== selfId && (now - member.seenAt > MEMBER_TTL_MS || !validMemberUrl(member.url))) delete members[nodeId];
  }
}

/** Horloge hybride : jamais en arrière, toujours au-delà de ce qui a été vu. */
export class HybridClock {
  private last = 0;
  constructor(private readonly wall: () => number = Date.now) {}
  observe(t: number): void {
    if (t > this.last) this.last = t;
  }
  tick(): number {
    this.last = Math.max(this.wall(), this.last + 1);
    return this.last;
  }
  now(): number {
    return this.wall();
  }
}
