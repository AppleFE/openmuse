import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";

/** A durable loopback origin keeps Host Agent callbacks valid across restarts. */
export async function listenDesktop(server: Server, dataDir: string) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, "endpoint.json");
  let port = 0;
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (!Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535)
      throw new Error("Invalid saved desktop port");
    port = saved.port;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local server could not start");
  if (!port) await writeFile(file, JSON.stringify({ port: address.port }), { flag: "wx" });
  return `http://127.0.0.1:${address.port}`;
}
