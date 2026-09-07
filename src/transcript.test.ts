import test from "node:test";
import assert from "node:assert/strict";
import { isMeaningfulTranscript } from "./transcript.js";

test("silence markers are not meaningful transcript text", () => {
  assert.equal(isMeaningfulTranscript("[BLANK_AUDIO]"), false);
  assert.equal(isMeaningfulTranscript(" [ Silence ] "), false);
  assert.equal(isMeaningfulTranscript("Hello"), true);
});
