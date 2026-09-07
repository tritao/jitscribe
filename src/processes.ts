import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
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

export function checkedSpawn(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, onStderr?: (text: string) => void): ChildProcess {
  const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.on("data", data => onStderr?.(String(data)));
  return child;
}

export async function buildOverlapWindow(ffmpeg: string, previous: string | undefined, current: string, output: string, overlapSeconds: number): Promise<string> {
  if (!previous || overlapSeconds === 0) return current;
  const args = ["-nostdin", "-loglevel", "error", "-y", "-sseof", `-${overlapSeconds}`, "-i", previous, "-i", current,
    "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[out]", "-map", "[out]", "-ac", "1", "-ar", "16000", output];
  await new Promise<void>((resolve, reject) => {
    let error = "";
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", data => { error = (error + String(data)).slice(-2000); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`cannot build overlap window: ${error.trim()}`)));
  });
  return output;
}

export async function stopProcess(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM", timeoutMs = 3000): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
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
