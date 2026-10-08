import {
  BetaAbstractComputerToolset20260801,
  type BetaToolsetCallContext,
} from "@anthropic-ai/sdk/helpers/beta/toolsets";
import { imageSize } from "image-size";
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
) =>
  runToolsetBatch(new OpenMuseComputerToolset(backend), actions, signal, (raw, image) => {
    const action = desktopActionSchema.parse(raw);
    const { width, height } = imageSize(Buffer.from(image.data, "base64"));
    if (action.action === "zoom") {
      const [left, top, right, bottom] = action.region;
    return `ZOOM OBSERVATION: this image is ${width}x${height} pixels and shows original screen region [${left}, ${top}, ${right}, ${bottom}]. Its top-left is NOT screen (0, 0). To click image pixel (u, v), use full-screen coordinate [round(${left} + u * ${right - left} / ${width}), round(${top} + v * ${bottom - top} / ${height})]. Never send cropped image coordinates directly. If text is still too small, zoom a narrower original-screen region. Before clicking, identify the target in this image and convert its position. If a click fails or changes nothing, take a fresh screenshot and try browser tab search/keyboard navigation instead of stopping. ${browserTargetVerification}`;
    }
  return `FULL SCREEN OBSERVATION: ${width}x${height} pixels. Mouse coordinates and zoom regions use this full image, including black margins. The zoom region format is [left, top, right, bottom]. For a wide desktop, zoom just the relevant window, menu or text; exclude black margins. In Chrome, focus the correct window, press Ctrl+Shift+A (Cmd+Shift+A on Mac), then screenshot and zoom the tab-search popup to read results. Do not toggle the shortcut again without inspecting the popup. Do not ask the user to select a visible tab until you have tried tab search and inspected the result. ${browserTargetVerification}`;
});

const browserTargetVerification =
  "A tab-search result is NOT the active page. Select the matching result (click its row, or ArrowDown then Enter), wait and take a fresh screenshot. Verify the active address bar and page heading before reporting page data. Never combine a domain from a search popup with figures or text from the page behind it. If the requested section is not yet visible, inspect the matching page's navigation or scroll before concluding the data is absent.";
