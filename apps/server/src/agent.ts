import "./config.ts";
import { HttpAgent } from "@ag-ui/client";
import {
  type AgentRunner,
  type AgentsFactory,
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { ConversationAgent } from "./engine/conversation.ts";
import type { AgentService } from "./engine/service.ts";

export function agentConfigured(config: Config) {
  const modelConfigured = (config.models ?? []).some((model) => {
    if (!model.enabled) return false;
    if (model.provider === "openai") return Boolean(process.env.OPENAI_API_KEY);
    if (model.provider === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY);
    if (model.provider === "google")
      return Boolean(
        process.env.GOOGLE_API_KEY ??
          process.env.GEMINI_API_KEY ??
          process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      );
    if (model.provider === "ollama") return Boolean(config.ollamaBaseUrl);
    return Boolean(config.openCodexBaseUrl && config.openCodexApiKey);
  });
  return (
    config.agentBackend === "sample" ||
    (config.agentBackend === "agui"
      ? Boolean(config.agentUrl)
      : Boolean(
          modelConfigured ||
            (config.model &&
              (process.env.OPENAI_API_KEY ||
                process.env.ANTHROPIC_API_KEY ||
                process.env.GOOGLE_API_KEY ||
                process.env.GEMINI_API_KEY ||
                process.env.GOOGLE_GENERATIVE_AI_API_KEY)),
        ))
  );
}
export function makeRuntime(
  config: Config,
  service: AgentService,
  auth: Auth,
  runner: AgentRunner,
) {
  const agents: AgentsFactory = async ({ request }) => {
    const owner = await auth.owner(request.headers.get("authorization") ?? undefined);
    const selected = config.agentBackend === "model" ? await service.resolveModel(owner) : null;
    return {
      default:
        config.agentBackend === "sample"
          ? new ConversationAgent(config, service, owner)
          : config.agentBackend === "agui"
            ? new HttpAgent({
                url: config.agentUrl ?? "http://127.0.0.1:1/unconfigured",
                headers: config.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {},
              })
            : new ConversationAgent(config, service, owner, selected),
    };
  };
  const runtime = new CopilotRuntime({
    agents,
    runner,
  });
  return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" });
}
