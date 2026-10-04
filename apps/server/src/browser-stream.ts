import type { Server } from "node:http";
import { PNG } from "pngjs";
import { WebSocketServer, WebSocket } from "ws";
import type { Auth } from "./auth.ts";
import type { BrowserService } from "./browser.ts";

const names: Record<number, string> = {
  0xff08: "Backspace",
  0xff09: "Tab",
  0xff0d: "Enter",
  0xff1b: "Escape",
  0xffff: "Delete",
  0xff50: "Home",
  0xff51: "ArrowLeft",
  0xff52: "ArrowUp",
  0xff53: "ArrowRight",
  0xff54: "ArrowDown",
  0xff55: "PageUp",
  0xff56: "PageDown",
  0xff57: "End",
  0xff63: "Insert",
  0xffe1: "Shift",
  0xffe2: "Shift",
  0xffe3: "Control",
  0xffe4: "Control",
  0xffe7: "Meta",
  0xffe8: "Meta",
  0xffeb: "Meta",
  0xffec: "Meta",
  0xffe9: "Alt",
  0xffea: "Alt",
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
    rendering = false,
    inputChain = Promise.resolve(),
    queuedInputs = 0;
  let format = { bigEndian: false, r: 16, g: 8, b: 0 };
  const send = (buffer: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(buffer);
  };
  const fail = () => ws.close(1008, "브라우저 연결을 다시 여세요");
  send(Buffer.from("RFB 003.008\n"));
  const input = (value: unknown) => {
    if (++queuedInputs > 128) {
      fail();
      return;
    }
    inputChain = inputChain
      .then(() => browser.streamInput(owner, id, value))
      .then(() => {}, fail)
      .finally(() => {
        queuedInputs--;
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
        } else if (type === 3) {
          length = 10;
          if (pending.length < length) return;
          frameRequested = true;
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
      ws.bufferedAmount > 5 * 1024 * 1024
    )
      return;
    rendering = true;
    frameRequested = false;
    void (async () => {
      const response = await browser.preview(owner, id);
      const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
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
  }, 250);
  timer.unref();
  ws.once("close", () => {
    clearInterval(timer);
    void browser.streamInput(owner, id, { type: "vnc_reset" }).catch(() => {});
  });
  ws.on("error", () => {});
}
