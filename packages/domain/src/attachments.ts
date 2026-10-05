export const attachmentLimits = {
  files: 200,
  fileBytes: 20 * 1024 * 1024,
  batchBytes: 100 * 1024 * 1024,
  images: 6,
  imageBytes: 20 * 1024 * 1024,
};
export interface ChatAttachment {
  id: string;
  threadId: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  kind: "image" | "text" | "pdf" | "binary";
  createdAt: string;
  url?: string;
  width?: number;
  height?: number;
}
export type AttachmentContent =
  | { type: "text"; text: string }
  | { type: "binary"; id: string; mimeType: string; filename: string };
export function attachmentMessage(
  text: string,
  files: ChatAttachment[],
): string | AttachmentContent[] {
  return files.length
    ? [
        { type: "text", text: text || "첨부한 파일을 확인해 주세요." },
        ...files.map((f) => ({
          type: "binary" as const,
          id: f.id,
          mimeType: f.mimeType,
          filename: f.path,
        })),
      ]
    : text;
}
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}
export function attachmentIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p?.type === "binary" && typeof p.id === "string").map((p) => p.id);
}
