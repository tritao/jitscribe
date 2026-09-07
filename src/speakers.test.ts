import test from "node:test";
import assert from "node:assert/strict";
import { attributeSpeaker, buildSpeakerTurns, type SpeakerObservation } from "./speakers.js";

const sample = (atMs: number, id: string, name: string): SpeakerObservation => ({ atMs, id, name, source: "redux" });

test("attributes the speaker with the most observations inside a segment", () => {
  const result = attributeSpeaker([
    sample(100, "a", "Alice"), sample(200, "a", "Alice"), sample(300, "b", "Bob"),
  ], 50, 350);
  assert.equal(result.speaker, "Alice");
  assert.equal(result.confidence, 0.667);
  assert.equal(result.samples, 3);
  assert.equal(result.status, "attributed");
});

test("marks tied interval evidence as ambiguous and discounts a lone sample", () => {
  const result = attributeSpeaker([sample(100, "a", "Alice"), sample(200, "b", "Bob")], 0, 300);
  assert.equal(result.speaker, "Alice");
  assert.equal(result.confidence, 0.25);
  assert.equal(result.status, "ambiguous");
});

test("does not borrow observations outside the segment", () => {
  assert.equal(attributeSpeaker([sample(10, "a", "Alice")], 100, 200).speaker, null);
});

test("splits Whisper words into speaker turns", () => {
  const turns = buildSpeakerTurns([
    { fromMs: 100, toMs: 400, text: "Hello" },
    { fromMs: 450, toMs: 800, text: "there" },
    { fromMs: 1600, toMs: 1900, text: "Goodbye" },
  ], [sample(200, "a", "Alice"), sample(650, "a", "Alice"), sample(1700, "b", "Bob")]);
  assert.deepEqual(turns.map(turn => ({ speaker: turn.speaker, text: turn.text })), [
    { speaker: "Alice", text: "Hello there" },
    { speaker: "Bob", text: "Goodbye" },
  ]);
});

test("leaves words unknown when speaker evidence is stale", () => {
  const turns = buildSpeakerTurns([{ fromMs: 5000, toMs: 5400, text: "Unknown" }], [sample(100, "a", "Alice")]);
  assert.equal(turns[0].speaker, null);
  assert.equal(turns[0].status, "unknown");
});

test("offsets relative Whisper words into recorder time", () => {
  const turns = buildSpeakerTurns([{ fromMs: 100, toMs: 400, text: "Hello" }], [sample(1200, "a", "Alice")], 900, 1000);
  assert.equal(turns[0].speaker, "Alice");
  assert.equal(turns[0].confidence, 0.944);
});

test("flags competing dominant-speaker samples near a word", () => {
  const turns = buildSpeakerTurns([{ fromMs: 400, toMs: 600, text: "Hello" }], [sample(450, "a", "Alice"), sample(550, "b", "Bob")]);
  assert.equal(turns[0].speaker, "Alice");
  assert.equal(turns[0].status, "ambiguous");
  assert.equal(turns[0].confidence, 0.472);
});
