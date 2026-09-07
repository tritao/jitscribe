import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, readdir, rename, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter } from "node:path";

export function findExecutable(explicit: string | undefined, candidates: string[]): string {
  if (explicit) return explicit;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of candidates) {
      const path = `${dir}/${name}`;
      try { requireAccess(path); return path; } catch { /* continue */ }
    }
  }
  throw new Error(`not found: ${candidates.join(" or ")}`);
}

function requireAccess(path: string): void {
  const fs = process.getBuiltinModule("fs") as typeof import("node:fs");
  fs.accessSync(path, constants.X_OK);
}

export function checkedSpawn(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.on("data", data => process.stderr.write(data));
  return child;
}

export async function waitForStableFiles(dir: string, prefix: string, seen: Set<string>, includeLast = false): Promise<string[]> {
  const names = (await readdir(dir)).filter(n => n.startsWith(prefix) && n.endsWith(".wav")).sort();
  const ready: string[] = [];
  for (const name of includeLast ? names : names.slice(0, -1)) {
    const path = `${dir}/${name}`;
    if (!seen.has(path) && (await stat(path)).size > 44) ready.push(path);
  }
  return ready;
}

export interface PulseSink { sink: string; monitor: string; close(): void; }

export function createPulseSink(name: string): PulseSink {
  const pactl = findExecutable(undefined, ["pactl"]);
  const result = spawnSync(pactl, ["load-module", "module-null-sink", `sink_name=${name}`, "sink_properties=device.description=Jitscribe"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot create PulseAudio sink: ${(result.stderr || result.stdout).trim()}`);
  const moduleId = result.stdout.trim();
  return {
    sink: name,
    monitor: `${name}.monitor`,
    close: () => { spawnSync(pactl, ["unload-module", moduleId], { stdio: "ignore" }); },
  };
}

export async function executableExists(path: string): Promise<void> { await access(path, constants.X_OK); }
export async function finalizeRecording(firstChunk: string, output: string): Promise<void> { await rename(firstChunk, output); }
