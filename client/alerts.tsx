import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { statusRpc, type StatusView } from "../shared/rpc";
import { itemLabel } from "./labels";

/** Ce qui demande l'attention, tous groupes confondus, avec une phrase pour la notification. */
export interface Alerts {
  count: number;
  /** Une clé par problème, pour ne notifier que les nouveaux. */
  ids: string[];
  messages: string[];
}

export function collectAlerts(status: StatusView): Alerts {
  const ids: string[] = [];
  const messages: string[] = [];
  const add = (id: string, text: string) => {
    ids.push(id);
    messages.push(text);
  };
  for (const group of status.groups) {
    if (group.revokedBy) add(`${group.id}|revoked`, `${group.name} : cette machine a été retirée du groupe`);
    if (!group.enabled) continue;
    for (const item of group.itemStatus) {
      for (const error of item.errors) add(`${group.id}|${item.key}|${error.machine}|${error.message}`, `${group.name} : ${itemLabel(item)} en échec sur ${error.machine}`);
    }
    for (const conflict of group.conflicts) add(`${group.id}|conflict|${conflict.key}|${conflict.loserHash}`, `${group.name} : conflit sur ${conflict.key}`);
    if (group.approval && group.awaiting.length > 0) {
      add(`${group.id}|awaiting|${group.awaiting.map((change) => change.key).join(",")}`, `${group.name} : ${group.awaiting.length} changement(s) attendent votre accord`);
    }
    if (group.updates.lastCheckError) add(`${group.id}|updates|${group.updates.lastCheckError}`, `${group.name} : ${group.updates.lastCheckError}`);
  }
  return { count: ids.length, ids, messages };
}

/** Relit l'état toutes les 20 s ; notifie chaque nouveau problème une fois. */
export function useAlerts(): Alerts | null {
  const status = useRpc(statusRpc);
  const toast = useToast();
  const [alerts, setAlerts] = useState<Alerts | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const latest = useRef(status);
  latest.current = status;

  useEffect(() => {
    let stopped = false;
    const poll = () => {
      void latest
        .current({})
        .then((view) => {
          if (stopped) return;
          const next = collectAlerts(view);
          // Premier relevé : on ne notifie pas ce qui existait déjà, le badge suffit.
          if (seen.current !== null) {
            const fresh = next.ids.map((id, index) => [id, next.messages[index]!] as const).filter(([id]) => !seen.current!.has(id));
            if (fresh.length === 1) toast.show(`Sync — ${fresh[0]![1]}`, { variant: "error" });
            else if (fresh.length > 1) toast.show(`Sync — ${fresh.length} nouveaux problèmes (${fresh[0]![1]}…)`, { variant: "error" });
          }
          seen.current = new Set(next.ids);
          setAlerts(next);
        })
        .catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, 20_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // `toast` et `status` peuvent changer d'identité : on garde la même boucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return alerts;
}

/** Pastille rouge avec le nombre de problèmes, à droite de la ligne « Sync ». */
export function AlertBadge({ count, color, textColor }: { count: number; color: string; textColor: string }) {
  if (count === 0) return null;
  return (
    <View
      accessibilityLabel={`${count} problème(s) de synchronisation`}
      style={{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: color, alignItems: "center", justifyContent: "center" }}
    >
      <Text style={{ color: textColor, fontSize: 11, fontWeight: "600" }}>{count > 99 ? "99+" : count}</Text>
    </View>
  );
}
