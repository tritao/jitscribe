import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMeeting, parseArgs } from "./options.js";

test("bare room uses meet.jit.si", () => {
  assert.equal(normalizeMeeting("TeamRoom"), "https://meet.jit.si/TeamRoom");
});
test("self-hosted room preserves host", () => {
  assert.equal(normalizeMeeting("Room", "https://jitsi.example.org"), "https://jitsi.example.org/Room");
});
test("parses retry and identity options", () => {
  const o = parseArgs(["join", "Room", "--name", "Notes", "--max-retries", "3"]);
  assert.equal(o.name, "Notes"); assert.equal(o.maxRetries, 3);
  assert.equal(o.overlapSeconds, 2);
});
test("selects the opt-in native transcriber", () => {
  const o = parseArgs(["Room", "--transcriber", "native"]);
  assert.equal(o.transcriber, "native");
});
test("rejects an unknown transcriber", () => {
  assert.throws(() => parseArgs(["Room", "--transcriber", "other"]), /transcriber must be server or native/);
});
test("rejects overlap as long as its chunk", () => {
  assert.throws(() => parseArgs(["Room", "--chunk-seconds", "5", "--overlap-seconds", "5"]));
});
test("uses the project-local whisper build and model by default", () => {
  const o = parseArgs(["Room"]);
  assert.match(o.whisper, /\.deps\/whisper\.cpp\/build\/bin\/whisper-server$/);
  assert.match(o.model, /\.deps\/whisper\.cpp\/models\/ggml-small\.bin$/);
  assert.match(o.vadModel, /\.deps\/whisper\.cpp\/models\/ggml-silero-v6\.2\.0\.bin$/);
});
