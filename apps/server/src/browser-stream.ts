import type { Server } from "node:http";
import { PNG } from "pngjs";
import { WebSocket, WebSocketServer } from "ws";
import type { Auth } from "./auth.ts";
import type { BrowserService } from "./browser.ts";

const names: Record<number, string> = {
  65288: "Backspace",
  65289: "Tab",
  65293: "Enter",
  65307: "Escape",
  65535: "Delete",
  65360: "Home",
  65361: "ArrowLeft",
  65362: "ArrowUp",
  65363: "ArrowRight",
  65364: "ArrowDown",
  65365: "PageUp",
  65366: "PageDown",
  65367: "End",
  65379: "Insert",
  65505: "Shift",
  65506: "Shift",
  65507: "Control",
  65508: "Control",
  65511: "Meta",
  65512: "Meta",
  65515: "Meta",
  65516: "Meta",
  65513: "Alt",
  65514: "Alt",
};
function keyName(keysym: number) {
  if (names[keysym]) return names[keysym];
  if (keysym >= 0xffbe && keysym <= 0xffc9) return `F${keysym - 0xffbd}`;
  const cp = keysym >= 0x1000000 ? keysym - 0x1000000 : keysym;
  return cp >= 32 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
    ? String.fromCodePoint(cp)
    : undefined;
}
/** Authenticated RFB 3.8 browser framebuffer. No desktop daemon or public VNC port. */
export function attachBrowserStreams(server: Server, auth: Auth, browser: BrowserService) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: {
      threshold: 1024,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
    },
  });
  const counts = new Map<string, number>();
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://openmuse.invalid"),
        match = /^\/api\/browsers\/([a-f0-9-]{36})\/stream$/.exec(url.pathname);
      if (!match) throw new Error("Invalid stream");
      const owner = auth.verify(url);
      const session = await browser.get(owner, match[1]);
      if (session.status !== "active") throw new Error("Session closed");
      const countKey = `${owner}:${match[1]}`;
      if ((counts.get(countKey) ?? 0) >= 2) throw new Error("Stream limit");
      counts.set(countKey, (counts.get(countKey) ?? 0) + 1);
      request.socket.setNoDelay(true);
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.once("close", () => {
          const count = (counts.get(countKey) ?? 1) - 1;
          if (count) counts.set(countKey, count);
          else counts.delete(countKey);
        });
        startRfb(ws, owner, match[1], browser, Number(url.searchParams.get("expires")));
      });
    })().catch(() => {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    });
  });
  return {
    close: () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
function startRfb(
  ws: WebSocket,
  owner: string,
  id: string,
  browser: BrowserService,
  expires: number,
) {
  let pending = Buffer.alloc(0),
    phase = "version",
    frameRequested = false,
    rendering = false;
  const queuedInputs = new Set<Promise<unknown>>();
  let tight = false;
  let incremental = false;
  let lastTag: string | undefined;
  let format = { bigEndian: false, r: 16, g: 8, b: 0 };
  const send = (buffer: Buffer, compressedImage = false) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(buffer, { compress: !compressedImage });
  };
  const fail = () => ws.close(1008, "브라우저 연결을 다시 여세요");
  send(Buffer.from("RFB 003.008\n"));
  const input = (value: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const operation = browser.streamInput(owner, id, value);
    if (queuedInputs.has(operation)) return;
    queuedInputs.add(operation);
    if (queuedInputs.size > 128) {
      queuedInputs.delete(operation);
      void operation.catch(() => {});
      fail();
      return;
    }
    // Reserve each event in the shared session queue immediately, so HTTP IME/paste
    // input cannot overtake RFB keys still waiting for their worker response.
    void operation
      .then(() => {}, fail)
      .finally(() => {
        queuedInputs.delete(operation);
      });
  };
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      fail();
      return;
    }
    pending = Buffer.concat([
      pending,
      Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
    ]);
    if (pending.length > 65536) {
      fail();
      return;
    }
    try {
      while (pending.length) {
        if (phase === "version") {
          if (pending.length < 12) return;
          if (pending.subarray(0, 12).toString() !== "RFB 003.008\n") throw new Error();
          pending = pending.subarray(12);
          send(Buffer.from([1, 1]));
          phase = "security";
          continue;
        }
        if (phase === "security") {
          if (pending[0] !== 1) throw new Error();
          pending = pending.subarray(1);
          send(Buffer.alloc(4));
          phase = "init";
          continue;
        }
        if (phase === "init") {
          pending = pending.subarray(1);
          const name = Buffer.from("OpenMuse shared browser"),
            init = Buffer.alloc(24 + name.length);
          init.writeUInt16BE(1280, 0);
          init.writeUInt16BE(800, 2);
          init[4] = 32;
          init[5] = 24;
          init[7] = 1;
          init.writeUInt16BE(255, 8);
          init.writeUInt16BE(255, 10);
          init.writeUInt16BE(255, 12);
          init[14] = 16;
          init[15] = 8;
          init[16] = 0;
          init.writeUInt32BE(name.length, 20);
          name.copy(init, 24);
          send(init);
          phase = "ready";
          continue;
        }
        const type = pending[0];
        let length = 0;
        if (type === 0) {
          length = 20;
          if (pending.length < length) return;
          if (
            pending[4] !== 32 ||
            pending[7] !== 1 ||
            pending.readUInt16BE(8) !== 255 ||
            pending.readUInt16BE(10) !== 255 ||
            pending.readUInt16BE(12) !== 255
          )
            throw new Error();
          const shifts = [pending[14], pending[15], pending[16]];
          if (shifts.some((s) => ![0, 8, 16, 24].includes(s)) || new Set(shifts).size !== 3)
            throw new Error();
          format = { bigEndian: !!pending[6], r: shifts[0], g: shifts[1], b: shifts[2] };
        } else if (type === 2) {
          if (pending.length < 4) return;
          length = 4 + pending.readUInt16BE(2) * 4;
          if (length > 65536) throw new Error();
          if (pending.length < length) return;
          tight = false;
          for (let offset = 4; offset < length; offset += 4)
            if (pending.readInt32BE(offset) === 7) tight = true;
        } else if (type === 3) {
          length = 10;
          if (pending.length < length) return;
          frameRequested = true;
          incremental = !!pending[1];
        } else if (type === 4) {
          length = 8;
          if (pending.length < length) return;
          const key = keyName(pending.readUInt32BE(4));
          if (key) input({ type: "vnc_key", key, down: !!pending[1] });
        } else if (type === 5) {
          length = 6;
          if (pending.length < length) return;
          input({
            type: "vnc_mouse",
            buttons: pending[1],
            x: Math.min(1279, pending.readUInt16BE(2)),
            y: Math.min(799, pending.readUInt16BE(4)),
          });
        } else if (type === 6) {
          if (pending.length < 8) return;
          const bytes = pending.readUInt32BE(4);
          if (bytes > 40000) throw new Error();
          length = 8 + bytes;
          if (pending.length < length) return;
          const text = pending.subarray(8, length).toString("latin1");
          input({ type: "text", text });
        } else throw new Error();
        if (pending.length < length) return;
        pending = pending.subarray(length);
      }
    } catch {
      fail();
    }
  });
  const timer = setInterval(() => {
    if (Date.now() > expires) {
      fail();
      return;
    }
    if (
      !frameRequested ||
      rendering ||
      ws.readyState !== WebSocket.OPEN ||
      ws.bufferedAmount > 256 * 1024
    )
      return;
    rendering = true;
    frameRequested = false;
    const requestedIncremental = incremental;
    void (async () => {
      const response = tight
        ? await browser.liveFrame(owner, id, requestedIncremental ? lastTag : undefined)
        : await browser.preview(owner, id);
      if (response.status === 304) {
        frameRequested = true;
        return;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (tight && response.headers.get("content-type")?.startsWith("image/jpeg")) {
        if (bytes.length > 2 * 1024 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
          throw new Error("Invalid JPEG framebuffer");
        const header = Buffer.alloc(16);
        header.writeUInt16BE(1, 2);
        header.writeUInt16BE(1280, 8);
        header.writeUInt16BE(800, 10);
        header.writeInt32BE(7, 12); // RFB Tight, JPEG subencoding; no RGBA conversion.
        const length = bytes.length;
        const size = [length & 0x7f];
        if (length > 0x7f) {
          size[0] |= 0x80;
          size.push((length >> 7) & 0x7f);
        }
        if (length > 0x3fff) {
          size[1] |= 0x80;
          size.push(length >> 14);
        }
        send(Buffer.concat([header, Buffer.from([0x90, ...size]), bytes]), true);
        lastTag = response.headers.get("etag") ?? undefined;
        return;
      }
      const png = PNG.sync.read(bytes);
      if (png.width !== 1280 || png.height !== 800) throw new Error("Invalid framebuffer");
      const frame = Buffer.allocUnsafe(16 + 1280 * 800 * 4);
      frame.fill(0, 0, 16);
      frame.writeUInt16BE(1, 2);
      frame.writeUInt16BE(1280, 8);
      frame.writeUInt16BE(800, 10);
      for (let i = 0; i < png.data.length; i += 4) {
        const pixel =
          ((png.data[i] << format.r) |
            (png.data[i + 1] << format.g) |
            (png.data[i + 2] << format.b)) >>>
          0;
        if (format.bigEndian) frame.writeUInt32BE(pixel, 16 + i);
        else frame.writeUInt32LE(pixel, 16 + i);
      }
      send(frame);
    })()
      .catch(fail)
      .finally(() => {
        rendering = false;
      });
  }, 66);
  timer.unref();
  ws.once("close", () => {
    clearInterval(timer);
    void browser.streamInput(owner, id, { type: "vnc_reset" }).catch(() => {});
  });
  ws.on("error", () => {});
}
