import { existsSync, mkdirSync, statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { TEMPORARY_NAME } from "./collectors";

/**
 * Détection des changements locaux : tout ce que Sync suit laisse une trace sur disque.
 * - plugins (installation, mise à jour, activation, retrait) : `config.json` et `plugins/sources.json` ;
 * - réglages des plugins : `plugin-settings/**` ;
 * - config du daemon : `config.json` ;
 * - ensembles de fichiers : leurs dossiers (ou le dossier parent d'un fichier seul).
 *
 * On surveille des dossiers, pas des fichiers : une écriture atomique (fichier temporaire puis renommage) remplace le
 * fichier et casserait une surveillance posée dessus. Les événements sont regroupés (`debounceMs`) : une installation
 * écrit plusieurs fichiers d'affilée et ne doit donner qu'un passage. Un événement manqué est rattrapé par le passage
 * de secours.
 */

export interface WatchTarget {
  dir: string;
  recursive: boolean;
  /** Ne réagir qu'à ces noms de fichiers (surveillance non récursive d'un dossier partagé). */
  names?: string[];
}

/** Même règle que le relevé des fichiers : un fichier en cours d'écriture ne déclenche rien. */
const IGNORED = TEMPORARY_NAME;

export class ChangeWatcher {
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private signature = "";

  constructor(
    private readonly onChange: () => void,
    private readonly options: { debounceMs?: number; paused?: () => boolean; log?: (line: string) => void } = {},
  ) {}

  /** Pose (ou repose, si la liste a changé) les surveillances. */
  update(targets: WatchTarget[]): void {
    const usable = targets.filter((target) => existsSync(target.dir) && statSync(target.dir).isDirectory());
    const signature = JSON.stringify(usable);
    if (signature === this.signature) return;
    this.close();
    this.signature = signature;
    for (const target of usable) {
      try {
        const watcher = watch(target.dir, { recursive: target.recursive, persistent: false }, (_event, filename) => {
          const name = filename ? filename.toString() : "";
          if (name && IGNORED.test(name)) return;
          if (target.names && name && !target.names.includes(path.basename(name))) return;
          this.schedule();
        });
        watcher.on("error", () => {
          // Dossier supprimé ou remplacé : la prochaine mise à jour (passage de secours) repose la surveillance.
          this.signature = "";
        });
        this.watchers.push(watcher);
      } catch (error) {
        this.options.log?.(`surveillance impossible de ${target.dir} : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      // Pendant que Sync applique lui-même des changements, ses propres écritures ne comptent pas.
      if (this.options.paused?.()) return;
      this.onChange();
    }, this.options.debounceMs ?? 2000);
  }

  close(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.signature = "";
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Ce qu'il faut surveiller pour un daemon et des ensembles de fichiers donnés. */
export function watchTargets(paseoHome: string, fileRoots: string[]): WatchTarget[] {
  const settings = path.join(paseoHome, "plugin-settings");
  mkdirSync(settings, { recursive: true });
  const targets: WatchTarget[] = [
    { dir: paseoHome, recursive: false, names: ["config.json"] },
    { dir: path.join(paseoHome, "plugins"), recursive: false, names: ["sources.json"] },
    { dir: settings, recursive: true },
  ];
  for (const root of fileRoots) {
    if (existsSync(root) && statSync(root).isFile()) {
      targets.push({ dir: path.dirname(root), recursive: false, names: [path.basename(root)] });
    } else {
      targets.push({ dir: root, recursive: true });
    }
  }
  return targets;
}
