import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const [envFile, allowedNames, command, ...args] = process.argv.slice(2);
if (!envFile || allowedNames === undefined || !command) {
  console.error("Usage: node run-command.mjs ENV_FILE NAME[,NAME...] COMMAND [ARG ...]");
  process.exit(64);
}

const fileEnv = parseEnv(readFileSync(envFile, "utf8"));
const selectedEnv = {};
for (const name of allowedNames.split(",").filter(Boolean)) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    console.error(`Invalid environment variable name: ${name}`);
    process.exit(64);
  }
  if (fileEnv[name] !== undefined) selectedEnv[name] = fileEnv[name];
}

const child = spawn(command, args, {
  stdio: "inherit",
  env: { ...process.env, ...selectedEnv },
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(`Could not start ${command}: ${error.message}`);
  process.exit(69);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
