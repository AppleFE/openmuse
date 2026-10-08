import { z } from "zod";
import { WorkerError } from "./errors.ts";

const tab = { tab_id: z.string().min(1).max(100).optional() };
const point = z.object({
  type: z.literal("coordinate"),
  x: z.number().int().min(0).max(1279),
  y: z.number().int().min(0).max(799),
});
const ref = z.object({ type: z.literal("ref"), ref: z.string().regex(/^r[0-9]+-[0-9]+$/) });
const target = z.discriminatedUnion("type", [point, ref]);
const direction = z.enum(["up", "down", "left", "right"]);
export const browserActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), ...tab, url: z.string().min(1).max(4096) }),
  z.object({ action: z.literal("screenshot"), ...tab }),
  z.object({ action: z.literal("read_page"), ...tab }),
  z.object({ action: z.literal("get_page_text"), ...tab }),
  z.object({ action: z.literal("find"), ...tab, query: z.string().min(1).max(300) }),
  z.object({
    action: z.literal("form_input"),
    ...tab,
    target: ref,
    value: z.union([z.string().max(10000), z.boolean()]),
  }),
  z.object({ action: z.literal("scroll_to"), ...tab, target: ref }),
  ...(["left_click", "right_click", "double_click", "hover", "mouse_move"] as const).map((action) =>
    z.object({ action: z.literal(action), ...tab, target }),
  ),
  z.object({ action: z.literal("type"), ...tab, text: z.string().max(10000) }),
  z.object({
    action: z.literal("key"),
    ...tab,
    text: z.string().min(1).max(100),
    repeat: z.number().int().min(1).max(10).optional(),
  }),
  z.object({
    action: z.literal("scroll"),
    ...tab,
    target: point,
    scroll_direction: direction,
    scroll_amount: z.number().int().min(1).max(10).optional(),
  }),
  z.object({ action: z.literal("wait"), ...tab, duration: z.number().min(0).max(3) }),
  z.object({ action: z.literal("new_tab") }),
  z.object({ action: z.literal("list_tabs") }),
  z.object({ action: z.literal("switch_tab"), tab_id: z.string().min(1).max(100) }),
  z.object({ action: z.literal("close_tab"), tab_id: z.string().min(1).max(100) }),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;
export const browserBatchSchema = z.object({
  sessionId: z.uuid(),
  actions: z.array(browserActionSchema).min(1).max(8),
});
export const observationActions = new Set([
  "screenshot",
  "read_page",
  "get_page_text",
  "find",
  "list_tabs",
  "wait",
  "cursor_position",
  "zoom",
]);
const coordinate = z.tuple([z.number().int().min(0).max(1279), z.number().int().min(0).max(799)]);
export const desktopActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("screenshot") }),
  z.object({ action: z.literal("cursor_position") }),
  ...(
    [
      "left_click",
      "right_click",
      "middle_click",
      "double_click",
      "triple_click",
      "mouse_move",
    ] as const
  ).map((action) => z.object({ action: z.literal(action), coordinate })),
  z.object({ action: z.literal("left_click_drag"), start_coordinate: coordinate, coordinate }),
  z.object({ action: z.literal("type"), text: z.string().max(10000) }),
  z.object({
    action: z.literal("key"),
    text: z.string().min(1).max(100),
    repeat: z.number().int().min(1).max(10).optional(),
  }),
  z.object({
    action: z.literal("scroll"),
    scroll_direction: direction,
    scroll_amount: z.number().int().min(1).max(10),
    coordinate: coordinate.optional(),
  }),
  z.object({ action: z.literal("wait"), duration: z.number().min(0).max(3) }),
  z.object({
    action: z.literal("zoom"),
    region: z
      .tuple([
        z.number().int().min(0).max(1279),
        z.number().int().min(0).max(799),
        z.number().int().min(1).max(1280),
        z.number().int().min(1).max(800),
      ])
      .refine(([left, top, right, bottom]) => right > left && bottom > top, {
        message:
          "zoom.region must be [left, top, right, bottom], not [x, y, width, height]. right must exceed left; bottom must exceed top. Example: [320, 220, 960, 285] covers a 640 by 65 area.",
      })
      .describe(
        "[left, top, right, bottom] in the original 1280x800 screenshot, NOT x/y/width/height. right > left, bottom > top. Exclude black bars. Click coordinates still use the original full screenshot, not the zoomed image.",
      ),
  }),
]);
export type DesktopAction = z.infer<typeof desktopActionSchema>;
export const desktopBatchSchema = z.object({
  sessionId: z.uuid(),
  actions: z.array(desktopActionSchema).min(1).max(8),
});

export function playwrightKey(text: string) {
  const aliases: Record<string, string> = {
    ctrl: "Control",
    control: "Control",
    cmd: "Meta",
    command: "Meta",
    win: "Meta",
    windows: "Meta",
    super: "Meta",
    meta: "Meta",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
    return: "Enter",
    enter: "Enter",
    esc: "Escape",
    escape: "Escape",
    space: "Space",
    backspace: "Backspace",
    delete: "Delete",
    tab: "Tab",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
  };
  const keys = text.split("+");
  if (keys.length > 5)
    throw new WorkerError("INVALID_KEY", "키 조합은 최대 5개 키까지 지원합니다.", 422);
  return keys
    .map((key) => {
      key = key.trim();
      const value = aliases[key.toLowerCase()] ?? (/^f\d+$/i.test(key) ? key.toUpperCase() : key);
      if (
        !/^(Control|Meta|Alt|Shift|Enter|Escape|Space|Backspace|Delete|Tab|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|F([1-9]|1[0-2])|[a-zA-Z0-9])$/.test(
          value,
        )
      )
        throw new WorkerError(
          "INVALID_KEY",
          "지원하지 않는 키입니다. Windows 키는 Win, Windows, Super 또는 Meta를 사용하세요.",
          422,
        );
      return value;
    })
    .join("+");
}
