import { DEFAULT_SCOPE, GroupScopeSchema, KEY_PREFIX, SCOPE_KEY, keyInScope, matchesExclusion, type GroupScope } from "../shared/model";
import type { GroupView, StatusView } from "../shared/rpc";
import type { Collector } from "./collectors";
import { canonical, groupKeys, hashValue, type GroupKeys } from "./crypto";
import {
  HISTORY_DEPTH,
  HISTORY_MAX_VALUE,
  HybridClock,
  REPORT_LIMIT,
  maxTime,
  mergeEntries,
  mergeMembers,
  mergeReports,
  newer,
  pruneMembers,
  pruneTombstones,
  replicaDigest,
  validMemberUrl,
  type Entries,
  type Entry,
  type Json,
  type Report,
  concurrent,
} from "./replica";
import { SYNC_VERSION } from "../shared/version";
import { updateLeader } from "./plugin-updates";
import type { GroupState, Store } from "./store";
import { BLOBS_BYTES_PER_RESPONSE, BLOBS_PER_REQUEST, type SyncRequest, type SyncResponse } from "./transport";
import { blobRef, type BlobStore } from "./blobs";
import { REKEY_GRACE_MS, unwrap, wrapFor, type Rekey } from "./rekey";

/**
 * Le moteur : pour chaque groupe, à chaque passage
 * 1. relève l'état local et publie dans la réplique ce qui a changé ici (« published ») ;
 * 2. échange la réplique avec chaque membre joignable (pull puis push) ;
 * 3. applique ici ce que la réplique a de différent de l'état local (« applied »).
 *
 * `baseline[clé]` est l'empreinte de l'état local au dernier accord avec la réplique. Un état local différent de
 * `baseline` est un changement fait ici ; une réplique différente de `baseline` est un changement à appliquer ici.
 * Après chaque application, `baseline` reprend l'état réellement obtenu : un effet de bord d'un échec (plugin retiré
 * mais pas réinstallé) n'est jamais publié comme un choix de l'utilisateur.
 */

export type SendFn = (url: string, keys: GroupKeys, request: SyncRequest) => Promise<SyncResponse>;

export interface EngineDeps {
  store: Store;
  /** Dans l'ordre d'application : plugins, réglages, config, fichiers. */
  collectors: Collector[];
  send: SendFn;
  selfUrl: () => string;
  log: (line: string) => void;
  clock?: HybridClock;
  /** Appelé après chaque passage (par exemple pour reposer les surveillances si la portée a changé). */
  afterPass?: () => void;
  /** Magasin des contenus de fichiers ; sans lui, les fichiers voyagent inline. */
  blobs?: BlobStore;
  /** Contenus encore utilisés hors de la réplique (fichiers locaux suivis), à garder au nettoyage. */
  blobsInUse?: () => Set<string>;
}

const RECENT_MAX = 40;
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const versionOf = (entry: Entry) => `${entry.t}.${entry.o}.${entry.h}`;

/** Révision d'une valeur de plugin (commit ou version npm), pour l'affichage. */
function revisionOf(value: Json): string | null {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.revision === "string") return value.revision;
  return null;
}

function parseVersion(version: string): Pick<Entry, "t" | "o" | "h"> | null {
  const [t, o, h] = version.split(".");
  if (t === undefined || o === undefined || h === undefined) return null;
  return { t: Number(t), o, h };
}

/** Attente avant de réessayer une application ratée : 30 s, 1 min, 2 min… jusqu'à 1 h. */
export function backoffMs(count: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, count - 1), 3600_000);
}

export class Engine {
  readonly clock: HybridClock;
  private keyCache = new Map<string, GroupKeys>();
  /** Un seul relevé ou une seule application à la fois sur la machine (les collecteurs touchent le même daemon). */
  private systemLock: Promise<unknown> = Promise.resolve();
  private running = new Map<string, Promise<void>>();
  /** Applications en cours, et fin de la période où les écritures de Sync lui-même sont encore visibles. */
  private applying = 0;
  private quietUntil = 0;

  /** Vrai pendant (et juste après) une application : la détection de changements ignore ses propres écritures. */
  isApplying(): boolean {
    return this.applying > 0 || Date.now() < this.quietUntil;
  }
  private rerun = new Set<string>();

  constructor(private readonly deps: EngineDeps) {
    this.clock = deps.clock ?? new HybridClock();
    for (const group of deps.store.data.groups) this.clock.observe(maxTime(group.entries));
  }

  get store(): Store {
    return this.deps.store;
  }

  private get nodeId(): string {
    return this.store.data.node.nodeId;
  }

  keys(group: GroupState): GroupKeys {
    let keys = this.keyCache.get(group.key);
    if (!keys) {
      keys = groupKeys(Buffer.from(group.key, "base64"));
      this.keyCache.set(group.key, keys);
    }
    return keys;
  }

  scopeOf(group: GroupState): GroupScope {
    const entry = group.entries[SCOPE_KEY];
    const parsed = entry ? GroupScopeSchema.safeParse(entry.v) : null;
    return parsed?.success ? parsed.data : DEFAULT_SCOPE;
  }

  /** Le premier groupe actif (dans l'ordre local) dont la portée couvre la clé la gère ici. */
  ownerOf(key: string): string | null {
    for (const group of this.store.data.groups) {
      if (group.enabled && keyInScope(this.scopeOf(group), key)) return group.id;
    }
    return null;
  }

  private owned(group: GroupState, key: string): boolean {
    return key === SCOPE_KEY || this.ownerOf(key) === group.id;
  }

  /** Travail qui touche le daemon (mise à jour de plugins) : jamais en même temps qu'un relevé ou une application. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.withSystemLock(async () => {
      this.applying += 1;
      try {
        return await work();
      } finally {
        this.applying -= 1;
        this.quietUntil = Date.now() + 4000;
      }
    });
  }

  /** Cette machine gère-t-elle la clé dans ce groupe (premier groupe qui la couvre) ? */
  owns(group: GroupState, key: string): boolean {
    return this.owned(group, key);
  }

  private withSystemLock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.systemLock.then(work, work);
    this.systemLock = next.catch(() => undefined);
    return next;
  }

  private activity(group: GroupState, key: string, action: "published" | "applied" | "deleted", origin: string): void {
    group.recent.unshift({ key, at: this.clock.now(), action, origin });
    if (group.recent.length > RECENT_MAX) group.recent.length = RECENT_MAX;
  }

  /** Garde une version dans l'historique de la clé (sans doublon, sans valeur trop grosse). */
  private remember(group: GroupState, key: string, entry: Entry): void {
    const list = (group.history[key] ??= []);
    if (list.some((old) => old.h === entry.h && old.o === entry.o && old.t === entry.t)) return;
    if (entry.v !== null && canonical(entry.v).length > HISTORY_MAX_VALUE) return;
    list.unshift({ ...entry });
    list.sort((x, y) => y.t - x.t);
    if (list.length > HISTORY_DEPTH) list.length = HISTORY_DEPTH;
  }

  /** Remplace la version d'un élément en gardant l'ancienne dans l'historique. */
  private publish(group: GroupState, key: string, value: Json): Entry {
    const previous = group.entries[key];
    if (previous) this.remember(group, key, previous);
    const entry: Entry = { v: value, h: hashValue(value), t: this.clock.tick(), o: this.nodeId, ...(previous ? { p: previous.h } : {}) };
    group.entries[key] = entry;
    return entry;
  }

  /** Nouvelle portée décidée ici : elle part comme un changement local. */
  setScope(group: GroupState, scope: GroupScope): void {
    this.publish(group, SCOPE_KEY, scope as unknown as Json);
    this.activity(group, SCOPE_KEY, "published", this.nodeId);
  }

  /** Republie une version de l'historique comme un nouveau changement fait ici : tout le groupe y revient. */
  restore(group: GroupState, key: string, hash: string): void {
    const version = (group.history[key] ?? []).find((entry) => entry.h === hash) ?? (group.entries[key]?.h === hash ? group.entries[key] : undefined);
    if (!version) throw new Error("Cette version n'est plus dans l'historique.");
    this.publish(group, key, version.v);
    delete group.attempts[key];
    delete group.rejected[key];
    group.conflicts = group.conflicts.filter((conflict) => conflict.key !== key);
    this.activity(group, key, version.v === null ? "deleted" : "published", this.nodeId);
  }

  /** Historique d'un élément, version actuelle comprise. */
  historyOf(group: GroupState, key: string): Array<{ h: string; t: number; origin: string; deletion: boolean; revision: string | null; current: boolean }> {
    const current = group.entries[key];
    const list = [...(current ? [current] : []), ...(group.history[key] ?? []).filter((entry) => entry.h !== current?.h || entry.t !== current?.t)];
    return list.map((entry) => ({
      h: entry.h,
      t: entry.t,
      origin: group.members[entry.o]?.label ?? entry.o,
      deletion: entry.v === null,
      revision: revisionOf(entry.v),
      current: entry === current,
    }));
  }

  /** Conflits vus ici et par les autres machines (comptes rendus), sans doublon, encore d'actualité. */
  private allConflicts(group: GroupState) {
    const merged = new Map<string, { key: string; at: number; winner: string; loser: string; winnerHash: string; loserHash: string; seenBy: string[] }>();
    const own = group.conflicts.map((conflict) => ({
      key: conflict.key,
      at: conflict.at,
      winner: conflict.winner.o,
      loser: conflict.loser.o,
      winnerHash: conflict.winner.h,
      loserHash: conflict.loser.h,
    }));
    const sources: Array<[string, typeof own]> = [[this.nodeId, own]];
    for (const [nodeId, report] of Object.entries(group.reports)) if (nodeId !== this.nodeId) sources.push([nodeId, report.conflicts]);
    for (const [nodeId, list] of sources) {
      for (const conflict of list) {
        // Un conflit dont la version gagnante n'est plus l'actuelle a été réglé depuis.
        if (group.entries[conflict.key]?.h !== conflict.winnerHash) continue;
        const id = `${conflict.key}|${conflict.winnerHash}|${conflict.loserHash}`;
        const known = merged.get(id);
        if (known) known.seenBy.push(nodeId);
        else merged.set(id, { ...conflict, seenBy: [nodeId] });
      }
    }
    return [...merged.values()].sort((x, y) => y.at - x.at);
  }

  /** Chaque élément reçu qui diffère de la version locale : historique et détection des conflits. */
  private compare(group: GroupState, key: string, current: Entry, incoming: Entry, replaced: boolean): void {
    // La version perdante (l'ancienne si remplacée, la reçue sinon) reste disponible pour une restauration.
    this.remember(group, key, replaced ? current : incoming);
    if (!concurrent(current, incoming)) return;
    const [winner, loser] = replaced ? [incoming, current] : [current, incoming];
    if (group.conflicts.some((conflict) => conflict.key === key && conflict.loser.h === loser.h && conflict.winner.h === winner.h)) return;
    group.conflicts.unshift({
      key,
      at: this.clock.now(),
      winner: { o: winner.o, h: winner.h, t: winner.t },
      loser: { o: loser.o, h: loser.h, t: loser.t },
    });
    if (group.conflicts.length > 20) group.conflicts.length = 20;
    this.deps.log(`${key} : conflit, ${group.members[winner.o]?.label ?? winner.o} l'emporte sur ${group.members[loser.o]?.label ?? loser.o}`);
  }

  private collectorFor(key: string): Collector | undefined {
    return this.deps.collectors.find((collector) => collector.owns(key));
  }

  /** Clé jamais synchronisée (fichier temporaire) : à oublier sans rien publier. */
  private ignored(key: string): boolean {
    return this.collectorFor(key)?.ignores?.(key) ?? false;
  }

  private async snapshot(scope: GroupScope): Promise<Map<string, Json>> {
    const all = new Map<string, Json>();
    for (const collector of this.deps.collectors) {
      for (const [key, value] of await collector.snapshot(scope)) all.set(key, value);
    }
    return all;
  }

  /** Étape 1 : publier les changements faits sur cette machine. */
  async scan(group: GroupState): Promise<void> {
    const scope = this.scopeOf(group);
    const local = await this.snapshot(scope);
    // Partie synchrone : rien ne s'intercale entre la lecture de la réplique et son écriture.
    const keys = new Set<string>([...local.keys(), ...Object.keys(group.baseline)]);
    for (const key of keys) {
      if (key === SCOPE_KEY || !keyInScope(scope, key) || !this.owned(group, key)) continue;
      if (this.ignored(key)) {
        delete group.baseline[key];
        continue;
      }
      // Exclu sur cette machine : ce qui s'y passe reste local.
      if (matchesExclusion(group.exclude, key)) continue;
      // Absent du relevé sans être supprimé (lu pendant une écriture, trop gros…) : rien à publier ce coup-ci.
      if (!local.has(key) && this.collectorFor(key)?.uncertain?.(key)) continue;
      const value = local.get(key) ?? null;
      const hash = hashValue(value);
      const base = group.baseline[key];
      const entry = group.entries[key];
      if (entry && entry.h === hash) delete group.attempts[key];
      // Version locale plus récente que celle du groupe (Sync lui-même) : elle repart, même sans changement ici.
      if (
        value !== null &&
        entry &&
        entry.v !== null &&
        entry.h !== hash &&
        group.mode !== "receive" &&
        this.collectorFor(key)?.preferLocal?.(key, value, entry.v)
      ) {
        this.publish(group, key, value);
        group.baseline[key] = hash;
        delete group.attempts[key];
        this.activity(group, key, "published", this.nodeId);
        continue;
      }
      if (base === hash) continue;
      if (base === undefined) {
        // Élément que cette machine n'avait jamais suivi : la valeur du groupe l'emporte si elle existe.
        if (value === null) continue;
        // (Une machine « send » impose au contraire son état.)
        if (entry && entry.v !== null && group.mode !== "send") continue;
      }
      if (entry && entry.h === hash) {
        group.baseline[key] = hash;
        continue;
      }
      if (group.mode === "receive") {
        // Cette machine ne publie rien : son état local est noté tel quel, puis ramené à celui du groupe.
        group.baseline[key] = hash;
        continue;
      }
      if (value === null && !scope.propagateDeletions) {
        // Suppression locale gardée pour soi : on se considère d'accord avec le groupe, sans le remettre ici.
        group.baseline[key] = entry?.h ?? hash;
        continue;
      }
      this.publish(group, key, value);
      group.baseline[key] = hash;
      delete group.attempts[key];
      this.activity(group, key, value === null ? "deleted" : "published", this.nodeId);
    }
  }

  /** Étape 3 : appliquer ici les changements du groupe. */
  async applyPending(group: GroupState): Promise<void> {
    if (group.mode === "send") return;
    const scope = this.scopeOf(group);
    const now = this.clock.now();
    const wanted = new Map<string, Entry>();
    for (const [key, entry] of Object.entries(group.entries)) {
      if (key === SCOPE_KEY || !keyInScope(scope, key) || !this.owned(group, key)) continue;
      if (this.ignored(key) || matchesExclusion(group.exclude, key)) continue;
      const base = group.baseline[key];
      if (entry.h === base) continue;
      if (base === undefined && entry.v === null) {
        group.baseline[key] = entry.h;
        continue;
      }
      if (group.rejected[key] === entry.h) continue;
      if (group.approval && group.approved[key] !== entry.h) continue;
      const attempt = group.attempts[key];
      if (attempt && attempt.h === entry.h && now - attempt.at < backoffMs(attempt.count)) continue;
      wanted.set(key, { ...entry });
    }
    if (wanted.size === 0) return;

    for (const collector of this.deps.collectors) {
      const changes = [...wanted].filter(([key]) => collector.owns(key)).map(([key, entry]) => ({ key, value: entry.v }));
      if (changes.length === 0) continue;
      this.applying += 1;
      let outcomes: Awaited<ReturnType<Collector["apply"]>>;
      try {
        outcomes = await collector.apply(changes);
      } finally {
        this.applying -= 1;
        this.quietUntil = Date.now() + 4000;
      }
      const errors = new Map(outcomes.map((outcome) => [outcome.key, outcome.error]));
      const deferred = new Set(outcomes.filter((outcome) => outcome.deferred).map((outcome) => outcome.key));
      // État réellement obtenu : il devient la nouvelle référence locale.
      let after: Map<string, Json>;
      try {
        after = await collector.snapshot(scope);
      } catch (error) {
        this.deps.log(`${collector.name} : relecture impossible après application (${describe(error)})`);
        continue;
      }
      for (const { key } of changes) {
        const entry = wanted.get(key)!;
        if (deferred.has(key)) {
          // Lancé, pas encore fait : on attend (sans échec) avant de relancer ; la référence locale ne bouge pas.
          const previous = group.attempts[key];
          const count = previous && previous.h === entry.h ? previous.count + 1 : 1;
          group.attempts[key] = { h: entry.h, at: this.clock.now(), error: null, count };
          continue;
        }
        let error = errors.get(key) ?? null;
        if (!after.has(key) && collector.uncertain?.(key)) {
          // État illisible juste après l'écriture : la référence ne bouge pas, on réessaiera plus tard.
          const previous = group.attempts[key];
          const count = previous && previous.h === entry.h ? previous.count + 1 : 1;
          const message = error ?? "écrit, mais illisible ou ignoré ici (taille, limite)";
          group.attempts[key] = { h: entry.h, at: this.clock.now(), error: message, count };
          continue;
        }
        const obtained = hashValue(after.get(key) ?? null);
        group.baseline[key] = obtained;
        error = errors.get(key) ?? null;
        if (obtained === entry.h && error === null) {
          delete group.attempts[key];
          delete group.approved[key];
          this.activity(group, key, entry.v === null ? "deleted" : "applied", entry.o);
        } else {
          const previous = group.attempts[key];
          const count = previous && previous.h === entry.h ? previous.count + 1 : 1;
          const message = error ?? "l'état obtenu diffère de celui du groupe";
          group.attempts[key] = { h: entry.h, at: this.clock.now(), error: message, count };
          this.deps.log(`${key} : ${message}`);
        }
      }
    }
  }

  /** Éléments que cette machine doit appliquer et n'a pas encore appliqués. */
  private pendingKeys(group: GroupState): string[] {
    if (group.mode === "send") return [];
    const scope = this.scopeOf(group);
    return Object.entries(group.entries)
      .filter(
        ([key, entry]) =>
          key !== SCOPE_KEY &&
          keyInScope(scope, key) &&
          this.owned(group, key) &&
          !this.ignored(key) &&
          !matchesExclusion(group.exclude, key) &&
          group.rejected[key] !== entry.h &&
          entry.h !== group.baseline[key] &&
          !(group.baseline[key] === undefined && entry.v === null),
      )
      .map(([key]) => key);
  }

  /** Changements reçus qui attendent l'accord de cette machine (mode approbation). */
  awaitingKeys(group: GroupState): string[] {
    if (!group.approval) return [];
    return this.pendingKeys(group).filter((key) => group.approved[key] !== group.entries[key]?.h);
  }

  /** Accord ou refus de changements en attente (mode approbation). */
  decide(group: GroupState, keys: string[] | "all", decision: "approve" | "reject"): number {
    const targets = keys === "all" ? this.awaitingKeys(group) : keys;
    let count = 0;
    for (const key of targets) {
      const entry = group.entries[key];
      if (!entry) continue;
      if (decision === "approve") {
        group.approved[key] = entry.h;
        delete group.rejected[key];
      } else {
        group.rejected[key] = entry.h;
        delete group.approved[key];
      }
      count += 1;
    }
    return count;
  }

  /** Les accords et refus portent sur une version : une version plus récente les rend caducs. */
  private pruneDecisions(group: GroupState): void {
    for (const map of [group.approved, group.rejected]) {
      for (const [key, hash] of Object.entries(map)) if (group.entries[key]?.h !== hash) delete map[key];
    }
  }

  /** Le compte rendu de cette machine, recalculé à chaque envoi pour rester à jour. */
  private refreshReport(group: GroupState): Report {
    const scope = this.scopeOf(group);
    const pending = this.pendingKeys(group);
    const errors = Object.fromEntries(
      Object.entries(group.attempts)
        .filter(([key, attempt]) => attempt.error && group.entries[key]?.h === attempt.h)
        .slice(0, REPORT_LIMIT)
        .map(([key, attempt]) => [key, (attempt.error ?? "").slice(0, 500)]),
    );
    const failed = new Set(Object.keys(errors));
    const waiting = new Set(pending);
    let applied = 0;
    for (const [key, entry] of Object.entries(group.entries)) {
      if (key === SCOPE_KEY || entry.v === null || !keyInScope(scope, key) || !this.owned(group, key)) continue;
      if (!waiting.has(key) && !failed.has(key)) applied += 1;
    }
    const report: Report = {
      at: this.clock.tick(),
      digest: replicaDigest(group.entries),
      version: SYNC_VERSION,
      mode: group.mode,
      applied,
      pendingTotal: pending.length,
      pending: pending.slice(0, REPORT_LIMIT),
      errors,
      excluded: group.exclude.slice(0, REPORT_LIMIT),
      awaiting: this.awaitingKeys(group).slice(0, REPORT_LIMIT),
      conflicts: group.conflicts.slice(0, 20).map((conflict) => ({
        key: conflict.key,
        at: conflict.at,
        winner: conflict.winner.o,
        loser: conflict.loser.o,
        winnerHash: conflict.winner.h,
        loserHash: conflict.loser.h,
      })),
    };
    group.reports[this.nodeId] = report;
    return report;
  }

  private identity(group: GroupState) {
    const url = this.deps.selfUrl();
    const pub = this.store.data.node.identity?.x;
    group.members[this.nodeId] = { label: this.store.data.node.label, url, seenAt: this.clock.now(), ...(pub ? { pub } : {}) };
    this.refreshReport(group);
    return {
      from: this.nodeId,
      label: this.store.data.node.label,
      url,
      ts: this.clock.now(),
      members: group.members,
      reports: group.reports,
      forgottenBefore: group.forgottenBefore,
    };
  }

  private versions(group: GroupState): Record<string, string> {
    return Object.fromEntries(Object.entries(group.entries).map(([key, entry]) => [key, versionOf(entry)]));
  }

  /** Ce que `entries` a de plus récent que les `versions` d'en face. */
  private newerThan(entries: Entries, versions: Record<string, string>): Entries {
    const out: Entries = {};
    for (const [key, entry] of Object.entries(entries)) {
      const theirs = versions[key] ? parseVersion(versions[key]) : null;
      if (!theirs || newer(entry, { v: null, ...theirs })) out[key] = entry;
    }
    return out;
  }

  /**
   * Un élément inconnu ici et plus ancien que l'horizon d'oubli est refusé : c'est ce qu'enverrait une machine revenue
   * après une longue absence avec un élément supprimé depuis, dont la trace de suppression a été oubliée (30 jours).
   */
  private admissible(group: GroupState, entries: Entries): Entries {
    if (group.forgottenBefore === 0) return entries;
    const out: Entries = {};
    for (const [key, entry] of Object.entries(entries)) {
      if (key !== SCOPE_KEY && group.entries[key] === undefined && entry.t <= group.forgottenBefore) continue;
      out[key] = entry;
    }
    return out;
  }

  /**
   * L'autre machine n'a pas `clé` et a oublié des suppressions jusqu'à `theirHorizon` : si notre version est plus
   * ancienne, elle l'a refusée ou oubliée. On l'oublie aussi ici (l'élément reste installé, sans être republié).
   */
  private forgetWhatTheyForgot(group: GroupState, theirVersions: Record<string, string>, theirHorizon: number | undefined): void {
    if (!theirHorizon) return;
    for (const [key, entry] of Object.entries(group.entries)) {
      if (key === SCOPE_KEY || theirVersions[key] !== undefined || entry.t > theirHorizon) continue;
      delete group.entries[key];
      this.deps.log(`${key} : supprimé ailleurs depuis longtemps, oublié de la réplique (reste installé ici)`);
    }
  }

  private absorb(
    group: GroupState,
    from: { from: string; label: string; url: string; members: GroupState["members"]; reports?: GroupState["reports"] },
    entries: Entries,
  ): string[] {
    entries = this.admissible(group, entries);
    this.clock.observe(maxTime(entries));
    const changed = mergeEntries(group.entries, entries, (key, current, incoming, replaced) => this.compare(group, key, current, incoming, replaced));
    mergeMembers(group.members, Object.fromEntries(Object.entries(from.members).filter(([nodeId]) => !group.revoked.includes(nodeId))), this.nodeId);
    // Seule cette machine parle d'elle-même : un compte rendu à son nom venu d'ailleurs est ignoré.
    const { [this.nodeId]: _mine, ...others } = from.reports ?? {};
    mergeReports(group.reports, others);
    if (from.from !== this.nodeId && validMemberUrl(from.url) && !group.revoked.includes(from.from)) {
      // La clé publique vient de la fiche que la machine publie sur elle-même (ou de celle déjà connue).
      const pub = from.members[from.from]?.pub ?? group.members[from.from]?.pub;
      group.members[from.from] = { label: from.label, url: from.url, seenAt: this.clock.now(), ...(pub ? { pub } : {}) };
    }
    return changed;
  }

  /** Requête entrante d'un membre. */
  async handleIncoming(groupId: string, request: SyncRequest): Promise<SyncResponse> {
    const found = this.store.findGroup(groupId, this.clock.now());
    if (!found || !found.group.enabled) throw new Error("groupe inactif");
    const group = found.group;
    if (found.stale) {
      // Ancienne clé : on ne lit rien de cette machine, on lui remet seulement l'avis (ou on lui dit qu'elle est retirée).
      const minimal = { from: this.nodeId, label: this.store.data.node.label, url: this.deps.selfUrl(), ts: this.clock.now(), members: {}, entries: {}, versions: {} };
      if (group.revoked.includes(request.from)) return { ...minimal, revoked: true };
      return group.rekey ? { ...minimal, rekey: group.rekey } : minimal;
    }
    if (request.type === "rekey") {
      this.applyRekey(group, request.payload);
      this.store.save();
      return { from: this.nodeId, label: this.store.data.node.label, url: this.deps.selfUrl(), ts: this.clock.now(), members: {}, entries: {}, versions: {} };
    }
    let changed: string[] = [];
    if (request.type === "push") {
      changed = this.absorb(group, request, request.entries);
    } else if (request.type === "pull") {
      this.absorb(group, request, {});
      this.forgetWhatTheyForgot(group, request.versions, request.forgottenBefore);
    } else {
      this.absorb(group, request, {});
    }
    const response: SyncResponse = {
      ...this.identity(group),
      entries: request.type === "pull" ? this.newerThan(group.entries, request.versions) : {},
      versions: this.versions(group),
      ...(request.type === "blobs" ? { blobs: this.readBlobs(request.want) } : {}),
    };
    this.store.save();
    if (changed.length > 0) this.trigger(group.id);
    return response;
  }

  private markRevoked(group: GroupState, by: string): void {
    group.enabled = false;
    group.revokedBy = by;
    group.lastError = `Cette machine a été retirée du groupe (par ${by}).`;
    this.deps.log(`groupe ${group.name} : ${group.lastError}`);
  }

  /** Bascule sur la nouvelle clé ; l'ancienne reste acceptée un temps, pour remettre l'avis aux retardataires. */
  private switchKey(group: GroupState, master: Buffer, rekey: Rekey): void {
    group.previous = { id: group.id, key: group.key, until: this.clock.now() + REKEY_GRACE_MS };
    group.id = rekey.newId;
    group.key = master.toString("base64");
    group.rekey = rekey;
    group.revoked = [...new Set([...group.revoked, ...rekey.removed])];
    // Adresses des machines retirées (liste des membres et adresses de départ déjà reconnues) : plus contactées.
    const removedUrls = new Set<string>();
    for (const nodeId of rekey.removed) {
      const url = group.members[nodeId]?.url;
      if (url) removedUrls.add(url);
      delete group.members[nodeId];
      delete group.reports[nodeId];
    }
    for (const [url, status] of Object.entries(group.peerStatus)) {
      if (status.nodeId && rekey.removed.includes(status.nodeId)) {
        removedUrls.add(url);
        delete group.peerStatus[url];
      }
    }
    group.peers = group.peers.filter((url) => !removedUrls.has(url));
    group.lastError = null;
  }

  /** Applique un avis de changement de mot de passe reçu ; renvoie vrai si la machine a basculé. */
  applyRekey(group: GroupState, rekey: Rekey): boolean {
    if (group.id !== rekey.oldId) return false;
    if (rekey.removed.includes(this.nodeId)) {
      this.markRevoked(group, group.members[rekey.from]?.label ?? rekey.from);
      return false;
    }
    const identity = this.store.data.node.identity;
    const master = identity ? unwrap(rekey, this.nodeId, identity) : null;
    if (!master || groupKeys(master).groupId !== rekey.newId) {
      group.lastError = "Le mot de passe du groupe a changé, mais cette machine n'a pas reçu la nouvelle clé : rejoignez le groupe avec le nouveau mot de passe.";
      return false;
    }
    if (this.store.group(rekey.newId)) {
      // Déjà rejointe à la main avec le nouveau mot de passe : l'ancienne copie s'efface d'elle-même.
      group.enabled = false;
      group.lastError = "Remplacé par le groupe rejoint avec le nouveau mot de passe.";
      return false;
    }
    this.switchKey(group, master, rekey);
    this.deps.log(`groupe ${group.name} : nouveau mot de passe appliqué`);
    this.trigger(group.id, 200);
    return true;
  }

  /**
   * Change le mot de passe du groupe (nouvelle clé déjà dérivée), en retirant éventuellement des machines.
   * Renvoie l'avis et l'ancienne clé (pour le remettre aux machines gardées), et les machines sans clé publique.
   */
  rekey(group: GroupState, master: Buffer, remove: string[]): { rekey: Rekey; oldKeys: GroupKeys; unreachable: string[]; notify: string[] } {
    const { groupId: newId } = groupKeys(master);
    if (newId === group.id) throw new Error("C'est déjà le mot de passe du groupe.");
    if (remove.includes(this.nodeId)) throw new Error("Pour retirer cette machine, quittez le groupe.");
    const oldKeys = this.keys(group);
    const base = { oldId: group.id, newId };
    const wraps: Rekey["wraps"] = {};
    const unreachable: string[] = [];
    for (const [nodeId, member] of Object.entries(group.members)) {
      if (remove.includes(nodeId) || nodeId === this.nodeId) continue;
      if (member.pub) wraps[nodeId] = wrapFor(master, member.pub, base, nodeId);
      else unreachable.push(member.label);
    }
    const rekey: Rekey = { ...base, from: this.nodeId, at: this.clock.now(), removed: [...new Set(remove)], wraps };
    // Toutes les machines sont prévenues, retirées comprises (elles cessent aussitôt d'essayer).
    const notify = Object.entries(group.members)
      .filter(([nodeId, member]) => nodeId !== this.nodeId && member.url)
      .map(([, member]) => member.url);
    this.switchKey(group, master, rekey);
    return { rekey, oldKeys, unreachable, notify };
  }

  /** Remet l'avis à ces machines, avec l'ancienne clé ; renvoie le nombre de machines jointes. */
  async announceRekey(group: GroupState, rekey: Rekey, oldKeys: GroupKeys, urls: string[]): Promise<number> {
    const results = await Promise.all(
      urls.map((url) =>
        this.deps
          .send(url, oldKeys, { type: "rekey", ...this.identity(group), members: {}, payload: rekey })
          .then(() => true)
          .catch(() => false),
      ),
    );
    return results.filter(Boolean).length;
  }

  /** Contenus demandés, jusqu'au plafond d'une réponse. */
  private readBlobs(want: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    let bytes = 0;
    for (const sha of want) {
      const content = this.deps.blobs?.get(sha);
      if (!content) continue;
      if (bytes > 0 && bytes + content.length > BLOBS_BYTES_PER_RESPONSE) break;
      bytes += content.length;
      out[sha] = content.toString("base64");
    }
    return out;
  }

  /** Empreintes des contenus nécessaires ici (fichiers à appliquer) et absents du magasin. */
  private missingBlobs(group: GroupState): string[] {
    const blobs = this.deps.blobs;
    if (!blobs) return [];
    const missing = new Set<string>();
    for (const key of this.pendingKeys(group)) {
      const sha = blobRef(group.entries[key]?.v);
      if (sha && !blobs.has(sha)) missing.add(sha);
    }
    return [...missing];
  }

  private async fetchBlobs(group: GroupState, url: string, keys: GroupKeys): Promise<void> {
    const blobs = this.deps.blobs;
    if (!blobs) return;
    let missing = this.missingBlobs(group);
    while (missing.length > 0) {
      const want = missing.slice(0, BLOBS_PER_REQUEST);
      const response = await this.deps.send(url, keys, { type: "blobs", ...this.identity(group), want });
      let received = 0;
      for (const [sha, b64] of Object.entries(response.blobs ?? {})) {
        if (!want.includes(sha)) continue;
        blobs.put(Buffer.from(b64, "base64"), sha);
        received += 1;
      }
      if (received === 0) return;
      missing = this.missingBlobs(group);
    }
  }

  private lastBlobGc = 0;
  /** Nettoyage du magasin (au plus toutes les 10 min) : on garde ce que référencent les répliques et leurs historiques. */
  private collectBlobs(): void {
    const blobs = this.deps.blobs;
    const now = this.clock.now();
    if (!blobs || now - this.lastBlobGc < 10 * 60_000) return;
    this.lastBlobGc = now;
    const keep = new Set(this.deps.blobsInUse?.() ?? []);
    for (const group of this.store.data.groups) {
      for (const entry of Object.values(group.entries)) {
        const sha = blobRef(entry.v);
        if (sha) keep.add(sha);
      }
      for (const list of Object.values(group.history)) {
        for (const entry of list) {
          const sha = blobRef(entry.v);
          if (sha) keep.add(sha);
        }
      }
    }
    const removed = blobs.gc(keep);
    if (removed > 0) this.deps.log(`magasin de contenus : ${removed} contenus inutilisés supprimés`);
  }

  private targets(group: GroupState): string[] {
    const self = this.deps.selfUrl();
    const urls = new Set<string>(group.peers);
    for (const [nodeId, member] of Object.entries(group.members)) if (nodeId !== this.nodeId && member.url) urls.add(member.url);
    urls.delete(self);
    // Une adresse dont on sait qu'elle mène à cette machine est sautée.
    return [...urls].filter((url) => group.peerStatus[url]?.nodeId !== this.nodeId);
  }

  /** Étape 2 : échanger avec chaque membre. Renvoie le nombre de membres joints. */
  async exchange(group: GroupState): Promise<number> {
    const keys = this.keys(group);
    let reached = 0;
    await Promise.all(
      this.targets(group).map(async (url) => {
        const status = (group.peerStatus[url] ??= { lastOkAt: null, lastError: null, nodeId: null });
        try {
          const pulled = await this.deps.send(url, keys, { type: "pull", ...this.identity(group), versions: this.versions(group) });
          status.nodeId = pulled.from;
          if (pulled.from === this.nodeId) return;
          if (pulled.revoked) {
            this.markRevoked(group, pulled.label);
            return;
          }
          if (pulled.rekey) {
            this.applyRekey(group, pulled.rekey);
            return;
          }
          this.absorb(group, pulled, pulled.entries);
          this.forgetWhatTheyForgot(group, pulled.versions, pulled.forgottenBefore);
          const toPush = this.newerThan(group.entries, pulled.versions);
          if (Object.keys(toPush).length > 0) await this.deps.send(url, keys, { type: "push", ...this.identity(group), entries: toPush });
          // Contenus de fichiers qui manquent ici pour appliquer : demandés à cette machine (une machine plus
          // ancienne ne sait pas répondre, ce n'est pas un échec de l'échange).
          await this.fetchBlobs(group, url, keys).catch((error) => this.deps.log(`contenus depuis ${url} : ${describe(error)}`));
          status.lastOkAt = this.clock.now();
          status.lastError = null;
          reached += 1;
        } catch (error) {
          status.lastError = describe(error);
        }
      }),
    );
    return reached;
  }

  /** Un passage complet pour un groupe. Les demandes pendant un passage en relancent un seul à la fin. */
  run(groupId: string): Promise<void> {
    const current = this.running.get(groupId);
    if (current) {
      this.rerun.add(groupId);
      return current;
    }
    const pass = this.pass(groupId).finally(() => {
      this.running.delete(groupId);
      if (this.rerun.delete(groupId)) void this.run(groupId);
    });
    this.running.set(groupId, pass);
    return pass;
  }

  private triggerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Passage bientôt (après une réception), regroupé. */
  trigger(groupId: string, delayMs = 1500): void {
    if (this.triggerTimers.has(groupId)) return;
    this.triggerTimers.set(
      groupId,
      setTimeout(() => {
        this.triggerTimers.delete(groupId);
        void this.run(groupId);
      }, delayMs),
    );
  }

  stop(): void {
    for (const timer of this.triggerTimers.values()) clearTimeout(timer);
    this.triggerTimers.clear();
  }

  private async pass(groupId: string): Promise<void> {
    const group = this.store.group(groupId);
    if (!group || !group.enabled) return;
    try {
      if (group.joining) {
        // Une machine qui rejoint attend d'avoir reçu la portée et l'état du groupe avant de publier quoi que ce soit.
        const reached = await this.exchange(group);
        if (reached === 0) {
          group.lastError = "en attente d'un premier contact avec le groupe";
          return;
        }
        group.joining = false;
        await this.withSystemLock(() => this.scan(group));
      } else {
        await this.withSystemLock(() => this.scan(group));
        await this.exchange(group);
      }
      await this.withSystemLock(() => this.applyPending(group));
      // Ce que l'application vient de changer ici repart aussitôt (et les réponses des membres aussi).
      await this.withSystemLock(() => this.scan(group));
      const now = this.clock.now();
      group.forgottenBefore = Math.max(group.forgottenBefore, pruneTombstones(group.entries, now));
      pruneMembers(group.members, now, this.nodeId);
      for (const nodeId of Object.keys(group.reports)) if (!group.members[nodeId]) delete group.reports[nodeId];
      this.pruneDecisions(group);
      for (const key of Object.keys(group.history)) if (!group.entries[key]) delete group.history[key];
      group.conflicts = group.conflicts.filter((conflict) => now - conflict.at < 7 * 24 * 3600 * 1000 && group.entries[conflict.key]);
      this.refreshReport(group);
      this.collectBlobs();
      if (group.previous && group.previous.until <= now) group.previous = null;
      group.lastSyncAt = now;
      group.lastError = this.targets(group).length === 0 ? "aucune autre machine connue" : null;
    } catch (error) {
      group.lastError = describe(error);
      this.deps.log(`groupe ${group.name} : ${group.lastError}`);
    } finally {
      this.store.save();
      this.deps.afterPass?.();
    }
  }

  view(group: GroupState): GroupView {
    const scope = this.scopeOf(group);
    const statusByNode = new Map<string, { lastOkAt: number | null; lastError: string | null }>();
    for (const status of Object.values(group.peerStatus)) if (status.nodeId) statusByNode.set(status.nodeId, status);
    const members = Object.entries(group.members).map(([nodeId, member]) => {
      const status = statusByNode.get(nodeId) ?? group.peerStatus[member.url];
      return {
        nodeId,
        label: member.label,
        url: member.url,
        seenAt: member.seenAt,
        self: nodeId === this.nodeId,
        lastOkAt: status?.lastOkAt ?? null,
        lastError: status?.lastError ?? null,
      };
    });
    // Adresses de départ pas encore jointes : affichées comme membres inconnus.
    for (const url of group.peers) {
      if (members.some((member) => member.url === url)) continue;
      const status = group.peerStatus[url];
      members.push({ nodeId: status?.nodeId ?? "", label: url, url, seenAt: 0, self: false, lastOkAt: status?.lastOkAt ?? null, lastError: status?.lastError ?? null });
    }
    let pending = 0;
    let items = 0;
    const shadowed: string[] = [];
    for (const [key, entry] of Object.entries(group.entries)) {
      if (key === SCOPE_KEY || !keyInScope(scope, key)) continue;
      if (!this.owned(group, key)) {
        shadowed.push(key);
        continue;
      }
      if (entry.v !== null) items += 1;
    }
    pending = this.pendingKeys(group).length;
    const problems = Object.entries(group.attempts)
      .filter(([, attempt]) => attempt.error)
      .map(([key, attempt]) => ({ key, error: attempt.error ?? "", at: attempt.at }));
    const { machines, itemStatus } = this.statusByMachine(group);
    const labelOf = (nodeId: string) => group.members[nodeId]?.label ?? nodeId;
    const awaiting = this.awaitingKeys(group).map((key) => {
      const entry = group.entries[key]!;
      return { key, deletion: entry.v === null, revision: revisionOf(entry.v), origin: labelOf(entry.o), at: entry.t };
    });
    return {
      id: group.id,
      name: group.name,
      exclude: group.exclude,
      approval: group.approval,
      awaiting,
      rejected: Object.keys(group.rejected),
      revokedBy: group.revokedBy,
      updates: {
        leader: (() => {
          const leader = updateLeader(group, this.nodeId, this.clock.now());
          return leader ? labelOf(leader) : null;
        })(),
        lastCheckAt: group.lastUpdateCheckAt,
        lastCheckError: group.lastUpdateCheckError,
        log: group.updateLog.slice(0, 10),
      },
      conflicts: this.allConflicts(group).map((conflict) => ({
        key: conflict.key,
        at: conflict.at,
        winner: labelOf(conflict.winner),
        loser: labelOf(conflict.loser),
        loserHash: conflict.loserHash,
        canRestore: (group.history[conflict.key] ?? []).some((entry) => entry.h === conflict.loserHash),
        seenBy: conflict.seenBy.map(labelOf),
      })),
      machines,
      itemStatus,
      mode: group.mode,
      enabled: group.enabled,
      peers: group.peers,
      scope,
      members,
      lastSyncAt: group.lastSyncAt,
      lastError: group.lastError,
      items,
      pending,
      problems,
      recent: group.recent.slice(0, 20),
      shadowed: shadowed.slice(0, 50),
    };
  }

  /** État de chaque élément sur chaque machine, d'après les comptes rendus. */
  statusByMachine(group: GroupState): Pick<GroupView, "machines" | "itemStatus"> {
    const own = this.refreshReport(group);
    const scope = this.scopeOf(group);
    const members = Object.entries(group.members).sort(([a], [b]) => (a === this.nodeId ? -1 : b === this.nodeId ? 1 : 0));
    const machines = members.map(([nodeId, member]) => {
      const report = nodeId === this.nodeId ? own : group.reports[nodeId];
      return {
        nodeId,
        label: member.label,
        self: nodeId === this.nodeId,
        version: report?.version ?? null,
        mode: report?.mode ?? null,
        upToDate: report ? report.digest === own.digest : null,
        reportAt: report?.at ?? null,
        applied: report?.applied ?? 0,
        pending: report?.pendingTotal ?? 0,
        errors: report ? Object.keys(report.errors).length : 0,
      };
    });

    // Les fichiers d'un même ensemble forment une seule ligne.
    const groupKey = (key: string) => (key.startsWith(KEY_PREFIX.file) ? key.split("/").slice(0, 2).join("/") : key);
    const items = new Map<string, string[]>();
    for (const [key, entry] of Object.entries(group.entries)) {
      if (key === SCOPE_KEY || entry.v === null || !keyInScope(scope, key) || this.ignored(key)) continue;
      const id = groupKey(key);
      items.set(id, [...(items.get(id) ?? []), key]);
    }

    const itemStatus = [...items].map(([id, keys]) => {
      const status = { key: id, count: keys.length, ok: [] as string[], pending: [] as string[], errors: [] as Array<{ machine: string; message: string }>, unknown: [] as string[], notApplied: [] as string[], excluded: [] as string[], awaiting: [] as string[] };
      for (const [nodeId, member] of members) {
        const report = nodeId === this.nodeId ? own : group.reports[nodeId];
        if (!report) {
          status.unknown.push(member.label);
          continue;
        }
        if (report.mode === "send") {
          status.notApplied.push(member.label);
          continue;
        }
        if (keys.every((key) => matchesExclusion(report.excluded, key))) {
          status.excluded.push(member.label);
          continue;
        }
        const failed = keys.find((key) => report.errors[key] !== undefined);
        if (failed) {
          status.errors.push({ machine: member.label, message: report.errors[failed]! });
          continue;
        }
        if (keys.some((key) => report.awaiting.includes(key))) {
          status.awaiting.push(member.label);
          continue;
        }
        if (keys.some((key) => report.pending.includes(key))) {
          status.pending.push(member.label);
          continue;
        }
        // Liste d'attente tronquée, ou réplique différente : on ne peut pas conclure.
        const truncated = report.pendingTotal > report.pending.length;
        if (report.digest === own.digest && !truncated) status.ok.push(member.label);
        else status.unknown.push(member.label);
      }
      return status;
    });
    // Plugins d'abord, puis réglages, config et fichiers ; problèmes en tête de chaque catégorie.
    const rank = (key: string) => ["self/", "plugin/", "settings/", "config/", "json/", "schedule/", "file/"].findIndex((prefix) => key.startsWith(prefix));
    itemStatus.sort((a, b) => rank(a.key) - rank(b.key) || b.errors.length - a.errors.length || a.key.localeCompare(b.key));
    return { machines, itemStatus };
  }

  status(node: StatusView["node"]): StatusView {
    return { node, groups: this.store.data.groups.map((group) => this.view(group)) };
  }
}
