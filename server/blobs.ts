import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Contenus des fichiers synchronisés, rangés par empreinte (sha256, base64url) dans `plugin-data/sync/blobs/`.
 * La réplique ne porte que la référence : `state.json` reste petit et les échanges ne transfèrent un contenu qu'une
 * fois, à la machine qui ne l'a pas encore.
 */

export const SHA_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("base64url");
}

export class BlobStore {
  constructor(readonly dir: string) {}

  private file(sha: string): string {
    if (!SHA_PATTERN.test(sha)) throw new Error("empreinte de contenu invalide");
    return path.join(this.dir, sha.slice(0, 2), sha);
  }

  has(sha: string): boolean {
    return SHA_PATTERN.test(sha) && existsSync(this.file(sha));
  }

  get(sha: string): Buffer | null {
    if (!this.has(sha)) return null;
    try {
      return readFileSync(this.file(sha));
    } catch {
      return null;
    }
  }

  /** Range un contenu ; renvoie son empreinte. Un contenu reçu dont l'empreinte ne correspond pas est refusé. */
  put(content: Buffer, expected?: string): string {
    const sha = sha256(content);
    if (expected !== undefined && expected !== sha) throw new Error("contenu reçu altéré (empreinte différente)");
    const target = this.file(sha);
    if (existsSync(target)) return sha;
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, content, { mode: 0o600 });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    return sha;
  }

  /** Supprime les contenus qui ne sont plus référencés ; renvoie le nombre de contenus supprimés. */
  gc(keep: ReadonlySet<string>): number {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const prefix of readdirSync(this.dir)) {
      const sub = path.join(this.dir, prefix);
      for (const name of readdirSync(sub)) {
        if (SHA_PATTERN.test(name) && keep.has(name)) continue;
        rmSync(path.join(sub, name), { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}

/** Référence de contenu d'une valeur de fichier (`{ sha, size, mode }`), ou null. */
export function blobRef(value: unknown): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sha = (value as { sha?: unknown }).sha;
    if (typeof sha === "string" && SHA_PATTERN.test(sha)) return sha;
  }
  return null;
}
