import { randomUUID } from "node:crypto";
import {
  BetaAbstractBrowserToolset20260801,
  type BetaBrowserState,
  type BetaToolsetCallContext,
  ToolError,
} from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type {
  BetaBrowserMemberInput,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta";
import { type BrowserAction, browserActionSchema } from "../../worker/src/automation-schema.ts";
import type { AutomationResult } from "./automation-result.ts";

const members = [
  "navigate",
  "screenshot",
  "read_page",
  "get_page_text",
  "find",
  "form_input",
  "scroll_to",
  "left_click",
  "right_click",
  "double_click",
  "hover",
  "mouse_move",
  "type",
  "key",
  "scroll",
  "wait",
  "new_tab",
  "list_tabs",
  "switch_tab",
  "close_tab",
] as const;
export interface BrowserSDKBackend {
  action(input: BrowserAction): Promise<unknown>;
  state(): Promise<BetaBrowserState>;
  confirm(action: BrowserAction): Promise<boolean>;
}
/** SDK execution and policy pipeline only; model transport remains OpenMuse/Pi. */
export class OpenMuseBrowserToolset extends BetaAbstractBrowserToolset20260801 {
  constructor(private backend: BrowserSDKBackend) {
    super({
      configs: Object.fromEntries(
        [
          "navigate",
          "screenshot",
          "zoom",
          "left_click",
          "right_click",
          "middle_click",
          "double_click",
          "triple_click",
          "hover",
          "left_click_drag",
          "left_mouse_down",
          "left_mouse_up",
          "mouse_move",
          "scroll",
          "scroll_to",
          "type",
          "key",
          "hold_key",
          "wait",
          "read_page",
          "get_page_text",
          "find",
          "form_input",
          "file_upload",
          "read_console",
          "read_network",
          "javascript_exec",
          "new_tab",
          "list_tabs",
          "switch_tab",
          "close_tab",
        ].map((name) => [name, { enabled: (members as readonly string[]).includes(name) }]),
      ),
      browserState: () => backend.state(),
      urlPolicy: (_context, url) => {
        const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
        if (
          (!["http:", "https:"].includes(parsed.protocol) && url !== "about:blank") ||
          parsed.username ||
          parsed.password
        )
          throw new ToolError("Only HTTP(S) URLs and about:blank are supported.");
        // The worker revalidates DNS and enforces egress for requests/redirects.
      },
      confirm: (ctx) =>
        backend.confirm(browserActionSchema.parse({ action: ctx.member, ...ctx.input })),
    });
  }
  protected override async execute(
    _ctx: BetaToolsetCallContext,
    name: Parameters<BetaAbstractBrowserToolset20260801["run"]>[1]["name"],
    input: BetaBrowserMemberInput,
  ) {
    const parsed = browserActionSchema.parse({ action: name, ...input });
    const value = await this.backend.action(parsed);
    if (["new_tab", "switch_tab"].includes(name))
      return (await this.backend.state()).tabs.find((t) => t.active);
    if (name === "list_tabs") return (await this.backend.state()).tabs;
    return value as Awaited<ReturnType<BetaAbstractBrowserToolset20260801["execute"]>>;
  }
}
export async function runBrowserBatch(
  backend: BrowserSDKBackend,
  actions: BrowserAction[],
  signal?: AbortSignal,
): Promise<AutomationResult> {
  return runToolsetBatch(new OpenMuseBrowserToolset(backend), actions, signal);
}
export async function runToolsetBatch(
  toolset: {
    toolsetName: string;
    toolResult(input: BetaToolUseBlock): Promise<BetaToolResultBlockParam>;
    close(): Promise<void>;
  },
  actions: ({ action: string } & Record<string, unknown>)[],
  signal?: AbortSignal,
): Promise<AutomationResult> {
  const content: AutomationResult["content"] = [];
  let failed = false;
  try {
    for (const action of actions) {
      signal?.throwIfAborted();
      if (failed) {
        content.push({
          type: "text",
          text: `${action.action}: Not executed: an earlier action in this turn failed.`,
        });
        continue;
      }
      const { action: name, ...input } = action;
      const result = await toolset.toolResult({
        type: "tool_use",
        id: randomUUID(),
        toolset_name: toolset.toolsetName,
        name,
        input,
      });
      failed = !!result.is_error;
      for (const block of typeof result.content === "string"
        ? [{ type: "text", text: result.content }]
        : (result.content ?? [])) {
        if (block.type === "image" && "source" in block && block.source.type === "base64")
          content.push({
            type: "image",
            data: block.source.data,
            mimeType: block.source.media_type === "image/jpeg" ? "image/jpeg" : "image/png",
          });
        else if (block.type === "text" && "text" in block)
          content.push({ type: "text", text: block.text.slice(0, 64000) });
        else content.push({ type: "text", text: JSON.stringify(block).slice(0, 64000) });
      }
    }
    return { type: "openmuse.automation-result", content, isError: failed };
  } finally {
    await toolset.close();
  }
}
