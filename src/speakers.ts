/* Adapted from Vexa's Apache-2.0 Jitsi dominant-speaker capture. See NOTICE. */
import type { Page } from "playwright-core";

export interface SpeakerObservation {
  atMs: number;
  id: string;
  name: string;
  source: "redux" | "dom";
}

export interface SpeakerAttribution {
  speaker: string | null;
  speakerId: string | null;
  confidence: number;
  samples: number;
  status: SpeakerTurn["status"];
}

export interface TimedWord { fromMs: number; toMs: number; text: string; probability?: number; }
export interface SpeakerTurn {
  fromMs: number;
  toMs: number;
  text: string;
  speaker: string | null;
  speakerId: string | null;
  confidence: number;
  status: "attributed" | "unknown" | "ambiguous";
}

const round = (value: number): number => Number(value.toFixed(3));

export async function readDominantSpeaker(page: Page, selfName: string): Promise<Omit<SpeakerObservation, "atMs"> | null> {
  const dominant = await page.evaluate(() => {
    try {
      const state = (globalThis as any).APP?.store?.getState?.();
      const participants = state?.["features/base/participants"];
      const id = participants?.dominantSpeaker;
      if (id) {
        const participant = participants.local?.id === id
          ? participants.local
          : participants.remote?.get?.(id);
        const name = String(participant?.name ?? "").trim();
        if (name) return { id: String(id), name, source: "redux" as const };
      }
    } catch { /* use DOM fallback */ }

    for (const tileSelector of [".dominant-speaker", '[class*="dominant-speaker"]']) {
      const tile = document.querySelector(tileSelector);
      if (!tile) continue;
      for (const nameSelector of [".displayname", '[class*="displayname" i]', '[data-testid="videoContainerName"]', '[class*="display-name"]']) {
        const name = tile.querySelector(nameSelector)?.textContent?.trim();
        if (name) return { id: `dom:${name}`, name, source: "dom" as const };
      }
    }
    return null;
  }).catch(() => null);
  if (!dominant || dominant.name.toLowerCase() === selfName.trim().toLowerCase()) return null;
  return dominant;
}

export function attributeSpeaker(observations: readonly SpeakerObservation[], fromMs: number, toMs: number): SpeakerAttribution {
  const relevant = observations.filter(sample => sample.atMs >= fromMs && sample.atMs <= toMs);
  if (!relevant.length) return { speaker: null, speakerId: null, confidence: 0, samples: 0, status: "unknown" };
  const counts = new Map<string, { name: string; id: string; count: number }>();
  for (const sample of relevant) {
    const current = counts.get(sample.id) ?? { name: sample.name, id: sample.id, count: 0 };
    current.count++;
    counts.set(sample.id, current);
  }
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const share = winner.count / relevant.length;
  const ambiguous = Boolean(runnerUp && (winner.count === runnerUp.count || (winner.count - runnerUp.count) / relevant.length < 0.25));
  // A single observation is useful, but should not look as certain as a stable run
  // of samples. Competing evidence also halves the confidence of the winner.
  const confidence = share * Math.min(1, relevant.length / 2) * (ambiguous ? 0.5 : 1);
  return {
    speaker: winner.name,
    speakerId: winner.id,
    confidence: round(confidence),
    samples: relevant.length,
    status: ambiguous ? "ambiguous" : "attributed",
  };
}

interface SpeakerMatch {
  sample: SpeakerObservation;
  confidence: number;
  ambiguous: boolean;
}

function speakerAt(observations: readonly SpeakerObservation[], atMs: number, maxAgeMs: number): SpeakerMatch | null {
  const ranked = observations
    .map(sample => ({ sample, distance: Math.abs(sample.atMs - atMs) }))
    .sort((a, b) => a.distance - b.distance);
  const best = ranked[0];
  if (!best || best.distance > maxAgeMs) return null;
  const competitor = ranked.find(candidate => candidate.sample.id !== best.sample.id);
  const ambiguityWindow = Math.min(150, maxAgeMs * 0.25);
  const ambiguous = Boolean(competitor && competitor.distance - best.distance <= ambiguityWindow);
  return {
    sample: best.sample,
    confidence: round(Math.max(0, 1 - best.distance / maxAgeMs) * (ambiguous ? 0.5 : 1)),
    ambiguous,
  };
}

/** Match Whisper words to the nearest fresh Jitsi dominant-speaker observation and group turns. */
export function buildSpeakerTurns(words: TimedWord[], observations: readonly SpeakerObservation[], gapMs = 900, timeOffsetMs = 0): SpeakerTurn[] {
  const attributed = words.map(word => {
    const match = speakerAt(observations, timeOffsetMs + (word.fromMs + word.toMs) / 2, gapMs);
    return { word, match };
  });
  const turns: SpeakerTurn[] = [];
  const wordCounts: number[] = [];
  for (const { word, match } of attributed) {
    const speaker = match?.sample.name || null;
    const id = match?.sample.id || null;
    const confidence = match?.confidence ?? 0;
    const status = !speaker ? "unknown" : match?.ambiguous ? "ambiguous" : "attributed";
    const previous = turns.at(-1);
    const canJoin = previous && previous.speaker === speaker && previous.speakerId === id && word.fromMs - previous.toMs <= gapMs;
    if (canJoin) {
      previous.toMs = word.toMs;
      previous.text = `${previous.text} ${word.text}`.trim();
      const index = turns.length - 1;
      previous.confidence = round((previous.confidence * wordCounts[index] + confidence) / (wordCounts[index] + 1));
      wordCounts[index]++;
      if (status === "ambiguous") previous.status = "ambiguous";
    } else {
      turns.push({ fromMs: word.fromMs, toMs: word.toMs, text: word.text.trim(), speaker, speakerId: id,
        confidence, status });
      wordCounts.push(1);
    }
  }
  return turns;
}

export class SpeakerTracker {
  readonly observations: SpeakerObservation[] = [];
  private timer?: NodeJS.Timeout;
  private sampling = false;

  constructor(private page: Page, private selfName: string) {}

  start(intervalMs = 400): void {
    if (this.timer) return;
    const sample = async () => {
      if (this.sampling) return;
      this.sampling = true;
      try {
        const dominant = await readDominantSpeaker(this.page, this.selfName);
        if (dominant) this.observations.push({ ...dominant, atMs: Date.now() });
      } finally { this.sampling = false; }
    };
    void sample();
    this.timer = setInterval(() => void sample(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
