import { createRequire } from "node:module";

export interface AudioDevice {
  id: string;
  name: string;
  inputChannels: number;
  outputChannels: number;
}

export interface AudioCaptureOptions {
  host?: string;
  deviceId?: string;
  sampleRate?: number;
  channels?: number;
  chunkMs?: number;
  queueCapacity?: number;
}

export interface AudioEvent {
  kind: "ready" | "pcm" | "discontinuity" | "error" | "stopped";
  sequence?: number;
  startedAtMs?: string;
  sampleRate?: number;
  channels?: number;
  samples?: Buffer;
  droppedSamples?: string;
  timestampMs?: string;
  message?: string;
  recoverable?: boolean;
}

export interface NativeAudioCapture {
  poll(): AudioEvent | null;
  stop(): void;
}

export interface NativeAudioModule {
  listAudioDevices(): AudioDevice[];
  AudioCapture: {
    start(options?: AudioCaptureOptions): NativeAudioCapture;
  };
  WhisperTranscriber: new (modelPath: string, language?: string) => NativeWhisperTranscriber;
}

export interface NativeWhisperWord {
  fromMs: number;
  toMs: number;
  text: string;
  probability: number;
}

export interface NativeWhisperSegment {
  startMs: number;
  endMs: number;
  text: string;
  words: NativeWhisperWord[];
}

export interface NativeWhisperResult {
  text: string;
  segments: NativeWhisperSegment[];
}

export interface NativeWhisperTranscriber {
  transcribe(pcmI16Le: Buffer): NativeWhisperResult;
}

const require = createRequire(import.meta.url);

export function loadNativeAudio(): NativeAudioModule {
  try {
    return require("../native/jitscribe-audio-napi/index.cjs") as NativeAudioModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`native audio addon is not built or could not load: ${message}`);
  }
}

export function nativeAudioAvailable(): boolean {
  try {
    loadNativeAudio();
    return true;
  } catch {
    return false;
  }
}
