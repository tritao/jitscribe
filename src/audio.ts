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
