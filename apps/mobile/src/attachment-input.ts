import { attachmentLimits as limits } from "../../../packages/domain/src/attachments";

export interface WebAttachment {
  file: File;
  path: string;
}
const ignored = new Set([".git", "node_modules", "__pycache__", ".venv"]);
export function ignoredAttachmentPath(path: string) {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .slice(0, -1)
    .some((part) => ignored.has(part));
}
export function checkUploadFiles(files: { size: number }[], existing: { size: number }[] = []) {
  if (files.length + existing.length > limits.files)
    throw Error("한 메시지에는 파일 200개까지 첨부할 수 있습니다.");
  if (files.some((f) => f.size > limits.fileBytes))
    throw Error("파일 하나는 20MB 이하여야 합니다.");
  if ([...files, ...existing].reduce((n, f) => n + f.size, 0) > limits.batchBytes)
    throw Error("한 메시지의 파일 합계는 100MB 이하여야 합니다.");
}
export function chooseWebAttachments(kind: "image" | "file" | "folder"): Promise<WebAttachment[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("data-testid", `attachment-input-${kind}`);
    if (kind === "folder") input.webkitdirectory = true;
    if (kind === "image") input.accept = "image/png,image/jpeg,image/webp,image/gif";
    input.style.display = "none";
    document.body.appendChild(input);
    const done = (files: File[]) => {
      input.remove();
      resolve(files.map((file) => ({ file, path: file.webkitRelativePath || file.name })));
    };
    input.onchange = () => done(Array.from(input.files ?? []));
    input.oncancel = () => done([]);
    input.click();
  });
}
export async function droppedAttachments(transfer: DataTransfer): Promise<WebAttachment[]> {
  // Capture entries synchronously: the browser clears the transfer after the event returns.
  const entries = Array.from(transfer.items ?? [])
    .filter((i) => i.kind === "file")
    .map((i) => ({ entry: i.webkitGetAsEntry?.(), file: i.getAsFile() }));
  const fallback = Array.from(transfer.files ?? []);
  const result: WebAttachment[] = [];
  let visited = 0;
  async function walk(entry: FileSystemEntry, prefix = "") {
    if (++visited > 4000) throw Error("폴더 항목이 너무 많습니다. 필요한 하위 폴더를 선택하세요.");
    const path = prefix + entry.name;
    if (entry.isDirectory) {
      if (ignored.has(entry.name)) return;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const children = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!children.length) break;
        for (const child of children) await walk(child, `${path}/`);
      }
    } else if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      result.push({ file, path });
      checkUploadFiles(result.map((f) => f.file));
    }
  }
  if (!entries.length)
    return fallback.map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  for (const { entry, file } of entries) {
    if (entry) await walk(entry);
    else if (file) result.push({ file, path: file.name });
  }
  return result;
}
