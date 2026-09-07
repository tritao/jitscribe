import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCAL_WHISPER = resolve(PROJECT_ROOT, ".deps/whisper.cpp/build/bin/whisper-server");
const LOCAL_MODEL = resolve(PROJECT_ROOT, ".deps/whisper.cpp/models/ggml-small.bin");
const LOCAL_VAD_MODEL = resolve(PROJECT_ROOT, ".deps/whisper.cpp/models/ggml-silero-v6.2.0.bin");

export interface Options {
  meetingUrl: string;
  name: string;
  password?: string;
  output: string;
  audio: string;
  whisper: string;
  transcriber: "server" | "native";
  model: string;
  vadModel: string;
  language: string;
  chunkSeconds: number;
  overlapSeconds: number;
  maxRetries: number;
  admissionTimeoutSeconds: number;
  browser?: string;
  headed: boolean;
  keepAudio: boolean;
  verbose: boolean;
  logFormat: "text" | "json";
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
    if (["--headed", "--keep-audio", "--verbose", "--help"].includes(arg)) { flags.add(arg); continue; }
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
  }
  if (flags.has("--help")) throw new Error("HELP");
  const meeting = positional[0];
  if (!meeting) throw new Error("meeting id or URL is required");
  const room = basename(new URL(normalizeMeeting(meeting, values.get("--host"))).pathname) || "meeting";
  const output = resolve(values.get("--output") ?? `${room}.jsonl`);
  const chunkSeconds = positiveInt(values.get("--chunk-seconds") ?? "15", "chunk-seconds");
  const overlapSeconds = nonnegativeInt(values.get("--overlap-seconds") ?? "2", "overlap-seconds");
  if (overlapSeconds >= chunkSeconds) throw new Error("--overlap-seconds must be smaller than --chunk-seconds");
  const logFormat = values.get("--log-format") ?? "text";
  if (logFormat !== "text" && logFormat !== "json") throw new Error("--log-format must be text or json");
  const transcriber = values.get("--transcriber") ?? "server";
  if (transcriber !== "server" && transcriber !== "native") throw new Error("--transcriber must be server or native");
  return {
    meetingUrl: normalizeMeeting(meeting, values.get("--host")),
    name: values.get("--name") ?? "Transcription Bot",
    password: values.get("--password"),
    output,
    audio: resolve(values.get("--audio") ?? output.replace(/\.jsonl$/i, "") + ".wav"),
    whisper: values.get("--whisper") ?? LOCAL_WHISPER,
    transcriber,
    model: values.get("--model") ?? LOCAL_MODEL,
    vadModel: values.get("--vad-model") ?? LOCAL_VAD_MODEL,
    language: values.get("--language") ?? "auto",
    chunkSeconds,
    overlapSeconds,
    maxRetries: nonnegativeInt(values.get("--max-retries") ?? "10", "max-retries"),
    admissionTimeoutSeconds: positiveInt(values.get("--admission-timeout") ?? "300", "admission-timeout"),
    browser: values.get("--browser"),
    headed: flags.has("--headed"),
    keepAudio: flags.has("--keep-audio"),
    verbose: flags.has("--verbose"),
    logFormat,
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
