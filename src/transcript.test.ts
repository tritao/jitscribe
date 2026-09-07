import test from "node:test";
import assert from "node:assert/strict";
import { isMeaningfulTranscript, parseWhisperResponse } from "./transcript.js";

test("silence markers are not meaningful transcript text", () => {
  assert.equal(isMeaningfulTranscript("[BLANK_AUDIO]"), false);
  assert.equal(isMeaningfulTranscript(" [ Silence ] "), false);
  assert.equal(isMeaningfulTranscript("Hello"), true);
});

test("parses timestamped verbose_json and removes silence", () => {
  assert.deepEqual(parseWhisperResponse({ segments: [
    { start: 1.25, end: 2.75, text: " Hello" },
    { start: 3, end: 4, text: "[BLANK_AUDIO]" },
  ] }), [{ fromMs: 1250, toMs: 2750, text: "Hello" }]);
});
