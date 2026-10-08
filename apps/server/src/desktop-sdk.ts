import {
  BetaAbstractComputerToolset20260801,
  type BetaToolsetCallContext,
} from "@anthropic-ai/sdk/helpers/beta/toolsets";
import { type DesktopAction, desktopActionSchema } from "../../worker/src/automation-schema.ts";
import { runToolsetBatch } from "./browser-sdk.ts";

const members = [
  "screenshot",
  "zoom",
  "cursor_position",
  "mouse_move",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_click_drag",
  "type",
  "key",
  "scroll",
  "wait",
];
export interface DesktopSDKBackend {
  action(input: DesktopAction): Promise<unknown>;
  confirm(input: DesktopAction): Promise<boolean>;
}
export class OpenMuseComputerToolset extends BetaAbstractComputerToolset20260801 {
  constructor(private backend: DesktopSDKBackend) {
    super({
      configs: Object.fromEntries(
        [...members, "hold_key", "left_mouse_down", "left_mouse_up"].map((name) => [
          name,
          { enabled: members.includes(name) },
        ]),
      ),
      confirm: (ctx) =>
        backend.confirm(desktopActionSchema.parse({ action: ctx.member, ...ctx.input })),
    });
  }
  protected override async execute(
    _ctx: BetaToolsetCallContext,
    name: Parameters<BetaAbstractComputerToolset20260801["run"]>[1]["name"],
    input: Parameters<BetaAbstractComputerToolset20260801["execute"]>[2],
  ) {
    return (await this.backend.action(
      desktopActionSchema.parse({ action: name, ...input }),
    )) as Awaited<ReturnType<BetaAbstractComputerToolset20260801["execute"]>>;
  }
}
export const runDesktopBatch = (
  backend: DesktopSDKBackend,
  actions: DesktopAction[],
  signal?: AbortSignal,
) => runToolsetBatch(new OpenMuseComputerToolset(backend), actions, signal);
