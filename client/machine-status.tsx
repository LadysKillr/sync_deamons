import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { GroupView, ItemStatus } from "../shared/rpc";
import { itemLabel } from "./labels";
import { SYNC_VERSION } from "../shared/version";
import { HistoryPanel } from "./panels";
import type { Styles } from "./ui";

function machineState(s: Styles, machine: GroupView["machines"][number]): { text: string; style: object } {
  if (machine.version === null) return { text: "Sync trop ancien pour rendre compte (0.1.3 ou avant)", style: s.muted };
  if (machine.errors > 0) return { text: `${machine.errors} en échec`, style: s.danger };
  if (machine.mode === "send") return { text: "envoie seulement (n'applique rien)", style: s.muted };
  if (machine.pending > 0) return { text: `${machine.pending} en cours`, style: s.warning };
  if (machine.upToDate === false) return { text: "synchronisation en cours", style: s.warning };
  return { text: `à jour · ${machine.applied} éléments appliqués`, style: s.success };
}

/** Une ligne par machine, puis le détail par élément (plugins d'abord). */
export function MachineStatusPanel({ s, group, onChanged }: { s: Styles; group: GroupView; onChanged(): void }) {
  const [detail, setDetail] = useState(false);
  const total = group.machines.length;
  const problems = group.itemStatus.filter((item) => item.errors.length > 0);
  const plugins = group.itemStatus.filter((item) => item.key.startsWith("plugin/"));
  const shown = detail ? group.itemStatus : problems;

  return (
    <View style={{ gap: 4 }}>
      <Text style={s.muted}>Application sur chaque machine :</Text>
      {group.machines.map((machine) => {
        const state = machineState(s, machine);
        const outdated = machine.version !== null && machine.version !== SYNC_VERSION;
        return (
          <Text key={machine.nodeId} style={s.text}>
            {machine.label}
            {machine.self ? " (ici)" : ""} <Text style={s.muted}>· Sync {machine.version ?? "?"}</Text>
            {outdated ? <Text style={s.warning}> (≠ {SYNC_VERSION})</Text> : null} · <Text style={state.style}>{state.text}</Text>
          </Text>
        );
      })}
      {plugins.length > 0 ? (
        <Text style={s.muted}>
          Plugins installés partout : {plugins.filter((item) => item.ok.length + item.notApplied.length + item.excluded.length === total).length}/{plugins.length}
        </Text>
      ) : null}
      {shown.map((item) => (
        <ItemLine key={item.key} s={s} item={item} total={total} groupId={group.id} onChanged={onChanged} withHistory={detail} />
      ))}
      <Pressable accessibilityRole="button" onPress={() => setDetail(!detail)}>
        <Text style={[s.muted, { textDecorationLine: "underline" }]}>{detail ? "Masquer le détail par élément" : "Voir le détail par élément"}</Text>
      </Pressable>
    </View>
  );
}

function ItemLine(props: { s: Styles; item: ItemStatus; total: number; groupId: string; onChanged(): void; withHistory: boolean }) {
  const { s, item, total } = props;
  const [history, setHistory] = useState(false);
  const applying = total - item.notApplied.length - item.excluded.length;
  const done = item.ok.length === applying;
  // Un ensemble de fichiers n'a pas d'historique d'ensemble (chaque fichier a le sien).
  const canHistory = props.withHistory && !item.key.startsWith("file/");
  return (
    <View style={{ gap: 1 }}>
      <View style={s.row}>
        <Text style={s.text}>
          <Text style={item.errors.length ? s.danger : done ? s.success : s.warning}>{item.errors.length ? "✗ " : done ? "✓ " : "… "}</Text>
          {itemLabel(item)} <Text style={s.muted}>· {item.ok.length}/{applying}</Text>
        </Text>
        {canHistory ? (
          <Pressable accessibilityRole="button" onPress={() => setHistory(!history)}>
            <Text style={[s.muted, { textDecorationLine: "underline" }]}>{history ? "masquer l'historique" : "historique"}</Text>
          </Pressable>
        ) : null}
      </View>
      {item.errors.map((error) => (
        <Text key={error.machine} style={[s.danger, { paddingLeft: 16 }]}>
          {error.machine} : {error.message}
        </Text>
      ))}
      {item.awaiting.length ? <Text style={[s.warning, { paddingLeft: 16 }]}>attend un accord : {item.awaiting.join(", ")}</Text> : null}
      {item.pending.length ? <Text style={[s.warning, { paddingLeft: 16 }]}>en cours : {item.pending.join(", ")}</Text> : null}
      {item.excluded.length ? <Text style={[s.muted, { paddingLeft: 16 }]}>exclu sur : {item.excluded.join(", ")}</Text> : null}
      {item.unknown.length ? <Text style={[s.muted, { paddingLeft: 16 }]}>état inconnu : {item.unknown.join(", ")}</Text> : null}
      {history ? <HistoryPanel s={s} groupId={props.groupId} itemKey={item.key} onChanged={props.onChanged} /> : null}
    </View>
  );
}
