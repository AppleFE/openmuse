/** AG-UI 0.0.59 reports read() failures, then its unsubscribe cleanup calls
 * cancel() and rethrows that same stream error as an unhandled rejection.
 * Limit the workaround to readers owned by this chat transport. The original
 * read/fetch failure still reaches runConversationTurn and recovery. */
export function conversationFetch(fetcher: typeof fetch): typeof fetch {
  return async (...args) => {
    const response = await fetcher(...args);
    const body = response.body;
    if (!body || !response.headers.get("content-type")?.includes("text/event-stream"))
      return response;
    const getReader = body.getReader.bind(body);
    Object.defineProperty(body, "getReader", {
      configurable: true,
      value: (options?: ReadableStreamGetReaderOptions) => {
        const reader = options?.mode === "byob" ? getReader({ mode: "byob" }) : getReader();
        const cancel = reader.cancel.bind(reader);
        reader.cancel = (reason) => cancel(reason).catch(() => {});
        return reader;
      },
    });
    return response;
  };
}
