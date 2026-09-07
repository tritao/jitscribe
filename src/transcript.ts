import { appendFile, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import type { TimedWord } from "./speakers.js";

export interface WhisperSegment { fromMs: number; toMs: number; text: string; words: TimedWord[]; }
export interface Segment {
  sessionId: string;
  segmentId: string;
  revision: number;
  timestamp: string;
  start: string;
  end: string;
  text: string;
  chunk: number;
  speaker: string | null;
  speakerId: string | null;
  speakerConfidence: number;
  speakerStatus?: "attributed" | "unknown" | "ambiguous";
}

export function isMeaningfulTranscript(text: string): boolean {
  return text
    .split("\n")
    .some(line => line.trim() !== "" && !/^\s*\[\s*(?:blank_audio|silence)\s*\]\s*$/i.test(line));
}

interface WhisperServerResponse {
  segments?: Array<{ start?: number; end?: number; text?: string; words?: Array<{ start?: number; end?: number; word?: string; probability?: number }> }>;
}

export function parseWhisperResponse(document: WhisperServerResponse): WhisperSegment[] {
  return (document.segments ?? []).flatMap(segment => {
    const text = String(segment.text ?? "").trim();
    if (!isMeaningfulTranscript(text)) return [];
    const words = (segment.words ?? []).map(word => ({ fromMs: Math.round((word.start ?? segment.start ?? 0) * 1000), toMs: Math.round((word.end ?? segment.end ?? 0) * 1000), text: String(word.word ?? "").trim(), probability: word.probability })).filter(word => word.text);
    return [{ fromMs: Math.round((segment.start ?? 0) * 1000), toMs: Math.round((segment.end ?? 0) * 1000), text, words }];
  });
}

export function shouldEmitSegment(endMs: number, emittedThroughMs: number, watermarkMs: number): boolean {
  return endMs > emittedThroughMs && endMs <= watermarkMs;
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

export class WhisperWorker {
  private child?: ChildProcess;
  private baseUrl?: string;
  private stderr = "";
  private processError?: Error;

  constructor(private command: string, private model: string, private vadModel?: string) {}

  async start(timeoutMs = 30_000): Promise<void> {
    if (this.child) return;
    const port = await availablePort();
    this.baseUrl = `http://127.0.0.1:${port}`;
    const args = ["-m", this.model, "--host", "127.0.0.1", "--port", String(port), "-nlp"];
    if (this.vadModel) args.push("--vad", "-vm", this.vadModel);
    const child = spawn(this.command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    child.once("error", error => { this.processError = error; });
    child.stderr?.on("data", data => { this.stderr = (this.stderr + String(data)).slice(-4000); });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.processError) throw new Error(`cannot start whisper worker: ${this.processError.message}`);
      if (child.exitCode !== null) throw new Error(`whisper worker exited during startup: ${this.stderr.trim()}`);
      try {
        const response = await fetch(`${this.baseUrl}/health`);
        if (response.ok) return;
      } catch { /* still loading */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await this.stop();
    throw new Error(`whisper worker did not become healthy within ${timeoutMs} ms`);
  }

  async transcribe(wav: string, language: string): Promise<WhisperSegment[]> {
    if (!this.child || !this.baseUrl || this.child.exitCode !== null) {
      throw new Error(`whisper worker is not running${this.stderr ? `: ${this.stderr.trim()}` : ""}`);
    }
    const form = new FormData();
    const bytes = await readFile(wav);
    form.append("file", new Blob([bytes]), basename(wav));
    form.append("response_format", "verbose_json");
    form.append("language", language);
    form.append("temperature", "0.0");
    const response = await fetch(`${this.baseUrl}/inference`, { method: "POST", body: form });
    const body = await response.text();
    if (!response.ok) throw new Error(`whisper inference failed (${response.status}): ${body.slice(0, 500)}`);
    return parseWhisperResponse(JSON.parse(body) as WhisperServerResponse);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.baseUrl = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

export async function appendSegment(path: string, segment: Segment): Promise<void> {
  await appendFile(path, `${JSON.stringify(segment)}\n`, "utf8");
}
