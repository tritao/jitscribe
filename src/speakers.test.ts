import test from "node:test";
import assert from "node:assert/strict";
import { attributeSpeaker, type SpeakerObservation } from "./speakers.js";

const sample = (atMs: number, id: string, name: string): SpeakerObservation => ({ atMs, id, name, source: "redux" });

test("attributes the speaker with the most observations inside a segment", () => {
  const result = attributeSpeaker([
    sample(100, "a", "Alice"), sample(200, "a", "Alice"), sample(300, "b", "Bob"),
  ], 50, 350);
  assert.equal(result.speaker, "Alice");
  assert.equal(result.confidence, 0.667);
  assert.equal(result.samples, 3);
});

test("does not borrow observations outside the segment", () => {
  assert.equal(attributeSpeaker([sample(10, "a", "Alice")], 100, 200).speaker, null);
});
