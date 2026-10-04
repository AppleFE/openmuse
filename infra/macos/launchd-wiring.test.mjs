import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const directory = new URL(".", import.meta.url);
const dispatcher = await readFile(fileURLToPath(new URL("launchd-dispatch.sh", directory)), "utf8");
const installer = await readFile(
  fileURLToPath(new URL("install-launch-agents.sh", directory)),
  "utf8",
);
const ollamaInstaller = await readFile(
  fileURLToPath(new URL("install-ollama-launch-agent.sh", directory)),
  "utf8",
);
const serviceRunner = await readFile(fileURLToPath(new URL("run-service.sh", directory)), "utf8");

test("restricted launcher permits only exact start and stop service commands", () => {
  assert.match(dispatcher, /server\|browser-worker\|web\|ollama\) action=start/);
  assert.match(dispatcher, /stop-server\) action=stop; service=server/);
  assert.match(dispatcher, /stop-browser-worker\) action=stop; service=browser-worker/);
  assert.match(dispatcher, /stop-web\) action=stop; service=web/);
  assert.match(dispatcher, /stop-ollama\) action=stop; service=ollama/);
  assert.match(dispatcher, /host-agent\) action=start; service=host-agent/);
  assert.match(dispatcher, /stop-host-agent\) action=stop; service=host-agent/);
  assert.match(dispatcher, /\*\) echo "OpenMuse launch command denied"/);
});

test("stop handshake verifies owner and exact command before its only signal", () => {
  assert.match(dispatcher, /\[ "\$candidate_user" = aeonge \] \|\| return 1/);
  for (const command of [
    "dist/apps/server/src/index.js",
    "--experimental-strip-types apps/worker/src/index.ts",
    "infra/macos/serve-web.mjs",
    "dist/host-agent/run.mjs",
    "/runtime/ollama/Ollama.app/Contents/Resources/ollama serve",
  ]) {
    assert.ok(dispatcher.includes(command));
  }
  const ownershipCheck = dispatcher.indexOf('if ! is_owned_process "$tracked_pid"');
  const termSignal = dispatcher.indexOf('/bin/kill -TERM "$tracked_pid"');
  assert.ok(ownershipCheck >= 0 && termSignal > ownershipCheck);
  assert.equal(dispatcher.match(/\/bin\/kill -[A-Z]+/g)?.length, 1);
  assert.doesNotMatch(dispatcher, /\b(?:lsof|pkill|killall)\b/);
});

test("installer unloads each tracked job before the restricted stop request", () => {
  const stopFunction = installer.slice(
    installer.indexOf("stop_loaded_service()"),
    installer.indexOf("set +e", installer.indexOf("stop_loaded_service()")),
  );
  const bootout = stopFunction.indexOf('/bin/launchctl bootout "$domain/$label"');
  const restrictedStop = stopFunction.indexOf('restricted_ssh "stop-$service"');
  assert.ok(bootout >= 0 && restrictedStop > bootout);
  assert.doesNotMatch(installer, /com\.openmuse\.colima/);
  assert.doesNotMatch(installer, /kickstart/);
});

test("Ollama service persists its runtime, model, and state under the mounted P41 root", () => {
  assert.match(serviceRunner, /server\|browser-worker\|web\|ollama/);
  assert.match(serviceRunner, /OLLAMA_HOST=127\.0\.0\.1:11434/);
  assert.match(serviceRunner, /OLLAMA_MODELS="\$models"/);
  assert.match(serviceRunner, /OLLAMA_NO_CLOUD=1/);
  assert.match(serviceRunner, /OLLAMA_CONTEXT_LENGTH=8192/);
  assert.match(serviceRunner, /OLLAMA_NUM_PARALLEL=1/);
  assert.match(serviceRunner, /OLLAMA_MAX_LOADED_MODELS=1/);
  assert.match(serviceRunner, /OLLAMA_MAX_QUEUE=8/);
  assert.match(ollamaInstaller, /com\.openmuse\.ollama\.plist/);
  assert.match(ollamaInstaller, /restricted_ssh stop-ollama/);
  assert.doesNotMatch(ollamaInstaller, /com\.openmuse\.(?:server|browser-worker|web)\.plist/);
  assert.doesNotMatch(ollamaInstaller, /authorized_keys|ssh-keygen|keyscan/);
});
