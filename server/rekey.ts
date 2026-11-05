import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { PROTOCOL } from "./crypto";

/**
 * Changement de mot de passe et retrait de machines.
 *
 * La clé d'un groupe dérive de son mot de passe : retirer une machine, c'est donc changer de mot de passe (sinon elle
 * recalculerait la clé). La machine qui change le mot de passe chiffre la nouvelle clé pour chaque machine gardée avec
 * la clé publique X25519 de celle-ci (publiée dans la liste des membres) : une machine retirée, même si elle connaît
 * l'ancienne clé et capte les échanges, ne peut pas lire la nouvelle.
 *
 * L'avis de changement circule chiffré avec l'ancienne clé : envoyé aussitôt à chaque machine gardée, puis remis à
 * une machine en retard quand elle se présente avec l'ancienne clé (acceptée `REKEY_GRACE_MS` pour cela seulement).
 */

export const REKEY_GRACE_MS = 30 * 24 * 3600 * 1000;

export const NodeIdentitySchema = z.object({ x: z.string(), d: z.string() });
export type NodeIdentity = z.infer<typeof NodeIdentitySchema>;

const WrapSchema = z.object({ epk: z.string().max(64), n: z.string().max(64), c: z.string().max(200) });
export const RekeySchema = z.object({
  oldId: z.string().max(64),
  newId: z.string().max(64),
  from: z.string().max(64),
  at: z.number(),
  removed: z.array(z.string().max(64)).max(200),
  /** Nouvelle clé chiffrée pour chaque machine gardée, par identifiant de machine. */
  wraps: z.record(z.string().max(64), WrapSchema),
});
export type Rekey = z.infer<typeof RekeySchema>;

export function newIdentity(): NodeIdentity {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; d: string };
  return { x: jwk.x, d: jwk.d };
}

const publicKey = (x: string) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });
const privateKeyOf = (identity: NodeIdentity) => createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: identity.x, d: identity.d }, format: "jwk" });

function wrapKey(shared: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), `${PROTOCOL}|rekey`, 32));
}

const wrapAad = (rekey: Pick<Rekey, "oldId" | "newId">, nodeId: string) => `${PROTOCOL}|rekey|${rekey.oldId}|${rekey.newId}|${nodeId}`;

/** Chiffre la nouvelle clé pour une machine, avec une clé éphémère (ECIES X25519 + AES-256-GCM). */
export function wrapFor(master: Buffer, recipientX: string, rekey: Pick<Rekey, "oldId" | "newId">, nodeId: string): z.infer<typeof WrapSchema> {
  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKey(recipientX) });
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrapKey(shared), nonce);
  cipher.setAAD(Buffer.from(wrapAad(rekey, nodeId)));
  const ct = Buffer.concat([cipher.update(master), cipher.final(), cipher.getAuthTag()]);
  const epk = (ephemeral.publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { epk, n: nonce.toString("base64"), c: ct.toString("base64") };
}

/** La nouvelle clé, ou null si l'avis ne contient rien de lisible pour cette machine. */
export function unwrap(rekey: Rekey, nodeId: string, identity: NodeIdentity): Buffer | null {
  const wrap = rekey.wraps[nodeId];
  if (!wrap) return null;
  try {
    const shared = diffieHellman({ privateKey: privateKeyOf(identity), publicKey: publicKey(wrap.epk) });
    const data = Buffer.from(wrap.c, "base64");
    const decipher = createDecipheriv("aes-256-gcm", wrapKey(shared), Buffer.from(wrap.n, "base64"));
    decipher.setAAD(Buffer.from(wrapAad(rekey, nodeId)));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  } catch {
    return null;
  }
}
