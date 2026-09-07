/* Adapted from Vexa's Apache-2.0 @vexa/join Jitsi module. See NOTICE. */
import type { Page } from "playwright-core";

const NAME = '[data-testid="prejoin.inputField"], input[placeholder*="name" i], input[aria-label*="name" i]';
const JOIN = '[data-testid="prejoin.joinMeeting"], button[aria-label*="join" i]';
const PASSWORD = 'input[type="password"], input[placeholder*="password" i]';

export function buildMeetingUrl(meetingUrl: string, botName: string): string {
  const url = new URL(meetingUrl);
  if (!url.pathname.replace(/\//g, "")) throw new Error(`Jitsi URL has no room: ${meetingUrl}`);
  const existing = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const parts = existing ? [existing] : [];
  if (!existing.includes("config.startWithAudioMuted=")) parts.push("config.startWithAudioMuted=true");
  if (!existing.includes("config.startWithVideoMuted=")) parts.push("config.startWithVideoMuted=true");
  if (!existing.includes("userInfo.displayName=")) parts.push(`userInfo.displayName=${encodeURIComponent(JSON.stringify(botName))}`);
  url.hash = parts.join("&");
  return url.toString();
}

export async function isJoined(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    try { return (globalThis as any).APP?.conference?.isJoined?.() === true; }
    catch { return false; }
  }).catch(() => false);
}

export async function join(page: Page, meetingUrl: string, name: string, password: string | undefined, timeoutMs: number): Promise<void> {
  await page.goto(buildMeetingUrl(meetingUrl, name), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_000);
  if (!await isJoined(page)) {
    const field = page.locator(NAME).first();
    if (await field.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await field.fill(name);
      const button = page.locator(JOIN).first();
      await button.waitFor({ state: "visible", timeout: 10_000 });
      await button.click();
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isJoined(page)) return;
    const pass = page.locator(PASSWORD).first();
    if (await pass.isVisible({ timeout: 200 }).catch(() => false)) {
      if (!password) throw new Error("room requires --password");
      await pass.fill(password);
      await pass.press("Enter");
    }
    const state = await page.evaluate(() => (document.body?.innerText ?? "").toLowerCase()).catch(() => "");
    if (["you were removed", "moderator denied", "has rejected"].some(text => state.includes(text))) {
      throw new Error("admission rejected by the meeting");
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`admission timed out after ${Math.round(timeoutMs / 1000)} seconds`);
}
