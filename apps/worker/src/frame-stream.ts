import type { CDPSession, Page } from "playwright";

/** Keep only Chromium's newest JPEG; capturing never occupies the input queue. */
export function createFrameStream(page: Page) {
  let cdp: CDPSession | undefined;
  let starting: Promise<void> | undefined;
  let frame: { bytes: Buffer; tag: string } | undefined;
  let sequence = 0;
  let touched = Date.now();
  let closed = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  async function stop() {
    const current = cdp;
    cdp = undefined;
    starting = undefined;
    frame = undefined;
    if (current) {
      await current.send("Page.stopScreencast").catch(() => {});
      await current.detach().catch(() => {});
    }
  }
  async function start() {
    const current = await page.context().newCDPSession(page);
    if (closed) {
      await current.detach();
      throw new Error("Browser closed");
    }
    cdp = current;
    let first: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      first = resolve;
    });
    current.on("Page.screencastFrame", (event) => {
      void current.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
      if (closed || cdp !== current) return;
      const bytes = Buffer.from(event.data, "base64");
      if (bytes.length > 2 * 1024 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
      frame = { bytes, tag: `"frame-${++sequence}"` };
      first();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await current.send("Page.startScreencast", {
        format: "jpeg",
        quality: 75,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 1,
      });
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Chromium frame timed out")), 3000);
        }),
      ]);
    } catch (error) {
      await stop();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    async latest() {
      if (closed) throw new Error("Browser closed");
      touched = Date.now();
      clearTimeout(idle);
      idle = setTimeout(() => {
        if (Date.now() - touched >= 14_900) void stop();
      }, 15_000);
      idle.unref();
      if (!starting) starting = start();
      await starting;
      if (!frame) throw new Error("Chromium frame unavailable");
      return frame;
    },
    async close() {
      closed = true;
      clearTimeout(idle);
      await stop();
    },
  };
}
