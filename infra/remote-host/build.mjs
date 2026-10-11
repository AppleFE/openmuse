import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
      version: "0.10.3",
      private: true,
      type: "module",
      scripts: { start: "node run.mjs", setup: "node setup.mjs" },
      engines: { node: ">=22.19.0" },
      dependencies: {
        playwright: worker.dependencies.playwright,
        zod: "4.6.5",
        systeminformation: "5.33.15",
      },
    },
    null,
    2,
  ),
);
await mkdir(`${directory}/infra/desktop`, { recursive: true });
for (const name of ["driver.py", "requirements.txt"])
  await copyFile(`infra/desktop/${name}`, `${directory}/infra/desktop/${name}`);
for (const name of ["install-desktop.mjs", "desktop-helper.mjs"])
  await copyFile(`infra/remote-host/${name}`, `${directory}/${name}`);
await copyFile("infra/remote-host/setup.mjs", `${directory}/setup.mjs`);
await copyFile("infra/remote-host/run.mjs", `${directory}/run.mjs`);
await copyFile("infra/remote-host/install.mjs", `${directory}/install.mjs`);
await copyFile("infra/remote-host/cli.mjs", `${directory}/cli.mjs`);
await copyFile("infra/remote-host/install-cli.mjs", `${directory}/install-cli.mjs`);
await copyFile("docs/REMOTE-HOSTS.md", `${directory}/README.md`);
await copyFile("docs/COMPUTER-USE.md", `${directory}/COMPUTER-USE.md`);
await copyFile("docs/HOST-EVENTS.md", `${directory}/HOST-EVENTS.md`);
const npmCli = resolve(
  dirname(process.execPath),
  process.platform === "win32"
    ? "node_modules/npm/bin/npm-cli.js"
    : "../lib/node_modules/npm/bin/npm-cli.js",
);
const lock = spawnSync(
  process.execPath,
  [npmCli, "install", "--package-lock-only", "--ignore-scripts", "--omit=dev"],
  { cwd: directory, stdio: "inherit" },
);
if (lock.status !== 0) process.exit(lock.status ?? 1);
const archive = resolve("dist/openmuse-host-agent-0.10.3.tar.gz");
const tar = spawnSync(
  "tar",
  [
    "-czf",
    archive,
    "-C",
    resolve("dist"),
    ...[
      "apps",
      "packages",
      "infra",
      "install-desktop.mjs",
      "desktop-helper.mjs",
      "package.json",
      "package-lock.json",
      "setup.mjs",
      "run.mjs",
      "install.mjs",
      "cli.mjs",
      "install-cli.mjs",
      "README.md",
      "HOST-EVENTS.md",
      "COMPUTER-USE.md",
    ].map((file) => `host-agent/${file}`),
  ],
  { stdio: "inherit" },
);
if (tar.status !== 0) process.exit(tar.status ?? 1);
await copyFile("docs/REMOTE-HOSTS.md", `${directory}/README.md`);
console.log(
  "Portable Host Agent built at dist/host-agent (npm install; npx playwright install chromium; npm run setup; npm start)",
);
