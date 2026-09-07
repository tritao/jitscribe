import test from "node:test";
import assert from "node:assert/strict";
import { SpeakerBinder } from "./binder.js";
import type { SpeakerSignal } from "./speakers.js";

const signal = (atMs: number, id: string, name: string, phase: SpeakerSignal["phase"]): SpeakerSignal => ({
  atMs, id, name, phase, source: "redux",
});

test("lag-corrects a hint and resolves a covered Whisper interval", () => {
  const result = new SpeakerBinder([
    signal(1_250, "a", "Alice", "start"),
    signal(3_250, "a", "Alice", "heartbeat"),
  ]).resolve(1_000, 1_600);
  assert.deepEqual(result, { speaker: "Alice", speakerId: "a", confidence: 1, samples: 1, status: "attributed" });
});

test("rejects a short closed dominant-speaker flicker", () => {
  const result = new SpeakerBinder([
    signal(1_000, "a", "Alice", "start"),
    signal(1_700, "a", "Alice", "end"),
  ]).resolve(900, 1_500);
  assert.equal(result.speaker, null);
  assert.equal(result.status, "unknown");
});

test("expires an open turn after the heartbeat grace", () => {
  const result = new SpeakerBinder([
    signal(1_000, "a", "Alice", "start"),
  ]).resolve(5_000, 5_500);
  assert.equal(result.speaker, null);
  assert.equal(result.status, "unknown");
});

test("marks overlapping equally supported names ambiguous", () => {
  const result = new SpeakerBinder([
    signal(1_000, "a", "Alice", "start"),
    signal(2_000, "b", "Bob", "start"),
    signal(3_500, "a", "Alice", "end"),
  ]).resolve(2_000, 3_000);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.speaker, "Bob");
  assert.equal(result.confidence, 0.5);
});
