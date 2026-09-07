import test from "node:test";
import assert from "node:assert/strict";
import { isMeaningfulTranscript, parseWhisperResponse, shouldEmitSegment } from "./transcript.js";

test("silence markers are not meaningful transcript text", () => {
  assert.equal(isMeaningfulTranscript("[BLANK_AUDIO]"), false);
  assert.equal(isMeaningfulTranscript(" [ Silence ] "), false);
  assert.equal(isMeaningfulTranscript("Hello"), true);
});

test("watermark delays boundary speech and deduplicates emitted segments", () => {
  assert.equal(shouldEmitSegment(12_000, 0, 13_000), true);
  assert.equal(shouldEmitSegment(14_000, 0, 13_000), false);
  assert.equal(shouldEmitSegment(12_000, 12_000, 28_000), false);
  assert.equal(shouldEmitSegment(14_000, 12_000, 28_000), true);
});

test("parses timestamped verbose_json and removes silence", () => {
  assert.deepEqual(parseWhisperResponse({ segments: [
    { start: 1.25, end: 2.75, text: " Hello" },
    { start: 3, end: 4, text: "[BLANK_AUDIO]" },
  ] }), [{ fromMs: 1250, toMs: 2750, text: "Hello", words: [] }]);
});
