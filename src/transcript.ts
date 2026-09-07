import { appendFile, readFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";

export interface WhisperSegment { fromMs: number; toMs: number; text: string; }
export interface Segment {
  timestamp: string;
  start: string;
  end: string;
  text: string;
  chunk: number;
  speaker: string | null;
  speakerId: string | null;
  speakerConfidence: number;
}

export function isMeaningfulTranscript(text: string): boolean {
  return text
    .split("\n")
    .some(line => line.trim() !== "" && !/^\s*\[\s*(?:blank_audio|silence)\s*\]\s*$/i.test(line));
}

export async function transcribeChunk(command: string, model: string, language: string, wav: string): Promise<WhisperSegment[]> {
  const args = ["-m", model, "-f", wav, "-oj", "-of", `${wav}.transcript`];
  if (language !== "auto") args.push("-l", language);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`whisper exited with code ${code}`)));
  });
  const path = `${wav}.transcript.json`;
  const document = JSON.parse(await readFile(path, "utf8")) as {
    transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }>;
  };
  await unlink(path).catch(() => {});
  return (document.transcription ?? []).flatMap(segment => {
    const text = (segment.text ?? "").trim();
    if (!isMeaningfulTranscript(text)) return [];
    return [{ fromMs: segment.offsets?.from ?? 0, toMs: segment.offsets?.to ?? 0, text }];
  });
}

export async function appendSegment(path: string, segment: Segment): Promise<void> {
  await appendFile(path, `${JSON.stringify(segment)}\n`, "utf8");
}
