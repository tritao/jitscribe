import { rm } from "node:fs/promises";
import { appendSegment, shouldEmitSegment, type Segment, type WhisperSegment } from "./transcript.js";
import { buildOverlapWindow, waitForStableFiles } from "./processes.js";
import { attributeSpeaker, buildSpeakerTurns, type SpeakerObservation, type SpeakerSignal, type SpeakerTurn } from "./speakers.js";

export interface WhisperTranscriber {
  transcribe(wav: string, language: string): Promise<WhisperSegment[]>;
}

export interface TranscriptPipelineOptions {
  chunkDir: string;
  output: string;
  captureStartedAtMs: number;
  chunkSeconds: number;
  overlapSeconds: number;
  language: string;
  ffmpeg: string;
  keepAudio: boolean;
  worker: WhisperTranscriber;
  getSpeakerObservations: () => readonly SpeakerObservation[];
  getSpeakerEvents?: () => readonly SpeakerSignal[];
  onSegment?: (segment: Segment) => void;
}

/**
 * Turns stable recorder chunks into timestamped JSONL transcript records.
 * The class keeps the overlap watermark and seen-file state between polling
 * passes, which makes it usable by both the live CLI and deterministic tests.
 */
export class TranscriptPipeline {
  private readonly seen = new Set<string>();
  private emittedThroughMs: number;

  constructor(private readonly options: TranscriptPipelineOptions) {
    this.emittedThroughMs = options.captureStartedAtMs;
  }

  async process(includeLast = false): Promise<Segment[]> {
    const emitted: Segment[] = [];
    const { options } = this;
    for (const wav of await waitForStableFiles(options.chunkDir, "chunk-", this.seen, includeLast)) {
      this.seen.add(wav);
      const chunkNumber = Number(/chunk-(\d+)\.wav$/.exec(wav)?.[1] ?? 0);
      const chunkStart = options.captureStartedAtMs + chunkNumber * options.chunkSeconds * 1000;
      const previous = chunkNumber > 0
        ? `${options.chunkDir}/chunk-${String(chunkNumber - 1).padStart(6, "0")}.wav`
        : undefined;
      const windowPath = `${options.chunkDir}/window-${String(chunkNumber).padStart(6, "0")}.wav`;
      const input = await buildOverlapWindow(options.ffmpeg, previous, wav, windowPath, options.overlapSeconds);
      const windowStart = chunkStart - (previous ? options.overlapSeconds * 1000 : 0);
      const watermark = includeLast
        ? Number.POSITIVE_INFINITY
        : chunkStart + (options.chunkSeconds - options.overlapSeconds) * 1000;
      const whisperSegments = await options.worker.transcribe(input, options.language);
      if (input === windowPath && !options.keepAudio) await rm(windowPath, { force: true });

      for (const item of whisperSegments) {
        const speakerEvents = options.getSpeakerEvents?.() ?? [];
        const turns: SpeakerTurn[] = item.words.length
          ? buildSpeakerTurns(item.words, options.getSpeakerObservations(), 900, windowStart, speakerEvents)
          : [{
            fromMs: item.fromMs,
            toMs: item.toMs,
            text: item.text,
            ...attributeSpeaker(options.getSpeakerObservations(), windowStart + item.fromMs, windowStart + item.toMs, speakerEvents),
          }];
        for (const turn of turns) {
          const startMs = windowStart + turn.fromMs;
          const endMs = windowStart + turn.toMs;
          if (!shouldEmitSegment(endMs, this.emittedThroughMs, watermark)) continue;
          const segment: Segment = {
            timestamp: new Date().toISOString(),
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
            text: turn.text,
            chunk: chunkNumber,
            speaker: turn.speaker,
            speakerId: turn.speakerId,
            speakerConfidence: turn.confidence,
            speakerStatus: turn.status,
          };
          await appendSegment(options.output, segment);
          emitted.push(segment);
          options.onSegment?.(segment);
          this.emittedThroughMs = Math.max(this.emittedThroughMs, endMs);
        }
      }
    }
    return emitted;
  }
}
