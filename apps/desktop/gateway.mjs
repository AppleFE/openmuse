import { once } from "node:events";
import { createServer } from "node:http";

/** Keep the existing model runtime, adapting only the documented ChatGPT plan wire format. */
export function planRequest(body) {
  if (!body || typeof body.model !== "string" || !Array.isArray(body.input))
    throw new Error("모델과 대화 입력을 확인해 주세요.");
  const namespaced = new Set((body.tools || []).map((tool) => tool.name));
  const output = {
    model: body.model,
    store: false,
    stream: true,
    input: body.input.map((item) =>
      item.role === "system"
        ? { ...item, role: "developer" }
        : item.type === "function_call" && namespaced.has(item.name)
          ? { ...item, namespace: item.namespace || "openmuse" }
          : item,
    ),
  };
  for (const key of [
    "instructions",
    "reasoning",
    "text",
    "include",
    "parallel_tool_calls",
    "prompt_cache_key",
  ])
    if (body[key] !== undefined) output[key] = body[key];
  if (body.tools?.length) {
    if (body.tools.some((tool) => tool.type !== "function"))
      throw new Error("ChatGPT 연결은 OpenMuse의 함수 도구를 지원합니다.");
    output.tools = [
      { type: "namespace", name: "openmuse", description: "OpenMuse tools", tools: body.tools },
    ];
  }
  if (body.tool_choice === "none" || body.tool_choice === "auto" || body.tool_choice === "required")
    output.tool_choice = body.tool_choice;
  else if (body.tool_choice?.type === "function")
    output.tool_choice = { ...body.tool_choice, namespace: "openmuse" };
  return output;
}

export function modelCatalog(body) {
  if (!Array.isArray(body?.models)) throw new Error("ChatGPT 모델 목록 형식이 올바르지 않습니다.");
  return {
    data: body.models
      .filter((model) => model.visibility === "list")
      .map((model) => {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: reject unsafe provider model IDs.
        if (typeof model.slug !== "string" || !/^[^\s\x00-\x1f]{1,200}$/.test(model.slug))
          throw new Error("ChatGPT 모델 ID가 올바르지 않습니다.");
        return {
          id: model.slug,
          display_name: model.display_name || model.slug,
          capabilities: {
            supports_tool_use: model.supports_tool_use !== false,
            ...(typeof model.supports_vision === "boolean"
              ? { supports_vision: model.supports_vision }
              : {}),
            ...(Array.isArray(model.input_modalities)
              ? { input_modalities: model.input_modalities }
              : {}),
          },
        };
      }),
  };
}

function providerError(status, code) {
  if (status === 429 || code === "subscription_sharing_usage_limit_exceeded")
    return "ChatGPT 사용 한도에 도달했습니다. 계정의 사용량 관리에서 확인해 주세요.";
  if (status === 401) return "ChatGPT 인증이 만료되었습니다. 다시 로그인해 주세요.";
  if (status === 403 || code === "subscription_sharing_usage_unavailable")
    return "ChatGPT 요금제 사용이 허용되지 않았습니다. 계정의 앱 사용 권한을 확인해 주세요.";
  return `ChatGPT 요청에 실패했습니다 (HTTP ${status}${/^[a-z_]{1,80}$/.test(code) ? `, ${code}` : ""}).`;
}

export async function startGateway(accounts, secret, fetcher = fetch) {
  const json = (res, status, data) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${secret}` || req.headers.origin) {
      json(res, 401, { error: { message: "Unauthorized" } });
      return;
    }
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      if (req.method === "GET" && req.url === "/v1/models") {
        if (!accounts.status().sharing) {
          json(res, 200, { data: [] });
          return;
        }
        await accounts.authorized(async (token, signal) => {
          const response = await fetcher("https://api.openai.com/v1/models", {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          });
          if (!response.ok) throw new Error(providerError(response.status));
          json(res, 200, modelCatalog(await response.json()));
        }, controller.signal);
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        json(res, 404, { error: { message: "Not found" } });
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 100 * 1024 * 1024) throw new Error("모델 입력이 너무 큽니다.");
        chunks.push(chunk);
      }
      const body = planRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      await accounts.authorized(async (token, signal) => {
        const response = await fetcher("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
        });
        if (!response.ok || !response.body) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(providerError(response.status, detail.error?.code));
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        // Preserve every tool, image, reasoning and usage event. The Pi Responses parser
        // validates terminal events, including response.failed/incomplete and interrupted streams.
        for await (const chunk of response.body) {
          if (!res.write(chunk)) await once(res, "drain", { signal });
        }
        signal.throwIfAborted();
        res.end();
      }, controller.signal);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(res, 502, {
        error: { message: error instanceof Error ? error.message : "ChatGPT 연결 실패" },
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
