import { createServer, type IncomingMessage, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { z } from "zod";
import { aad, open, seal, type Envelope, type GroupKeys } from "./crypto";
import { SHA_PATTERN } from "./blobs";
import { EntrySchema, MemberSchema, ReportSchema } from "./replica";

/**
 * Transport HTTP entre daemons. Tout le contenu est chiffré et authentifié (voir crypto.ts) : seul l'identifiant
 * public du groupe circule en clair. Le serveur répond 404 à tout ce qui ne vient pas d'un membre du groupe.
 *
 * Un échange = deux allers-retours :
 * 1. pull : A envoie les versions qu'il a ; B répond avec ce qu'il a de plus récent, et ses propres versions ;
 * 2. push : A envoie ce qu'il a de plus récent que B.
 */

export const PATH = "/paseo-sync/v1";
export const MAX_BODY = 192 * 1024 * 1024;
/** Écart d'horloge toléré entre deux machines pour un message. */
export const MAX_SKEW_MS = 15 * 60_000;
export const REQUEST_TIMEOUT_MS = 60_000;
/** Contenus demandés par requête, et volume rendu par réponse au plus (le reste vient à la requête suivante). */
export const BLOBS_PER_REQUEST = 500;
export const BLOBS_BYTES_PER_RESPONSE = 48 * 1024 * 1024;

const IdentitySchema = z.object({
  from: z.string().max(64),
  label: z.string().max(120),
  url: z.string().max(500),
  ts: z.number(),
  members: z.record(z.string(), MemberSchema),
  /** Absent chez les versions 0.1.3 et avant. */
  reports: z.record(z.string(), ReportSchema).optional(),
  /** Horizon d'oubli de l'expéditeur (absent avant 0.2.0). */
  forgottenBefore: z.number().optional(),
});

export const RequestSchema = z.discriminatedUnion("type", [
  IdentitySchema.extend({ type: z.literal("pull"), versions: z.record(z.string(), z.string()) }),
  IdentitySchema.extend({ type: z.literal("push"), entries: z.record(z.string(), EntrySchema) }),
  /** Demande de contenus de fichiers par empreinte (0.2.0). */
  IdentitySchema.extend({ type: z.literal("blobs"), want: z.array(z.string().regex(SHA_PATTERN)).max(BLOBS_PER_REQUEST) }),
]);
export type SyncRequest = z.infer<typeof RequestSchema>;

export const ResponseSchema = IdentitySchema.extend({
  entries: z.record(z.string(), EntrySchema),
  versions: z.record(z.string(), z.string()),
  /** Contenus demandés (base64), pour une requête « blobs ». */
  blobs: z.record(z.string().regex(SHA_PATTERN), z.string()).optional(),
});
export type SyncResponse = z.infer<typeof ResponseSchema>;

const EnvelopeSchema = z.object({ v: z.literal(1), g: z.string().max(64), n: z.string().max(64), c: z.string() });

export interface ServerHandler {
  keysFor(groupId: string): GroupKeys | null;
  handle(groupId: string, request: SyncRequest): Promise<SyncResponse>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface ListeningServer {
  close(): Promise<void>;
  address(): { host: string; port: number } | null;
}

export function startServer(
  host: string,
  port: number,
  handler: ServerHandler,
  log: (line: string) => void,
): Promise<ListeningServer> {
  const server: Server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === `${PATH}/ping`) return reply(200, { ok: true, protocol: "paseo-sync/v1" });
      if (req.method !== "POST" || req.url !== PATH) return reply(404, { error: "not found" });
      const envelope = EnvelopeSchema.safeParse(JSON.parse(await readBody(req)));
      if (!envelope.success) return reply(400, { error: "bad request" });
      const keys = handler.keysFor(envelope.data.g);
      if (!keys) return reply(404, { error: "unknown group" });
      const opened = open(keys, envelope.data as Envelope, aad("req", keys.groupId));
      const request = RequestSchema.safeParse(opened);
      if (opened === null || !request.success) return reply(403, { error: "forbidden" });
      if (Math.abs(Date.now() - request.data.ts) > MAX_SKEW_MS) return reply(403, { error: "clock skew" });
      const response = await handler.handle(keys.groupId, request.data);
      return reply(200, seal(keys, response, aad("res", keys.groupId, envelope.data.n)));
    } catch (error) {
      log(`requête entrante : ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) reply(500, { error: "internal" });
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS * 5;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      server.on("error", (error) => log(`serveur : ${error.message}`));
      resolve({
        close: () => new Promise((done) => server.close(() => done())),
        address: () => {
          const address = server.address();
          return address && typeof address === "object" ? { host: address.address, port: address.port } : null;
        },
      });
    });
  });
}

export class PeerError extends Error {}

export async function sendRequest(url: string, keys: GroupKeys, request: SyncRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<SyncResponse> {
  const envelope = seal(keys, request, aad("req", keys.groupId));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, "")}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
  } catch (error) {
    throw new PeerError(controller.signal.aborted ? "pas de réponse" : `injoignable (${(error as Error).cause ?? (error as Error).message})`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) throw new PeerError("groupe inconnu de cette machine (nom ou mot de passe différent ?)");
  if (res.status === 403) throw new PeerError("refusé (mot de passe différent ou horloge décalée)");
  if (!res.ok) throw new PeerError(`erreur HTTP ${res.status}`);
  const body = EnvelopeSchema.safeParse(await res.json());
  if (!body.success) throw new PeerError("réponse illisible");
  const opened = open(keys, body.data as Envelope, aad("res", keys.groupId, envelope.n));
  const parsed = ResponseSchema.safeParse(opened);
  if (opened === null || !parsed.success) throw new PeerError("réponse non authentifiée");
  return parsed.data;
}

/** Adresse annoncée par défaut : Tailscale (100.64.0.0/10) d'abord, puis la première IPv4 non locale. */
export function guessAddress(): string {
  const addresses: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) if (item.family === "IPv4" && !item.internal) addresses.push(item.address);
  }
  const tailscale = addresses.find((address) => {
    const [a, b] = address.split(".").map(Number);
    return a === 100 && b !== undefined && b >= 64 && b <= 127;
  });
  return tailscale ?? addresses[0] ?? "127.0.0.1";
}
