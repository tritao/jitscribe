import { appendFile, readFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";

export interface Segment { timestamp: string; text: string; chunk: number; }

export function isMeaningfulTranscript(text: string): boolean {
  return text
    .split("\n")
    .some(line => line.trim() !== "" && !/^\s*\[\s*(?:blank_audio|silence)\s*\]\s*$/i.test(line));
}

export async function transcribeChunk(command: string, model: string, language: string, wav: string): Promise<string> {
  const args = ["-m", model, "-f", wav, "-otxt", "-of", `${wav}.transcript`];
  if (language !== "auto") args.push("-l", language);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`whisper exited with code ${code}`)));
  });
  const path = `${wav}.transcript.txt`;
  const text = (await readFile(path, "utf8")).trim();
  await unlink(path).catch(() => {});
  const meaningful = text
    .split("\n")
    .filter(line => !/^\s*\[\s*(?:blank_audio|silence)\s*\]\s*$/i.test(line))
    .join("\n")
    .trim();
  return isMeaningfulTranscript(meaningful) ? meaningful : "";
}

export async function appendSegment(path: string, segment: Segment): Promise<void> {
  await appendFile(path, `${JSON.stringify(segment)}\n`, "utf8");
}
