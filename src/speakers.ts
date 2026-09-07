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
