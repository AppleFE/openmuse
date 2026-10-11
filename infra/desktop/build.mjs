import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const stage = join(root, `artifacts/desktop-app-${Date.now()}`);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry) throw new Error("Run this build with pnpm build:windows.");
const pnpm = /\.exe$/i.test(pnpmEntry) ? pnpmEntry : process.execPath;
const run = (command, args, options = {}) =>
  execFileSync(command, [...(command === pnpm && pnpm !== pnpmEntry ? [pnpmEntry] : []), ...args], {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
run(pnpm, ["build:server"]);
// Never let Expo inline the developer's public endpoint or .env values.
run(
  pnpm,
  [
    "--dir",
    "apps/mobile",
    "exec",
    "expo",
    "export",
    "--platform",
    "web",
    "--output-dir",
    "../../artifacts/desktop-web",
  ],
  {
    env: {
      ...process.env,
      EXPO_NO_DOTENV: "1",
      EXPO_PUBLIC_API_URL: "http://127.0.0.1:8787",
      EXPO_NO_TELEMETRY: "1",
    },
  },
);
run(pnpm, ["build:host-agent"]);
// package.json files is an explicit runtime-only allowlist. pnpm deploy creates a
// portable production dependency graph from the lockfile, including peer dependencies.
run(pnpm, ["--filter", "openmuse", "deploy", "--legacy", "--prod", stage]);
await cp(join(root, "artifacts/desktop-web"), join(stage, "web"), { recursive: true });
await cp(join(root, "apps/desktop/preload.cjs"), join(stage, "preload.cjs"));
// Ship the matching Chromium runtime, so users need no Docker, Node or first-run download.
run(
  process.execPath,
  [
    join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js"),
    "install",
    "chromium",
    "--only-shell",
  ],
  {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(root, "artifacts/desktop-browsers") },
  },
);
await build({
  entryPoints: [join(root, "apps/desktop/main.mjs")],
  outfile: join(stage, "main.mjs"),
  platform: "node",
  format: "esm",
  bundle: true,
  external: ["electron"],
  target: "node24",
  sourcemap: false,
});
await writeFile(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "openmuse-desktop",
      productName: "OpenMuse",
      version: manifest.version,
      description: "OpenMuse personal AI workspace",
      author: "OpenMuse contributors",
      license: "MIT",
      type: "module",
      main: "main.mjs",
      dependencies: manifest.dependencies,
    },
    null,
    2,
  ),
);
await mkdir(join(root, "artifacts"), { recursive: true });
await writeFile(join(root, "artifacts/desktop-stage.json"), JSON.stringify({ stage }));
execFileSync(
  process.execPath,
  [
    createRequire(import.meta.url).resolve("electron-builder/cli.js"),
    "--config",
    "infra/desktop/electron-builder.cjs",
    `--config.directories.app=${stage}`,
    "--win",
    ...(process.argv.includes("--dir") ? ["--dir"] : []),
    "--x64",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  },
);
