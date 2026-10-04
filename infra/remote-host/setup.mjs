import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// A dedicated credential; existing OpenMuse and model-provider settings are never touched.
const directory = resolve(process.argv[2] ?? ".host-agent");
await mkdir(directory, { recursive: true, mode: 0o700 });
const path = resolve(directory, "config.json");
try {
  await writeFile(
    path,
    JSON.stringify(
      {
        token: randomBytes(32).toString("hex"),
        host: "127.0.0.1",
        port: 8791,
        dataDir: resolve(directory, "state"),
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    `Host Agent config created: ${path}. Add its token to the OpenMuse connector; run.mjs does not print it.`,
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(`Existing config retained: ${path}`);
}
