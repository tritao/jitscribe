import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCAL_WHISPER = resolve(PROJECT_ROOT, ".deps/whisper.cpp/build/bin/whisper-server");
const LOCAL_MODEL = resolve(PROJECT_ROOT, ".deps/whisper.cpp/models/ggml-small.bin");

export interface Options {
  meetingUrl: string;
  name: string;
  password?: string;
  output: string;
  audio: string;
  whisper: string;
  model: string;
  language: string;
  chunkSeconds: number;
  maxRetries: number;
  admissionTimeoutSeconds: number;
  browser?: string;
  headed: boolean;
  keepAudio: boolean;
}

export function normalizeMeeting(value: string, host = "https://meet.jit.si"): string {
  const raw = value.trim();
  if (!raw) throw new Error("meeting id or URL is required");
  const candidate = /^https?:\/\//i.test(raw)
    ? raw
    : `${host.replace(/\/+$/, "")}/${raw.replace(/^\/+/, "")}`;
  const url = new URL(candidate);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("meeting URL must use HTTP(S)");
  if (!url.pathname.replace(/\//g, "")) throw new Error("meeting URL has no room name");
  return url.toString();
}

export function parseArgs(argv: string[]): Options {
  const args = [...argv];
  if (args[0] === "join") args.shift();
  const positional: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  while (args.length) {
    const arg = args.shift()!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (["--headed", "--keep-audio", "--help"].includes(arg)) { flags.add(arg); continue; }
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
  }
  if (flags.has("--help")) throw new Error("HELP");
  const meeting = positional[0];
  if (!meeting) throw new Error("meeting id or URL is required");
  const room = basename(new URL(normalizeMeeting(meeting, values.get("--host"))).pathname) || "meeting";
  const output = resolve(values.get("--output") ?? `${room}.jsonl`);
  return {
    meetingUrl: normalizeMeeting(meeting, values.get("--host")),
    name: values.get("--name") ?? "Transcription Bot",
    password: values.get("--password"),
    output,
    audio: resolve(values.get("--audio") ?? output.replace(/\.jsonl$/i, "") + ".wav"),
    whisper: values.get("--whisper") ?? LOCAL_WHISPER,
    model: values.get("--model") ?? LOCAL_MODEL,
    language: values.get("--language") ?? "auto",
    chunkSeconds: positiveInt(values.get("--chunk-seconds") ?? "15", "chunk-seconds"),
    maxRetries: nonnegativeInt(values.get("--max-retries") ?? "10", "max-retries"),
    admissionTimeoutSeconds: positiveInt(values.get("--admission-timeout") ?? "300", "admission-timeout"),
    browser: values.get("--browser"),
    headed: flags.has("--headed"),
    keepAudio: flags.has("--keep-audio"),
  };
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
  return n;
}
function nonnegativeInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}
