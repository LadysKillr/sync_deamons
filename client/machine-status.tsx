import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { GroupView, ItemStatus } from "../shared/rpc";
import { SYNC_VERSION } from "../shared/version";
import type { Styles } from "./ui";

/** Nom lisible d'un élément : « plugin/kanban » → « kanban », « file/skills » → « fichiers skills ». */
export function itemLabel(item: Pick<ItemStatus, "key" | "count">): string {
  const [kind = "", ...rest] = item.key.split("/");
  const name = rest.join("/");
  if (kind === "plugin") return name;
  if (kind === "settings") return `réglages ${name}`;
  if (kind === "config") return `config ${name}`;
  if (kind === "file") return `fichiers ${name} (${item.count})`;
  return item.key;
}

function machineState(s: Styles, machine: GroupView["machines"][number]): { text: string; style: object } {
  if (machine.version === null) return { text: "Sync trop ancien pour rendre compte (0.1.3 ou avant)", style: s.muted };
  if (machine.errors > 0) return { text: `${machine.errors} en échec`, style: s.danger };
  if (machine.mode === "send") return { text: "envoie seulement (n'applique rien)", style: s.muted };
  if (machine.pending > 0) return { text: `${machine.pending} en cours`, style: s.warning };
  if (machine.upToDate === false) return { text: "synchronisation en cours", style: s.warning };
  return { text: `à jour · ${machine.applied} éléments appliqués`, style: s.success };
}

/** Une ligne par machine, puis le détail par élément (plugins d'abord). */
export function MachineStatusPanel({ s, group }: { s: Styles; group: GroupView }) {
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
          Plugins installés partout : {plugins.filter((item) => item.ok.length + item.notApplied.length === total).length}/{plugins.length}
        </Text>
      ) : null}
      {shown.map((item) => (
        <ItemLine key={item.key} s={s} item={item} total={total} />
      ))}
      <Pressable accessibilityRole="button" onPress={() => setDetail(!detail)}>
        <Text style={[s.muted, { textDecorationLine: "underline" }]}>{detail ? "Masquer le détail par élément" : "Voir le détail par élément"}</Text>
      </Pressable>
    </View>
  );
}

function ItemLine({ s, item, total }: { s: Styles; item: ItemStatus; total: number }) {
  const applying = total - item.notApplied.length;
  const done = item.ok.length === applying;
  return (
    <View style={{ gap: 1 }}>
      <Text style={s.text}>
        <Text style={item.errors.length ? s.danger : done ? s.success : s.warning}>{item.errors.length ? "✗ " : done ? "✓ " : "… "}</Text>
        {itemLabel(item)} <Text style={s.muted}>· {item.ok.length}/{applying}</Text>
      </Text>
      {item.errors.map((error) => (
        <Text key={error.machine} style={[s.danger, { paddingLeft: 16 }]}>
          {error.machine} : {error.message}
        </Text>
      ))}
      {item.pending.length ? <Text style={[s.warning, { paddingLeft: 16 }]}>en cours : {item.pending.join(", ")}</Text> : null}
      {item.unknown.length ? <Text style={[s.muted, { paddingLeft: 16 }]}>état inconnu : {item.unknown.join(", ")}</Text> : null}
    </View>
  );
}
