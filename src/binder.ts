import type { SpeakerSignal } from "./speakers.js";

export interface SpeakerBinding {
  speaker: string | null;
  speakerId: string | null;
  confidence: number;
  samples: number;
  status: "attributed" | "unknown" | "ambiguous";
}

export interface SpeakerBinderOptions {
  /** Jitsi's dominant-speaker UI signal trails the mixed audio slightly. */
  lagMs?: number;
  /** Open turns remain usable until a heartbeat or explicit end arrives. */
  openTurnGraceMs?: number;
  /** Search tolerance around a Whisper word/turn. */
  matchToleranceMs?: number;
  /** Ignore short closed UI flickers. */
  flickerMinMs?: number;
  /** Minimum supporting time before a long turn can be named. */
  minSupportMs?: number;
  /** Minimum fraction of the Whisper interval covered by the winner. */
  minCoverage?: number;
  /** Minimum share of all supporting hint time held by the winner. */
  minConfidence?: number;
  /** Prefer the newer speaker when support is effectively tied. */
  recencyTieMs?: number;
}

interface HintTurn {
  id: string;
  name: string;
  startMs: number;
  endMs?: number;
}

interface Candidate {
  id: string;
  name: string;
  overlapMs: number;
  supportMs: number;
  lastStartMs: number;
}

const round = (value: number): number => Number(value.toFixed(3));

/**
 * A small local adaptation of Vexa's ClusterNameBinder for Jitscribe's
 * word-timestamped Whisper output. It consumes Jitsi start/heartbeat/end hints
 * and resolves a time range by overlap, rather than selecting one nearest poll.
 */
export class SpeakerBinder {
  private readonly lagMs: number;
  private readonly openTurnGraceMs: number;
  private readonly matchToleranceMs: number;
  private readonly flickerMinMs: number;
  private readonly minSupportMs: number;
  private readonly minCoverage: number;
  private readonly minConfidence: number;
  private readonly recencyTieMs: number;
  private readonly turns: HintTurn[] = [];
  private readonly open = new Map<string, HintTurn>();

  constructor(signals: readonly SpeakerSignal[] = [], options: SpeakerBinderOptions = {}) {
    this.lagMs = options.lagMs ?? 250;
    this.openTurnGraceMs = options.openTurnGraceMs ?? 4_000;
    this.matchToleranceMs = options.matchToleranceMs ?? 2_500;
    this.flickerMinMs = options.flickerMinMs ?? 1_000;
    this.minSupportMs = options.minSupportMs ?? 450;
    this.minCoverage = options.minCoverage ?? 0.35;
    this.minConfidence = options.minConfidence ?? 0.6;
    this.recencyTieMs = options.recencyTieMs ?? 1_000;
    const ordered = [...signals].sort((a, b) => a.atMs - b.atMs || phaseOrder(a.phase) - phaseOrder(b.phase));
    for (const signal of ordered) this.record(signal);
  }

  record(signal: SpeakerSignal): void {
    const atMs = signal.atMs - this.lagMs;
    const key = signal.id || signal.name;
    if (signal.phase === "end") {
      const turn = this.open.get(key);
      if (turn && turn.endMs === undefined) turn.endMs = atMs;
      this.open.delete(key);
      return;
    }

    const previous = this.open.get(key);
    if (previous && previous.endMs === undefined) previous.endMs = atMs;
    const turn: HintTurn = { id: signal.id, name: signal.name, startMs: atMs };
    this.turns.push(turn);
    this.open.set(key, turn);
  }

  resolve(fromMs: number, toMs: number): SpeakerBinding {
    const duration = Math.max(1, toMs - fromMs);
    const candidates = this.aggregate(fromMs, toMs);
    if (!candidates.length) return unknownBinding();

    const ranked = [...candidates].sort((a, b) => b.overlapMs - a.overlapMs || b.supportMs - a.supportMs || b.lastStartMs - a.lastStartMs);
    const best = ranked[0];
    const second = ranked[1];
    if (second && second.overlapMs >= best.overlapMs - this.recencyTieMs && second.lastStartMs > best.lastStartMs) {
      ranked[0] = second;
      ranked[1] = best;
    }

    const winner = ranked[0];
    const totalSupportMs = ranked.reduce((total, candidate) => total + candidate.supportMs, 0);
    const coverage = Math.min(1, winner.supportMs / duration);
    const confidence = totalSupportMs > 0 ? winner.supportMs / totalSupportMs : 0;
    const score = Math.min(coverage, confidence);
    const requiredSupport = Math.min(this.minSupportMs, duration * 0.8);
    const competing = ranked.length > 1 && ranked[1].supportMs >= winner.supportMs * 0.75;
    if (winner.supportMs < requiredSupport || coverage < this.minCoverage || confidence < this.minConfidence) {
      return competing
        ? { speaker: winner.name, speakerId: winner.id, confidence: round(score), samples: ranked.length, status: "ambiguous" }
        : unknownBinding(round(score));
    }
    return { speaker: winner.name, speakerId: winner.id, confidence: round(score), samples: ranked.length, status: "attributed" };
  }

  private aggregate(fromMs: number, toMs: number): Candidate[] {
    const windowStart = fromMs - this.matchToleranceMs;
    const windowEnd = toMs + this.matchToleranceMs;
    const supportStart = fromMs - 500;
    const supportEnd = toMs + 500;
    const byId = new Map<string, Candidate>();
    for (const turn of this.turns) {
      const endMs = turn.endMs ?? turn.startMs + this.openTurnGraceMs;
      if (turn.endMs !== undefined && endMs - turn.startMs < this.flickerMinMs) continue;
      const overlapMs = Math.max(0, Math.min(endMs, windowEnd) - Math.max(turn.startMs, windowStart));
      if (overlapMs <= 0) continue;
      const supportMs = Math.max(0, Math.min(endMs, supportEnd) - Math.max(turn.startMs, supportStart));
      if (supportMs <= 0) continue;
      const current = byId.get(turn.id) ?? { id: turn.id, name: turn.name, overlapMs: 0, supportMs: 0, lastStartMs: Number.NEGATIVE_INFINITY };
      current.overlapMs += overlapMs;
      current.supportMs += supportMs;
      current.lastStartMs = Math.max(current.lastStartMs, turn.startMs);
      byId.set(turn.id, current);
    }
    return [...byId.values()];
  }
}

function phaseOrder(phase: SpeakerSignal["phase"]): number {
  return phase === "end" ? 0 : 1;
}

function unknownBinding(confidence = 0): SpeakerBinding {
  return { speaker: null, speakerId: null, confidence, samples: 0, status: "unknown" };
}
