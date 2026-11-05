import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Chiffrement des échanges entre daemons.
 *
 * - Clé maîtresse : scrypt(mot de passe NFC, sel) avec N = 2^15, r = 8, p = 1, 32 octets.
 *   Le sel dérive du nom du groupe : deux machines qui tapent le même nom et le même mot de passe ont la même clé,
 *   sans rien d'autre à échanger.
 * - Sous-clés HKDF-SHA256 : une pour chiffrer, une pour l'identifiant public du groupe (ce qui circule en clair
 *   dans une requête ne révèle ni le nom ni le mot de passe).
 * - Messages : AES-256-GCM, nonce aléatoire de 12 octets, AAD qui lie le message à son sens (requête / réponse),
 *   au groupe et, pour une réponse, au nonce de la requête. Contenu compressé (deflate) avant chiffrement.
 *
 * Le mot de passe n'est jamais gardé : seule la clé maîtresse l'est, dans un fichier lisible par l'utilisateur seul.
 */

export const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 } as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const PROTOCOL = "paseo-sync/v1";

export function normalizeGroupName(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

export function groupSalt(name: string): Buffer {
  return createHash("sha256").update(`${PROTOCOL}|salt|${normalizeGroupName(name)}`).digest();
}

export function deriveMasterKey(password: string, name: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFC"), groupSalt(name), SCRYPT.keyLength, SCRYPT, (error, key) =>
      // Message fixe : l'erreur ne doit rien emporter du mot de passe.
      error ? reject(new Error("Dérivation de la clé impossible.")) : resolve(key),
    );
  });
}

export interface GroupKeys {
  /** Identifiant public du groupe : 32 caractères hexadécimaux. */
  groupId: string;
  enc: Buffer;
}

export function groupKeys(master: Buffer): GroupKeys {
  const enc = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `${PROTOCOL}|enc`, 32));
  const groupId = createHmac("sha256", master).update(`${PROTOCOL}|group-id`).digest("hex").slice(0, 32);
  return { groupId, enc };
}

export interface Envelope {
  v: 1;
  g: string;
  n: string;
  c: string;
}

export function aad(kind: "req" | "res", groupId: string, extra = ""): string {
  return `${PROTOCOL}|${kind}|${groupId}|${extra}`;
}

export function seal(keys: GroupKeys, payload: unknown, additional: string): Envelope {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keys.enc, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(additional, "utf8"));
  const plain = deflateRawSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, g: keys.groupId, n: nonce.toString("base64"), c: ct.toString("base64") };
}

/** Le contenu, ou null : mauvaise clé, AAD différent, message abîmé. Ne lève jamais. */
export function open(keys: GroupKeys, envelope: Envelope, additional: string, maxBytes = 256 * 1024 * 1024): unknown | null {
  try {
    if (envelope.v !== 1 || envelope.g !== keys.groupId) return null;
    const nonce = Buffer.from(envelope.n, "base64");
    const data = Buffer.from(envelope.c, "base64");
    if (nonce.length !== NONCE_BYTES || data.length < TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", keys.enc, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(additional, "utf8"));
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]);
    return JSON.parse(inflateRawSync(plain, { maxOutputLength: maxBytes }).toString("utf8"));
  } catch {
    return null;
  }
}

/** Empreinte stable d'une valeur JSON (clés triées). */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

export function hashValue(value: unknown): string {
  if (value === null || value === undefined) return "deleted";
  return createHash("sha256").update(canonical(value)).digest("base64url").slice(0, 32);
}
