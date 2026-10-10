type RunError = { error: unknown; context?: { agentId?: string; source?: string } };

export class ServerRunError extends Error {}

/** Fetch uses different messages on Safari, Chromium, and React Native. A
 * provider's RUN_ERROR must never be mistaken for a broken client connection. */
export function isConversationConnectionError(error: unknown) {
  return (
    error instanceof Error &&
    !(error instanceof ServerRunError) &&
    /^(Load failed|Failed to fetch|fetch failed|Network request failed|NetworkError when attempting to fetch resource\.?|network error|terminated)$/i.test(
      error.message,
    )
  );
}

export type ConversationRunStatus = {
  status: "running" | "completed" | "stopped" | "failed" | "interrupted";
  error?: string;
};

/** Only read/attach to the existing run. Never resubmit the message or tools. */
export async function recoverConversationRun(options: {
  connect: () => Promise<unknown>;
  status: () => Promise<ConversationRunStatus>;
  signal: AbortSignal;
  wait?: (ms: number) => Promise<void>;
}) {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let failure: unknown = new TypeError("Load failed");
  for (let attempt = 0; attempt < 3; attempt++) {
    options.signal.throwIfAborted();
    try {
      const before = await options.status();
      options.signal.throwIfAborted();
      await options.connect();
      options.signal.throwIfAborted();
      const after = before.status === "running" ? await options.status() : before;
      if (after.status === "failed" || after.status === "interrupted")
        throw new ServerRunError(after.error || "답변 생성이 중단되었습니다.");
      if (after.status !== "running") return;
    } catch (error) {
      if (!isConversationConnectionError(error)) throw error;
      failure = error;
    }
    if (attempt < 2) await wait(500 * 2 ** attempt);
  }
  throw failure;
}

/** CopilotKit emits run failures through onError even when runAgent resolves. */
export async function runConversationTurn(
  agentId: string,
  execute: () => Promise<unknown>,
  subscribe: (listener: (event: RunError) => void) => { unsubscribe: () => void },
) {
  let failure: Error | undefined;
  const subscription = subscribe((event) => {
    if (event.context?.agentId && event.context.agentId !== agentId) return;
    const error = event.error instanceof Error ? event.error : new Error(String(event.error));
    // Preserve the first server failure even if the SDK emits a generic error later.
    if (event.context?.source === "onRunErrorEvent") failure = new ServerRunError(error.message);
    else if (!(failure instanceof ServerRunError)) failure = error;
  });
  try {
    await execute();
    if (failure) throw failure;
  } finally {
    subscription.unsubscribe();
  }
}
