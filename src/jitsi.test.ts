import test from "node:test";
import assert from "node:assert/strict";
import { buildMeetingUrl } from "./jitsi.js";

test("Vexa-derived URL builder mutes the bot and names it", () => {
  const url = buildMeetingUrl("https://meet.jit.si/Room", "Notes Bot");
  assert.match(url, /config.startWithAudioMuted=true/);
  assert.match(url, /config.startWithVideoMuted=true/);
  assert.match(decodeURIComponent(url), /userInfo.displayName="Notes Bot"/);
});
