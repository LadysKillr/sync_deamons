import { spawn } from "node:child_process";

/**
 * Le CLI `paseo` de la machine, pour ce que l'API des plugins n'offre pas : installer, mettre à jour, activer,
 * retirer et recharger des plugins, éditer `config.json` et le recharger. Il parle au même daemon (`PASEO_HOME`).
 */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PaseoCli {
  run(args: string[], options?: { timeoutMs?: number }): Promise<CliResult>;
}

export function createPaseoCli(options: { bin?: string; home: string }): PaseoCli {
  const bin = options.bin ?? process.env.PASEO_SYNC_CLI ?? "paseo";
  return {
    run(args, { timeoutMs = 10 * 60_000 } = {}) {
      return new Promise((resolve) => {
        const child = spawn(bin, [...args, "--home", options.home], {
          env: { ...process.env, PASEO_HOME: options.home, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 1, stdout, stderr });
        });
      });
    },
  };
}

/** Le JSON de la sortie, en sautant les lignes d'avertissement qui le précèdent. */
export function parseJsonOutput(stdout: string): unknown {
  const start = stdout.search(/^[[{]/m);
  if (start < 0) throw new Error("sortie JSON absente");
  return JSON.parse(stdout.slice(start));
}

export function cliError(result: CliResult): string {
  try {
    const parsed = parseJsonOutput(result.stdout) as { error?: { userMessage?: string; message?: string } } | Array<{ error?: string }>;
    if (Array.isArray(parsed)) {
      const failed = parsed.find((item) => item.error);
      if (failed?.error) return failed.error;
    } else if (parsed?.error) {
      return parsed.error.userMessage ?? parsed.error.message ?? "erreur";
    }
  } catch {
    // Pas de JSON : on prend le texte brut.
  }
  const text = `${result.stderr}\n${result.stdout}`.trim().split("\n").filter(Boolean).slice(-3).join(" ");
  return text || `code ${result.code}`;
}

/**
 * Le daemon n'est pas (encore) joignable : il démarre, charge ses plugins, ou redémarre. Ce n'est pas un échec de
 * synchronisation : le passage est simplement refait un peu plus tard, sans erreur affichée.
 */
export class DaemonNotReady extends Error {
  override name = "DaemonNotReady";
}

const NOT_READY = /paseo daemon start|cannot connect to daemon|ECONNREFUSED|daemon (?:is )?not (?:running|ready)|daemon is starting/i;

export function isDaemonNotReady(error: unknown): boolean {
  if (error instanceof DaemonNotReady) return true;
  const text = error instanceof Error ? error.message : String(error ?? "");
  return NOT_READY.test(text);
}

/** Lance la commande et rend son JSON ; lève avec un message lisible si elle échoue. */
export async function runJson(cli: PaseoCli, args: string[]): Promise<unknown> {
  const result = await cli.run([...args, "--json"]);
  if (result.code !== 0) {
    const message = `paseo ${args.slice(0, 3).join(" ")} : ${cliError(result)}`;
    if (NOT_READY.test(`${message}\n${result.stderr}`)) throw new DaemonNotReady(message);
    throw new Error(message);
  }
  const parsed = parseJsonOutput(result.stdout);
  if (Array.isArray(parsed)) {
    const failed = parsed.find((item: { outcome?: string; error?: string }) => item?.outcome === "error" || item?.error);
    if (failed) throw new Error(`paseo ${args.slice(0, 3).join(" ")} : ${(failed as { error?: string }).error ?? "erreur"}`);
  }
  return parsed;
}
