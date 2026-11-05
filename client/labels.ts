import type { ItemStatus } from "../shared/rpc";

/** Nom lisible d'un élément : « plugin/kanban » → « kanban », « file/skills » → « fichiers skills ». */
export function itemLabel(item: Pick<ItemStatus, "key" | "count">): string {
  const [kind = "", ...rest] = item.key.split("/");
  const name = rest.join("/");
  if (kind === "plugin") return name;
  if (kind === "settings") return `réglages ${name}`;
  if (kind === "config") return `config ${name}`;
  if (kind === "file") return `fichiers ${name} (${item.count})`;
  if (kind === "json") return `clé JSON ${name}`;
  if (kind === "schedule") return `planification ${name}`;
  if (kind === "self") return "Sync lui-même";
  return item.key;
}

