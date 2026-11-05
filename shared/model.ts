import { z } from "zod";

/**
 * Modèle commun au daemon et à l'appli. Aucun import Node ni React Native ici.
 *
 * Vocabulaire :
 * - nœud : un daemon Paseo où le plugin tourne ;
 * - groupe : un ensemble de nœuds qui partagent un mot de passe et une portée (ce qui est synchronisé) ;
 * - élément : une unité synchronisée (un plugin, un fichier de réglages, un chemin de config, un fichier).
 */

export const SELF_PLUGIN_ID = "sync";

/** Préfixes des clés d'éléments. */
export const KEY_PREFIX = {
  plugin: "plugin/",
  settings: "settings/",
  config: "config/",
  file: "file/",
} as const;

/** Clé réservée : la portée du groupe voyage comme un élément ordinaire. */
export const SCOPE_KEY = "@scope";

export const FileSetSchema = z.object({
  /** Identifiant court, le même sur toutes les machines. */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, "identifiant : minuscules, chiffres, - et _"),
  /** Chemin d'un fichier ou d'un dossier ; `~` = dossier personnel de la machine. */
  path: z.string().min(1),
});
export type FileSet = z.infer<typeof FileSetSchema>;

export const GroupScopeSchema = z.object({
  plugins: z.object({
    enabled: z.boolean(),
    /** all : tous les plugins ; include : seulement `ids` ; exclude : tous sauf `ids`. */
    mode: z.enum(["all", "include", "exclude"]),
    ids: z.array(z.string()),
  }),
  /** Réglages des plugins retenus ci-dessus (fichiers `plugin-settings/<plugin>/*.json`). */
  pluginSettings: z.object({ enabled: z.boolean() }),
  /** Chemins de `config.json` du daemon : agents, fournisseurs, profils, fonctionnalités… */
  config: z.object({ enabled: z.boolean(), paths: z.array(z.string()) }),
  /** Fichiers et dossiers (skills, CLAUDE.md, …). */
  files: z.object({ enabled: z.boolean(), sets: z.array(FileSetSchema) }),
  /** Une suppression sur une machine supprime aussi sur les autres. */
  propagateDeletions: z.boolean(),
});
export type GroupScope = z.infer<typeof GroupScopeSchema>;

export const DEFAULT_CONFIG_PATHS = ["agents", "features"] as const;

export const DEFAULT_SCOPE: GroupScope = {
  plugins: { enabled: true, mode: "all", ids: [] },
  pluginSettings: { enabled: true },
  config: { enabled: true, paths: [...DEFAULT_CONFIG_PATHS] },
  files: { enabled: false, sets: [] },
  propagateDeletions: true,
};

/**
 * Chemins de config jamais synchronisés : adresse d'écoute, mot de passe du daemon, relais, identité, et la liste
 * des plugins (gérée par la catégorie « plugins »).
 */
export const FORBIDDEN_CONFIG_PATHS = ["version", "daemon", "plugins", "pluginsEnabled", "app"] as const;

export function isForbiddenConfigPath(path: string): boolean {
  const clean = path.trim();
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(clean)) return true;
  return FORBIDDEN_CONFIG_PATHS.some((forbidden) => clean === forbidden || clean.startsWith(`${forbidden}.`));
}

/** both : envoie et reçoit ; receive : n'envoie jamais ses changements ; send : n'applique jamais ceux des autres. */
export const GroupModeSchema = z.enum(["both", "receive", "send"]);
export type GroupMode = z.infer<typeof GroupModeSchema>;

export const PluginSelectionSchema = GroupScopeSchema.shape.plugins;

export function pluginInScope(scope: GroupScope, pluginId: string): boolean {
  if (pluginId === SELF_PLUGIN_ID) return false;
  const { mode, ids } = scope.plugins;
  if (mode === "all") return true;
  if (mode === "include") return ids.includes(pluginId);
  return !ids.includes(pluginId);
}

export function categoryOfKey(key: string): "plugins" | "pluginSettings" | "config" | "files" | "scope" | null {
  if (key === SCOPE_KEY) return "scope";
  if (key.startsWith(KEY_PREFIX.plugin)) return "plugins";
  if (key.startsWith(KEY_PREFIX.settings)) return "pluginSettings";
  if (key.startsWith(KEY_PREFIX.config)) return "config";
  if (key.startsWith(KEY_PREFIX.file)) return "files";
  return null;
}

/** La clé appartient-elle à la portée ? (La portée elle-même est toujours synchronisée.) */
export function keyInScope(scope: GroupScope, key: string): boolean {
  switch (categoryOfKey(key)) {
    case "scope":
      return true;
    case "plugins":
      return scope.plugins.enabled && pluginInScope(scope, key.slice(KEY_PREFIX.plugin.length));
    case "pluginSettings": {
      const pluginId = key.slice(KEY_PREFIX.settings.length).split("/")[0] ?? "";
      return scope.pluginSettings.enabled && pluginInScope(scope, pluginId);
    }
    case "config": {
      if (!scope.config.enabled) return false;
      const path = key.slice(KEY_PREFIX.config.length);
      return scope.config.paths.includes(path) && !isForbiddenConfigPath(path);
    }
    case "files": {
      if (!scope.files.enabled) return false;
      const setId = key.slice(KEY_PREFIX.file.length).split("/")[0] ?? "";
      return scope.files.sets.some((set) => set.id === setId);
    }
    default:
      return false;
  }
}
