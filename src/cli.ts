#!/usr/bin/env node
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { chromium } from "playwright-core";
import { parseArgs } from "./options.js";
import { join, isJoined } from "./jitsi.js";
import { WhisperWorker } from "./transcript.js";
import { checkedSpawn, createPulseSink, findExecutable, stopProcess } from "./processes.js";
import { SpeakerTracker } from "./speakers.js";
import { TranscriptPipeline } from "./pipeline.js";
import { Logger } from "./logging.js";

const HELP = `Usage: jitscribe join <room-or-url> [options]

  --host URL                 Host for a bare room id (default: https://meet.jit.si)
  --name NAME                Visible participant name
  --password PASSWORD        Room password
  --output FILE.jsonl        Transcript output
  --audio FILE.wav           Audio output base name
  --whisper PATH             Override the bundled whisper.cpp server
  --model PATH               Override the bundled multilingual small model
  --vad-model PATH           Override the bundled Silero VAD model
  --language CODE            auto, en, pt, ...
  --chunk-seconds N          Streaming chunk size (default: 15)
  --overlap-seconds N        Audio overlap between chunks (default: 2)
  --max-retries N            Rejoin attempts (default: 10)
  --admission-timeout N      Seconds to wait in lobby (default: 300)
  --browser PATH             Chromium/Chrome executable
  --keep-audio               Retain temporary WAV chunks
  --verbose                  Show browser/audio/Whisper diagnostics
  --log-format text|json     Lifecycle log format (default: text)
  --headed                   Show the browser window`;

async function main(): Promise<void> {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (error) {
    if ((error as Error).message === "HELP") { console.log(HELP); return; }
    throw error;
  }
  const log = new Logger(opts.verbose, opts.logFormat);
  await stat(opts.model).catch(() => { throw new Error(`Whisper model not found: ${opts.model}`); });
  await stat(opts.vadModel).catch(() => { throw new Error(`Whisper VAD model not found: ${opts.vadModel}`); });
  const browserPath = findExecutable(opts.browser, ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]);
  const whisper = findExecutable(opts.whisper, ["whisper-server"]);
  const ffmpeg = findExecutable(undefined, ["ffmpeg"]);
  await mkdir(dirname(opts.output), { recursive: true });
  const chunkDir = `${dirname(opts.audio)}/.${basename(opts.audio)}.chunks-${process.pid}`;
  await mkdir(chunkDir, { recursive: true });

  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  let ownedPulse: ReturnType<typeof createPulseSink> | undefined;
  let recorder: ReturnType<typeof checkedSpawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let speakers: SpeakerTracker | undefined;
  let worker: WhisperWorker | undefined;
  let transcribeReady: ((includeLast?: boolean) => Promise<void>) | undefined;

  try {
    ownedPulse = process.env.JITSI_PULSE_SINK ? undefined : createPulseSink(`jitscribe_${process.pid}`);
    const pulseSource = process.env.JITSI_PULSE_SINK ?? ownedPulse!.monitor;
    const pattern = `${chunkDir}/chunk-%06d.wav`;
    recorder = checkedSpawn(ffmpeg, ["-nostdin", "-loglevel", opts.verbose ? "info" : "error", "-f", "pulse", "-i", pulseSource, "-ac", "1", "-ar", "16000", "-f", "segment", "-segment_time", String(opts.chunkSeconds), "-reset_timestamps", "1", pattern], process.env,
      text => log.verbose("ffmpeg", text.trim()));
    const captureStartedAt = Date.now();
    browser = await chromium.launch({ executablePath: browserPath, headless: !opts.headed, env: { ...process.env, PULSE_SINK: ownedPulse?.sink ?? process.env.PULSE_SINK ?? "" }, args: ["--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    const page = await context.newPage();
    speakers = new SpeakerTracker(page, opts.name);
    speakers.start();
    const whisperWorker = new WhisperWorker(whisper, opts.model, opts.vadModel);
    worker = whisperWorker;
    const pipeline = new TranscriptPipeline({
      chunkDir,
      output: opts.output,
      captureStartedAtMs: captureStartedAt,
      chunkSeconds: opts.chunkSeconds,
      overlapSeconds: opts.overlapSeconds,
      language: opts.language,
      ffmpeg,
      keepAudio: opts.keepAudio,
      worker: whisperWorker,
      getSpeakerObservations: () => speakers?.observations ?? [],
      onSegment: segment => console.log(`[${segment.start}] ${segment.speaker ?? "Unknown"}: ${segment.text}`),
    });
    transcribeReady = async (includeLast = false) => { await pipeline.process(includeLast); };
    await worker.start();
    for (let attempt = 0; !stopping; attempt++) {
      try {
        log.info("joining", `Joining ${opts.meetingUrl}${attempt ? ` (retry ${attempt}/${opts.maxRetries})` : ""}...`);
        await join(page, opts.meetingUrl, opts.name, opts.password, opts.admissionTimeoutSeconds * 1000);
        log.info("joined", "Joined. Transcribing; press Ctrl-C to leave.");
        while (!stopping && await isJoined(page)) {
          await new Promise(r => setTimeout(r, 1000));
          await transcribeReady();
        }
        if (stopping) break;
        throw new Error("disconnected from meeting");
      } catch (error) {
        if (attempt >= opts.maxRetries || /rejected|requires --password/.test((error as Error).message)) throw error;
        const delay = Math.min(60, 5 * 2 ** attempt);
        log.error("retry", `${(error as Error).message}; retrying in ${delay}s`, { delaySeconds: delay, attempt });
        await new Promise(r => setTimeout(r, delay * 1000));
      }
    }
  } finally {
    speakers?.stop();
    await stopProcess(recorder, "SIGINT").catch(error => log.error("recorder_cleanup_failed", error.message));
    await transcribeReady?.(true).catch(error => log.error("final_transcription_failed", `Final transcription failed: ${error.message}`));
    await worker?.stop().catch(error => log.error("worker_cleanup_failed", error.message));
    await browser?.close().catch(error => log.error("browser_cleanup_failed", error.message));
    try { ownedPulse?.close(); } catch (error) { log.error("audio_cleanup_failed", (error as Error).message); }
    if (!opts.keepAudio) await rm(chunkDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(`jitscribe: ${error.message}`); process.exitCode = 1; });
