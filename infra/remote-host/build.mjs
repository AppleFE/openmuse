import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const build = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "apps/host-agent/tsconfig.json"],
  { stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);
const directory = resolve("dist/host-agent");
await mkdir(directory, { recursive: true });
const worker = JSON.parse(await readFile("apps/worker/package.json", "utf8"));
await writeFile(
  `${directory}/package.json`,
  JSON.stringify(
    {
      name: "@openmuse/host-agent",
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { start: "node run.mjs", setup: "node setup.mjs" },
      engines: { node: ">=22.19.0" },
      dependencies: { playwright: worker.dependencies.playwright, zod: "4.6.5" },
    },
    null,
    2,
  ),
);
await copyFile("infra/remote-host/setup.mjs", `${directory}/setup.mjs`);
await copyFile("infra/remote-host/run.mjs", `${directory}/run.mjs`);
await copyFile("docs/REMOTE-HOSTS.md", `${directory}/README.md`);
console.log(
  "Portable Host Agent built at dist/host-agent (npm install; npx playwright install chromium; npm run setup; npm start)",
);
