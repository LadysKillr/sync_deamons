import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newIdentity, unwrap, wrapFor, type Rekey } from "../server/rekey";

describe("clé chiffrée pour chaque machine", () => {
  it("seule la machine destinataire lit la nouvelle clé", () => {
    const master = randomBytes(32);
    const kept = newIdentity();
    const removed = newIdentity();
    const base = { oldId: "ancien", newId: "nouveau" };
    const rekey: Rekey = { ...base, from: "n_a", at: 1, removed: ["n_c"], wraps: { n_b: wrapFor(master, kept.x, base, "n_b") } };
    expect(unwrap(rekey, "n_b", kept)?.equals(master)).toBe(true);
    // La machine retirée n'a pas d'enveloppe, et ne peut pas ouvrir celle d'une autre.
    expect(unwrap(rekey, "n_c", removed)).toBeNull();
    expect(unwrap({ ...rekey, wraps: { n_c: rekey.wraps.n_b! } }, "n_c", removed)).toBeNull();
    // L'enveloppe est liée au changement : réutilisée pour un autre identifiant, elle ne s'ouvre pas.
    expect(unwrap({ ...rekey, newId: "autre" }, "n_b", kept)).toBeNull();
  });
});
