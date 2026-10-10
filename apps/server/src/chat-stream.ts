/** Keep idle model streams alive through browsers and HTTP proxies. Comments
 * are transport-only: they don't enter AG-UI history or its event quota. */
export function chatStreamResponse(response: Response, heartbeatMs = 15_000) {
  if (!response.body) return response;
  const sse = response.headers.get("content-type")?.includes("text/event-stream");
  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let lastChunk = Date.now();
  const cleanup = () => {
    closed = true;
    clearInterval(timer);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!sse) return;
      timer = setInterval(() => {
        if (!closed && Date.now() - lastChunk >= heartbeatMs && (controller.desiredSize ?? 0) > 0) {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
          lastChunk = Date.now();
        }
      }, heartbeatMs);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) {
          cleanup();
          controller.close();
        } else {
          lastChunk = Date.now();
          // CopilotKit 1.70 emits strings, but a Response needs byte chunks.
          controller.enqueue(typeof value === "string" ? encoder.encode(value) : value);
        }
      } catch (error) {
        if (!closed) controller.error(error);
        cleanup();
      }
    },
    async cancel(reason) {
      cleanup();
      await reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  if (sse) {
    headers.set("Cache-Control", "no-cache, no-transform");
    headers.set("X-Accel-Buffering", "no");
  }
  return new Response(body, { status: response.status, headers });
}
