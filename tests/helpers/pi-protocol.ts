import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

export type PiProtocolTurn =
  | { tool: { name: string; arguments: Record<string, unknown> } }
  | { text: string };

export interface PiProtocolRequest {
  authorization?: string;
  body: Record<string, unknown>;
  path: string;
}

function writeEvent(
  response: import("node:http").ServerResponse,
  type: string,
  sequenceNumber: number,
  value: Record<string, unknown>,
) {
  response.write(
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...value })}\n\n`,
  );
}

/** Local OpenAI Responses-compatible transport for real embedded-pi SDK acceptance tests. */
export async function piProtocolFixture(t: TestContext, turns: readonly PiProtocolTurn[]) {
  const requests: PiProtocolRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const index = requests.length;
    requests.push({
      authorization: request.headers.authorization,
      body,
      path: request.url ?? "",
    });
    const turn = turns[index];
    if (!turn) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: `Unexpected model request ${index}` } }));
      return;
    }

    const model = String(body.model ?? "fixture-model");
    const base = {
      id: `response-${index}`,
      object: "response",
      created_at: 1000 + index,
      status: "in_progress",
      model,
      output: [],
      output_text: "",
    };
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    writeEvent(response, "response.created", 0, { response: base });

    if ("tool" in turn) {
      const item = {
        id: `function-${index}`,
        type: "function_call",
        call_id: `call-${index}`,
        name: turn.tool.name,
        arguments: JSON.stringify(turn.tool.arguments),
      };
      writeEvent(response, "response.output_item.added", 1, {
        output_index: 0,
        item: { ...item, arguments: "" },
      });
      writeEvent(response, "response.function_call_arguments.delta", 2, {
        item_id: item.id,
        output_index: 0,
        delta: item.arguments,
      });
      writeEvent(response, "response.function_call_arguments.done", 3, {
        item_id: item.id,
        output_index: 0,
        arguments: item.arguments,
      });
      const completed = { ...item, status: "completed" };
      writeEvent(response, "response.output_item.done", 4, {
        output_index: 0,
        item: completed,
      });
      writeEvent(response, "response.completed", 5, {
        response: {
          ...base,
          status: "completed",
          output: [completed],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
    } else {
      const item = {
        id: `message-${index}`,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [] as unknown[],
      };
      writeEvent(response, "response.output_item.added", 1, { output_index: 0, item });
      writeEvent(response, "response.content_part.added", 2, {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      writeEvent(response, "response.output_text.delta", 3, {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: turn.text,
        logprobs: [],
      });
      writeEvent(response, "response.output_text.done", 4, {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: turn.text,
        logprobs: [],
      });
      const completed = {
        ...item,
        status: "completed",
        content: [{ type: "output_text", text: turn.text, annotations: [] }],
      };
      writeEvent(response, "response.output_item.done", 5, {
        output_index: 0,
        item: completed,
      });
      writeEvent(response, "response.completed", 6, {
        response: {
          ...base,
          status: "completed",
          output: [completed],
          output_text: turn.text,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  assert.ok(address.port);

  const previousBase = process.env.OPENAI_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_KEY = "local-pi-protocol-key";
  t.after(async () => {
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests };
}
