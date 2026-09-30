import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("run-command.mjs", import.meta.url));

test("passes only explicitly allowlisted .env names to build commands", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-command-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const envFile = join(root, ".env");
  await writeFile(
    envFile,
    "EXPO_PUBLIC_API_URL=http://100.80.94.16:8081\nOPENAI_API_KEY=must-not-reach-build\n",
  );
  const childCode =
    "console.log(JSON.stringify({ publicUrl: process.env.EXPO_PUBLIC_API_URL, providerKey: process.env.OPENAI_API_KEY }))";
  const result = spawnSync(
    process.execPath,
    [runner, envFile, "EXPO_PUBLIC_API_URL", process.execPath, "-e", childCode],
    {
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name !== "OPENAI_API_KEY"),
      ),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    publicUrl: "http://100.80.94.16:8081",
  });
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /must-not-reach-build/);
});
