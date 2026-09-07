import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { Page } from "playwright-core";
import { join } from "./jitsi.js";
import { TranscriptPipeline } from "./pipeline.js";
import { parseWhisperResponse } from "./transcript.js";

class MockHeadlessPage {
  joined = false;
  navigatedUrl = "";

  async goto(url: string): Promise<void> {
    this.navigatedUrl = url;
    this.joined = true;
  }

  async waitForTimeout(): Promise<void> {}

  async evaluate<T>(): Promise<T> {
    return this.joined as T;
  }
}

test("mocked headless join flows from captured chunk to attributed JSONL", async () => {
  const page = new MockHeadlessPage();
  await join(page as unknown as Page, "https://meet.jit.si/MockIntegrationRoom", "Test Bot", undefined, 1_000);
  assert.match(page.navigatedUrl, /config\.startWithAudioMuted=true/);
  assert.match(page.navigatedUrl, /userInfo\.displayName=/);

  const root = await mkdtemp(joinPath(tmpdir(), "jitscribe-integration-"));
  try {
    const chunkDir = joinPath(root, "chunks");
    const output = joinPath(root, "transcript.jsonl");
    await mkdir(chunkDir);
    await writeFile(joinPath(chunkDir, "chunk-000000.wav"), Buffer.alloc(128));

    let transcribedPath = "";
    const worker = {
      async transcribe(wav: string, language: string) {
        transcribedPath = wav;
        assert.equal(language, "en");
        return parseWhisperResponse({ segments: [{
          start: 0.1,
          end: 0.9,
          text: " Hello there",
          words: [
            { start: 0.1, end: 0.4, word: " Hello", probability: 0.99 },
            { start: 0.6, end: 0.9, word: " there", probability: 0.98 },
          ],
        }] });
      },
    };
    const pipeline = new TranscriptPipeline({
      chunkDir,
      output,
      sessionId: "integration-session",
      captureStartedAtMs: 1_000,
      chunkSeconds: 15,
      overlapSeconds: 0,
      language: "en",
      ffmpeg: "/unused-in-overlap-free-test",
      keepAudio: false,
      worker,
      getSpeakerObservations: () => [
        { atMs: 1_250, id: "alice-id", name: "Alice", source: "redux" },
        { atMs: 1_750, id: "alice-id", name: "Alice", source: "redux" },
      ],
      getSpeakerEvents: () => [
        { atMs: 1_000, id: "alice-id", name: "Alice", source: "redux", phase: "start" },
      ],
    });
    const segments = await pipeline.process(true);
    assert.equal((await pipeline.process(true)).length, 0);

    assert.match(transcribedPath, /chunk-000000\.wav$/);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, "Hello there");
    assert.equal(segments[0].speaker, "Alice");
    assert.equal(segments[0].speakerStatus, "attributed");
    assert.equal(segments[0].speakerConfidence, 1);
    assert.equal(segments[0].sessionId, "integration-session");
    assert.equal(segments[0].segmentId, "integration-session:chunk-000000:turn-0000-0000");
    assert.equal(segments[0].revision, 0);
    const records = (await readFile(output, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].speakerId, "alice-id");
    assert.equal(records[0].segmentId, segments[0].segmentId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
