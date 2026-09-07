#!/usr/bin/env node
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { chromium } from "playwright-core";
import { parseArgs } from "./options.js";
import { join, isJoined } from "./jitsi.js";
import { appendSegment, transcribeChunk } from "./transcript.js";
import { checkedSpawn, createPulseSink, findExecutable, waitForStableFiles } from "./processes.js";

const HELP = `Usage: jitsi-transcriber join <room-or-url> [options]

  --host URL                 Host for a bare room id (default: https://meet.jit.si)
  --name NAME                Visible participant name
  --password PASSWORD        Room password
  --output FILE.jsonl        Transcript output
  --audio FILE.wav           Audio output base name
  --whisper PATH             Override the bundled whisper.cpp CLI
  --model PATH               Override the bundled multilingual small model
  --language CODE            auto, en, pt, ...
  --chunk-seconds N          Streaming chunk size (default: 15)
  --max-retries N            Rejoin attempts (default: 10)
  --admission-timeout N      Seconds to wait in lobby (default: 300)
  --browser PATH             Chromium/Chrome executable
  --keep-audio               Retain temporary WAV chunks
  --headed                   Show the browser window`;

async function main(): Promise<void> {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (error) {
    if ((error as Error).message === "HELP") { console.log(HELP); return; }
    throw error;
  }
  await stat(opts.model).catch(() => { throw new Error(`Whisper model not found: ${opts.model}`); });
  const browserPath = findExecutable(opts.browser, ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]);
  const whisper = findExecutable(opts.whisper, ["whisper-cli", "whisper-cpp", "main"]);
  const ffmpeg = findExecutable(undefined, ["ffmpeg"]);
  await mkdir(dirname(opts.output), { recursive: true });
  const chunkDir = `${dirname(opts.audio)}/.${basename(opts.audio)}.chunks-${process.pid}`;
  await mkdir(chunkDir, { recursive: true });

  const ownedPulse = process.env.JITSI_PULSE_SINK ? undefined : createPulseSink(`jitsi_transcriber_${process.pid}`);
  const pulseSource = process.env.JITSI_PULSE_SINK ?? ownedPulse!.monitor;
  const pattern = `${chunkDir}/chunk-%06d.wav`;
  const recorder = checkedSpawn(ffmpeg, ["-nostdin", "-f", "pulse", "-i", pulseSource, "-ac", "1", "-ar", "16000", "-f", "segment", "-segment_time", String(opts.chunkSeconds), "-reset_timestamps", "1", pattern]);
  const browser = await chromium.launch({ executablePath: browserPath, headless: !opts.headed, env: { ...process.env, PULSE_SINK: ownedPulse?.sink ?? process.env.PULSE_SINK ?? "" }, args: ["--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ permissions: ["microphone", "camera"] });
  const page = await context.newPage();
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  const seen = new Set<string>();
  let chunk = 0;
  const transcribeReady = async (includeLast = false) => {
    for (const wav of await waitForStableFiles(chunkDir, "chunk-", seen, includeLast)) {
      seen.add(wav);
      const text = await transcribeChunk(whisper, opts.model, opts.language, wav);
      if (text) {
        const segment = { timestamp: new Date().toISOString(), text, chunk: chunk++ };
        await appendSegment(opts.output, segment);
        console.log(`[${segment.timestamp}] ${text}`);
      }
    }
  };

  try {
    for (let attempt = 0; !stopping; attempt++) {
      try {
        console.error(`Joining ${opts.meetingUrl}${attempt ? ` (retry ${attempt}/${opts.maxRetries})` : ""}...`);
        await join(page, opts.meetingUrl, opts.name, opts.password, opts.admissionTimeoutSeconds * 1000);
        console.error("Joined. Transcribing; press Ctrl-C to leave.");
        while (!stopping && await isJoined(page)) {
          await new Promise(r => setTimeout(r, 1000));
          await transcribeReady();
        }
        if (stopping) break;
        throw new Error("disconnected from meeting");
      } catch (error) {
        if (attempt >= opts.maxRetries || /rejected|requires --password/.test((error as Error).message)) throw error;
        const delay = Math.min(60, 5 * 2 ** attempt);
        console.error(`${(error as Error).message}; retrying in ${delay}s`);
        await new Promise(r => setTimeout(r, delay * 1000));
      }
    }
  } finally {
    recorder.kill("SIGINT");
    await new Promise(r => setTimeout(r, 500));
    await transcribeReady(true).catch(error => console.error(`final transcription failed: ${error.message}`));
    try { await browser.close(); }
    finally {
      ownedPulse?.close();
      if (!opts.keepAudio) await rm(chunkDir, { recursive: true, force: true });
    }
  }
}

main().catch(error => { console.error(`jitsi-transcriber: ${error.message}`); process.exitCode = 1; });
