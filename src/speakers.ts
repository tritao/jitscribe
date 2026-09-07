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

export function attributeSpeaker(observations: SpeakerObservation[], fromMs: number, toMs: number): SpeakerAttribution {
  const relevant = observations.filter(sample => sample.atMs >= fromMs && sample.atMs <= toMs);
  if (!relevant.length) return { speaker: null, speakerId: null, confidence: 0, samples: 0 };
  const counts = new Map<string, { name: string; id: string; count: number }>();
  for (const sample of relevant) {
    const current = counts.get(sample.id) ?? { name: sample.name, id: sample.id, count: 0 };
    current.count++;
    counts.set(sample.id, current);
  }
  const winner = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  return {
    speaker: winner.name,
    speakerId: winner.id,
    confidence: Number((winner.count / relevant.length).toFixed(3)),
    samples: relevant.length,
  };
}

function speakerAt(observations: SpeakerObservation[], atMs: number): SpeakerObservation | null {
  let best: SpeakerObservation | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const sample of observations) {
    const currentDistance = Math.abs(sample.atMs - atMs);
    if (currentDistance < distance) { best = sample; distance = currentDistance; }
  }
  return best && distance <= 900 ? best : null;
}

/** Match Whisper words to the nearest fresh Jitsi dominant-speaker observation and group turns. */
export function buildSpeakerTurns(words: TimedWord[], observations: SpeakerObservation[], gapMs = 900): SpeakerTurn[] {
  const attributed = words.map(word => {
    const sample = speakerAt(observations, (word.fromMs + word.toMs) / 2);
    return { word, sample };
  });
  const turns: SpeakerTurn[] = [];
  for (const { word, sample } of attributed) {
    const speaker = sample?.name || null;
    const id = sample?.id || null;
    const previous = turns.at(-1);
    const canJoin = previous && previous.speaker === speaker && previous.speakerId === id && word.fromMs - previous.toMs <= gapMs;
    if (canJoin) {
      previous.toMs = word.toMs;
      previous.text = `${previous.text} ${word.text}`.trim();
      previous.confidence = Number(((previous.confidence + (sample ? 1 : 0)) / 2).toFixed(3));
    } else {
      turns.push({ fromMs: word.fromMs, toMs: word.toMs, text: word.text.trim(), speaker, speakerId: id,
        confidence: sample ? 1 : 0, status: speaker ? "attributed" : "unknown" });
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
