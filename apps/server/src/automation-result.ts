import { z } from "zod";

/** Explicit envelope: arbitrary connector JSON is never interpreted as images. */
export const automationResultSchema = z.object({
  type: z.literal("openmuse.automation-result"),
  content: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string().max(64000) }),
        z.object({
          type: z.literal("image"),
          data: z.string().max(8 * 1024 * 1024),
          mimeType: z.enum(["image/png", "image/jpeg"]),
        }),
      ]),
    )
    .max(24),
  isError: z.boolean(),
});
export type AutomationResult = z.infer<typeof automationResultSchema>;

/** Images stay in Pi model history; app activity and review lists use small receipts. */
export function automationReceipt(value: string): string {
  try {
    const parsed = automationResultSchema.safeParse(JSON.parse(value));
    if (parsed.success)
      return JSON.stringify({
        ...parsed.data,
        content: parsed.data.content.map((block) =>
          block.type === "image"
            ? {
                type: "text",
                text: "[화면 캡처 완료. 현재 화면이 필요하면 screenshot을 다시 호출하세요.]",
              }
            : block,
        ),
      });
  } catch {
    /* Preserve non-automation execution errors/results. */
  }
  return value;
}
