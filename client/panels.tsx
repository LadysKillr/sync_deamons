import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { KEY_PREFIX } from "../shared/model";
import { checkUpdatesRpc, decideRpc, groupUpdateRpc, historyRpc, rekeyRpc, restoreRpc, type GroupView, type HistoryEntry } from "../shared/rpc";
import { itemLabel } from "./labels";
import { Button, Chip, Field, Toggle, ago, type Styles } from "./ui";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      done?.();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const shortRevision = (revision: string | null) => (revision ? (revision.length > 12 ? revision.slice(0, 7) : revision) : null);
const keyLabel = (key: string) => itemLabel({ key: key.startsWith(KEY_PREFIX.file) ? key.split("/").slice(0, 2).join("/") : key, count: 1 }).replace(" (1)", "");

const divider = (s: Styles) => ({ gap: 8, borderTopWidth: 1, borderTopColor: s.c.border, paddingTop: 10 });

/** Réglages propres à cette machine dans ce groupe : exclusions et mode approbation. */
export function LocalPanel({ s, group, onSaved }: { s: Styles; group: GroupView; onSaved(): void }) {
  const update = useRpc(groupUpdateRpc);
  const [exclude, setExclude] = useState<string[]>(group.exclude);
  const [approval, setApproval] = useState(group.approval);
  const [custom, setCustom] = useState("");
  const action = useBusy();
  // Éléments connus du groupe, plus les exclusions déjà posées (même si l'élément a disparu depuis).
  const known = [...new Set([...group.itemStatus.map((item) => item.key), ...exclude])].sort();
  const toggle = (key: string) => setExclude(exclude.includes(key) ? exclude.filter((item) => item !== key) : [...exclude, key]);

  return (
    <View style={divider(s)}>
      <Text style={s.muted}>Ces réglages ne valent que pour cette machine ; le reste du groupe n'est pas touché.</Text>
      <Text style={s.text}>Exclure ici :</Text>
      <View style={s.row}>
        {known.map((key) => (
          <Chip key={key} s={s} label={keyLabel(key)} active={exclude.includes(key)} onPress={() => toggle(key)} />
        ))}
      </View>
      <View style={s.row}>
        <Field s={s} label="Autre clé ou préfixe à exclure" value={custom} onChange={setCustom} placeholder="plugin/kanban, file/skills, config/agents" />
        <Button
          s={s}
          label="Ajouter"
          disabled={!custom.trim()}
          onPress={() => {
            setExclude([...new Set([...exclude, ...custom.split(",").map((item) => item.trim()).filter(Boolean)])]);
            setCustom("");
          }}
        />
      </View>
      <Text style={s.muted}>Un plugin exclu emporte ses réglages. Ce qui est exclu n'est ni installé ni publié depuis ici.</Text>
      <Toggle s={s} label="Mode approbation : les changements reçus attendent mon accord avant d'être appliqués ici" value={approval} onChange={setApproval} />
      {action.error ? <Text style={s.danger}>{action.error}</Text> : null}
      <Button s={s} kind="primary" label="Enregistrer pour cette machine" disabled={action.busy} onPress={() => action.run(() => update({ id: group.id, exclude, approval }), onSaved)} />
    </View>
  );
}

/** Changements reçus en attente d'accord (mode approbation). */
export function AwaitingPanel({ s, group, onChanged }: { s: Styles; group: GroupView; onChanged(): void }) {
  const decide = useRpc(decideRpc);
  const action = useBusy();
  if (!group.approval || group.awaiting.length === 0) return null;
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.warning}>{group.awaiting.length} changement(s) attendent votre accord :</Text>
      {group.awaiting.map((change) => (
        <View key={change.key} style={s.row}>
          <Text style={s.text}>
            {change.deletion ? "Supprimer" : "Appliquer"} {keyLabel(change.key)}
            {change.revision ? ` → ${shortRevision(change.revision)}` : ""} <Text style={s.muted}>· de {change.origin}, {ago(change.at)}</Text>
          </Text>
          <Button s={s} label="Appliquer" disabled={action.busy} onPress={() => action.run(() => decide({ id: group.id, keys: [change.key], decision: "approve" }), onChanged)} />
          <Button s={s} label="Refuser" disabled={action.busy} onPress={() => action.run(() => decide({ id: group.id, keys: [change.key], decision: "reject" }), onChanged)} />
        </View>
      ))}
      {group.awaiting.length > 1 ? (
        <Button s={s} kind="primary" label="Tout appliquer" disabled={action.busy} onPress={() => action.run(() => decide({ id: group.id, keys: "all", decision: "approve" }), onChanged)} />
      ) : null}
      {group.rejected.length > 0 ? <Text style={s.muted}>Refusés ici (jusqu'à leur prochaine version) : {group.rejected.map(keyLabel).join(", ")}</Text> : null}
      {action.error ? <Text style={s.danger}>{action.error}</Text> : null}
    </View>
  );
}

/** Conflits récents : deux machines ont modifié le même élément sans se voir. */
export function ConflictsPanel({ s, group, onChanged }: { s: Styles; group: GroupView; onChanged(): void }) {
  const restore = useRpc(restoreRpc);
  const action = useBusy();
  if (group.conflicts.length === 0) return null;
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.warning}>Conflits :</Text>
      {group.conflicts.map((conflict) => (
        <View key={`${conflict.key}-${conflict.loserHash}`} style={s.row}>
          <Text style={s.text}>
            {keyLabel(conflict.key)} : {conflict.winner} et {conflict.loser} l'ont modifié en même temps ; la version de {conflict.winner} est gardée{" "}
            <Text style={s.muted}>({ago(conflict.at)})</Text>
          </Text>
          {conflict.canRestore ? (
            <Button
              s={s}
              label={`Garder plutôt celle de ${conflict.loser}`}
              disabled={action.busy}
              onPress={() => action.run(() => restore({ id: group.id, key: conflict.key, hash: conflict.loserHash }), onChanged)}
            />
          ) : (
            <Text style={s.muted}>(la version de {conflict.loser} peut être rétablie depuis {conflict.loser})</Text>
          )}
        </View>
      ))}
      {action.error ? <Text style={s.danger}>{action.error}</Text> : null}
    </View>
  );
}

/** Historique d'un élément, avec retour à une version précédente pour tout le groupe. */
export function HistoryPanel({ s, groupId, itemKey, onChanged }: { s: Styles; groupId: string; itemKey: string; onChanged(): void }) {
  const history = useRpc(historyRpc);
  const restore = useRpc(restoreRpc);
  const [versions, setVersions] = useState<HistoryEntry[] | null>(null);
  const action = useBusy();
  useEffect(() => {
    void history({ id: groupId, key: itemKey })
      .then((result) => setVersions(result.versions))
      .catch(() => setVersions([]));
    // Chargé une fois à l'ouverture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, itemKey]);
  if (versions === null) return <Text style={s.muted}>Chargement de l'historique…</Text>;
  return (
    <View style={{ gap: 2, paddingLeft: 16 }}>
      {versions.length === 0 ? <Text style={s.muted}>Pas d'historique.</Text> : null}
      {versions.map((version) => (
        <View key={`${version.h}-${version.t}`} style={s.row}>
          <Text style={version.current ? s.text : s.muted}>
            {version.current ? "● actuelle" : "○"} · {version.deletion ? "supprimé" : shortRevision(version.revision) ?? "version"} · {version.origin}, {ago(version.t)}
          </Text>
          {!version.current ? (
            <Button s={s} label="Revenir à cette version partout" disabled={action.busy} onPress={() => action.run(() => restore({ id: groupId, key: itemKey, hash: version.h }), onChanged)} />
          ) : null}
        </View>
      ))}
      {action.error ? <Text style={s.danger}>{action.error}</Text> : null}
    </View>
  );
}

/** Suivi des mises à jour des plugins (si le groupe l'a activé). */
export function UpdatesPanel({ s, group, onChanged }: { s: Styles; group: GroupView; onChanged(): void }) {
  const check = useRpc(checkUpdatesRpc);
  const action = useBusy();
  if (!group.scope.autoUpdatePlugins) return null;
  const { updates } = group;
  return (
    <View style={{ gap: 2 }}>
      <Text style={s.muted}>
        Mises à jour des plugins : vérifiées par {updates.leader ?? "aucune machine"} toutes les 6 h
        {updates.lastCheckAt ? ` · dernière vérification ici ${ago(updates.lastCheckAt)}` : ""}
      </Text>
      {updates.lastCheckError ? <Text style={s.danger}>{updates.lastCheckError}</Text> : null}
      {updates.log.slice(0, 5).map((entry) => (
        <Text key={`${entry.id}-${entry.at}`} style={entry.error ? s.danger : s.muted}>
          {ago(entry.at)} · {entry.id} {shortRevision(entry.from) ?? "?"} → {shortRevision(entry.to) ?? "?"}
          {entry.error ? ` : ${entry.error}` : ""}
        </Text>
      ))}
      <Button s={s} label="Vérifier maintenant" disabled={action.busy} onPress={() => action.run(() => check({}), onChanged)} />
      {action.error ? <Text style={s.danger}>{action.error}</Text> : null}
    </View>
  );
}

/** Nouveau mot de passe, en retirant éventuellement des machines. */
export function PasswordPanel({ s, group, onSaved }: { s: Styles; group: GroupView; onSaved(): void }) {
  const rekey = useRpc(rekeyRpc);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remove, setRemove] = useState<string[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const action = useBusy();
  const others = group.members.filter((member) => !member.self && member.nodeId);
  const mismatch = confirm.length > 0 && confirm !== password;

  return (
    <View style={divider(s)}>
      <Text style={s.muted}>
        La nouvelle clé est envoyée chiffrée à chaque machine gardée ; une machine éteinte la recevra à son retour (30 jours). Une machine
        retirée ne peut plus rien lire ni envoyer, même si elle connaît l'ancien mot de passe.
      </Text>
      <View style={s.row}>
        <Field s={s} secure label="Nouveau mot de passe" value={password} onChange={setPassword} />
        <Field s={s} secure label="Encore une fois" value={confirm} onChange={setConfirm} />
      </View>
      {mismatch ? <Text style={s.danger}>Les deux mots de passe diffèrent.</Text> : null}
      {others.length > 0 ? <Text style={s.text}>Retirer du groupe :</Text> : null}
      <View style={s.row}>
        {others.map((member) => (
          <Chip
            key={member.nodeId}
            s={s}
            label={member.label}
            active={remove.includes(member.nodeId)}
            onPress={() => setRemove(remove.includes(member.nodeId) ? remove.filter((id) => id !== member.nodeId) : [...remove, member.nodeId])}
          />
        ))}
      </View>
      {action.error ? <Text style={s.danger}>{action.error}</Text> : null}
      {result ? <Text style={s.success}>{result}</Text> : null}
      <Button
        s={s}
        kind="danger"
        label={remove.length > 0 ? `Changer le mot de passe et retirer ${remove.length} machine(s)` : "Changer le mot de passe"}
        disabled={action.busy || password.length < 8 || password !== confirm}
        onPress={() =>
          action.run(async () => {
            const done = await rekey({ id: group.id, password, remove });
            setPassword("");
            setConfirm("");
            setRemove([]);
            setResult(
              `Nouveau mot de passe en place : ${done.reached} machine(s) prévenue(s) tout de suite.` +
                (done.unreachable.length ? ` Sync trop ancien sur ${done.unreachable.join(", ")} : à rejoindre à la main.` : ""),
            );
            onSaved();
          })
        }
      />
    </View>
  );
}
