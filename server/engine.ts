import { DEFAULT_SCOPE, GroupScopeSchema, KEY_PREFIX, SCOPE_KEY, keyInScope, type GroupScope } from "../shared/model";
import type { GroupView, StatusView } from "../shared/rpc";
import type { Collector } from "./collectors";
import { groupKeys, hashValue, type GroupKeys } from "./crypto";
import {
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
} from "./replica";
import { SYNC_VERSION } from "../shared/version";
import type { GroupState, Store } from "./store";
import type { SyncRequest, SyncResponse } from "./transport";

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
}

const RECENT_MAX = 40;
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const versionOf = (entry: Entry) => `${entry.t}.${entry.o}.${entry.h}`;

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

  private withSystemLock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.systemLock.then(work, work);
    this.systemLock = next.catch(() => undefined);
    return next;
  }

  private activity(group: GroupState, key: string, action: "published" | "applied" | "deleted", origin: string): void {
    group.recent.unshift({ key, at: this.clock.now(), action, origin });
    if (group.recent.length > RECENT_MAX) group.recent.length = RECENT_MAX;
  }

  /** Nouvelle portée décidée ici : elle part comme un changement local. */
  setScope(group: GroupState, scope: GroupScope): void {
    const value = scope as unknown as Json;
    group.entries[SCOPE_KEY] = { v: value, h: hashValue(value), t: this.clock.tick(), o: this.nodeId };
    this.activity(group, SCOPE_KEY, "published", this.nodeId);
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
      // Absent du relevé sans être supprimé (lu pendant une écriture, trop gros…) : rien à publier ce coup-ci.
      if (!local.has(key) && this.collectorFor(key)?.uncertain?.(key)) continue;
      const value = local.get(key) ?? null;
      const hash = hashValue(value);
      const base = group.baseline[key];
      if (base === hash) continue;
      const entry = group.entries[key];
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
      group.entries[key] = { v: value, h: hash, t: this.clock.tick(), o: this.nodeId };
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
      if (this.ignored(key)) continue;
      const base = group.baseline[key];
      if (entry.h === base) continue;
      if (base === undefined && entry.v === null) {
        group.baseline[key] = entry.h;
        continue;
      }
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
      .filter(([key, entry]) => key !== SCOPE_KEY && keyInScope(scope, key) && this.owned(group, key) && !this.ignored(key) && entry.h !== group.baseline[key])
      .map(([key]) => key);
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
    };
    group.reports[this.nodeId] = report;
    return report;
  }

  private identity(group: GroupState) {
    const url = this.deps.selfUrl();
    group.members[this.nodeId] = { label: this.store.data.node.label, url, seenAt: this.clock.now() };
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
    const changed = mergeEntries(group.entries, entries);
    mergeMembers(group.members, from.members);
    // Seule cette machine parle d'elle-même : un compte rendu à son nom venu d'ailleurs est ignoré.
    const { [this.nodeId]: _mine, ...others } = from.reports ?? {};
    mergeReports(group.reports, others);
    if (from.from !== this.nodeId && validMemberUrl(from.url)) group.members[from.from] = { label: from.label, url: from.url, seenAt: this.clock.now() };
    return changed;
  }

  /** Requête entrante d'un membre. */
  async handleIncoming(groupId: string, request: SyncRequest): Promise<SyncResponse> {
    const group = this.store.group(groupId);
    if (!group || !group.enabled) throw new Error("groupe inactif");
    let changed: string[] = [];
    if (request.type === "push") {
      changed = this.absorb(group, request, request.entries);
    } else {
      this.absorb(group, request, {});
      this.forgetWhatTheyForgot(group, request.versions, request.forgottenBefore);
    }
    const response: SyncResponse = {
      ...this.identity(group),
      entries: request.type === "pull" ? this.newerThan(group.entries, request.versions) : {},
      versions: this.versions(group),
    };
    this.store.save();
    if (changed.length > 0) this.trigger(group.id);
    return response;
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
          this.absorb(group, pulled, pulled.entries);
          this.forgetWhatTheyForgot(group, pulled.versions, pulled.forgottenBefore);
          const toPush = this.newerThan(group.entries, pulled.versions);
          if (Object.keys(toPush).length > 0) await this.deps.send(url, keys, { type: "push", ...this.identity(group), entries: toPush });
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
      this.refreshReport(group);
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
      if (group.mode !== "send" && entry.h !== group.baseline[key]) pending += 1;
    }
    const problems = Object.entries(group.attempts)
      .filter(([, attempt]) => attempt.error)
      .map(([key, attempt]) => ({ key, error: attempt.error ?? "", at: attempt.at }));
    const { machines, itemStatus } = this.statusByMachine(group);
    return {
      id: group.id,
      name: group.name,
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
      const status = { key: id, count: keys.length, ok: [] as string[], pending: [] as string[], errors: [] as Array<{ machine: string; message: string }>, unknown: [] as string[], notApplied: [] as string[] };
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
        const failed = keys.find((key) => report.errors[key] !== undefined);
        if (failed) {
          status.errors.push({ machine: member.label, message: report.errors[failed]! });
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
    const rank = (key: string) => ["plugin/", "settings/", "config/", "file/"].findIndex((prefix) => key.startsWith(prefix));
    itemStatus.sort((a, b) => rank(a.key) - rank(b.key) || b.errors.length - a.errors.length || a.key.localeCompare(b.key));
    return { machines, itemStatus };
  }

  status(node: StatusView["node"]): StatusView {
    return { node, groups: this.store.data.groups.map((group) => this.view(group)) };
  }
}
