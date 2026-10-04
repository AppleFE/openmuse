import { resolve } from "node:path";
import { createHostAgent } from "./server.ts";

const port = Number(process.env.HOST_AGENT_PORT ?? 8791);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid HOST_AGENT_PORT");
const agent = await createHostAgent({
  token: process.env.HOST_AGENT_TOKEN ?? "",
  dataDir: resolve(process.env.HOST_AGENT_DATA_DIR ?? ".openmuse/host-agent"),
});
agent.server.listen(port, process.env.HOST_AGENT_HOST ?? "127.0.0.1", () =>
  console.log(`OpenMuse Host Agent listening on port ${port}`),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  await agent.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
