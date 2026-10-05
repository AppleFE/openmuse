import { gunzipSync } from "node:zlib";
import { Parser } from "tar";
import { parseDocument } from "yaml";
import { type Entry, fromBuffer } from "yauzl";
import { AppError } from "./errors.ts";

export type SkillFile = { path: string; bytes: Buffer };
export const skillLimits = {
  upload: 10 * 1024 * 1024,
  total: 20 * 1024 * 1024,
  file: 2 * 1024 * 1024,
  count: 512,
};

export function skillPath(value: string) {
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
  if (
    !path ||
    path.length > 240 ||
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    /[:*?"<>|]/.test(path) ||
    path.startsWith("/") ||
    path
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    throw new AppError("스킬에 허용되지 않는 파일 경로가 있습니다.", 422);
  return path;
}

function collector() {
  const files: SkillFile[] = [],
    paths = new Set<string>();
  let size = 0;
  return {
    files,
    add(path: string, bytes: Buffer) {
      path = skillPath(path);
      if (
        path.split("/").some((p) => ["__MACOSX", ".DS_Store", ".git", "node_modules"].includes(p))
      )
        return;
      const key = path.toLowerCase();
      if ([...paths].some((p) => p === key || p.startsWith(key + "/") || key.startsWith(p + "/")))
        throw new AppError("중복되거나 파일과 폴더가 충돌하는 스킬 경로입니다.", 422);
      paths.add(path.toLowerCase());
      size += bytes.length;
      if (
        bytes.length > skillLimits.file ||
        size > skillLimits.total ||
        files.length >= skillLimits.count
      )
        throw new AppError(
          "스킬은 파일당 2MB, 압축 해제 후 20MB, 512개 파일 이하여야 합니다.",
          413,
        );
      files.push({ path, bytes });
    },
  };
}

async function unzip(bytes: Buffer, add: (path: string, bytes: Buffer) => void) {
  await new Promise<void>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let entries = 0,
        stopped = false;
      const fail = (e: unknown) => {
        if (stopped) return;
        stopped = true;
        zip.close();
        reject(e);
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (!stopped) resolve();
      });
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          if (++entries > 1024) throw new AppError("압축파일 항목이 너무 많습니다.", 413);
          skillPath(entry.fileName.replace(/\/$/, ""));
          const type = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (entry.generalPurposeBitFlag & 1 || ![0, 0x8000, 0x4000].includes(type))
            throw new AppError("암호화 파일과 심볼릭 링크는 스킬로 가져올 수 없습니다.", 422);
          if (entry.fileName.endsWith("/")) {
            zip.readEntry();
            return;
          }
          if (entry.uncompressedSize > skillLimits.file)
            throw new AppError("스킬 파일은 2MB 이하여야 합니다.", 413);
          const stream = await new Promise<import("node:stream").Readable>((yes, no) =>
            zip.openReadStream(entry, (e, s) => (e ? no(e) : yes(s))),
          );
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of stream) {
            size += chunk.length;
            if (size > skillLimits.file) {
              stream.destroy();
              throw new AppError("스킬 파일은 2MB 이하여야 합니다.", 413);
            }
            chunks.push(chunk);
          }
          add(entry.fileName, Buffer.concat(chunks));
          if (!stopped) zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}

export async function unpackSkills(input: SkillFile[]) {
  if (
    !input.length ||
    input.length > skillLimits.count ||
    input.reduce((n, f) => n + f.bytes.length, 0) > skillLimits.upload
  )
    throw new AppError("업로드할 스킬을 선택하세요. 업로드는 합계 10MB까지 가능합니다.", 413);
  const result = collector();
  for (const file of input) {
    try {
      const topLevel = !file.path.replace(/\\/g, "/").includes("/");
      if (topLevel && /\.(zip|skill)$/i.test(file.path)) await unzip(file.bytes, result.add);
      else if (topLevel && /\.(tar|tar\.gz|tgz)$/i.test(file.path)) {
        const bytes = /\.(gz|tgz)$/i.test(file.path)
          ? gunzipSync(file.bytes, { maxOutputLength: 24 * 1024 * 1024 })
          : file.bytes;
        if (bytes.length > 24 * 1024 * 1024)
          throw new AppError("압축 해제된 스킬이 너무 큽니다.", 413);
        await new Promise<void>((resolve, reject) => {
          let count = 0;
          const parser = new Parser({
            strict: true,
            onReadEntry(entry) {
              try {
                if (++count > 1024) throw new AppError("압축파일 항목이 너무 많습니다.", 413);
                const path = entry.path.replace(/\/$/, "");
                if (path === "." && entry.type === "Directory") {
                  entry.resume();
                  return;
                }
                skillPath(path);
                if (entry.type === "Directory") {
                  entry.resume();
                  return;
                }
                if (entry.type !== "File" || entry.size > skillLimits.file)
                  throw new AppError("일반 파일만 지원하며 파일당 최대 2MB입니다.", 422);
                const chunks: Buffer[] = [];
                entry.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                entry.on("end", () => {
                  try {
                    result.add(path, Buffer.concat(chunks));
                  } catch (e) {
                    parser.abort(e as Error);
                  }
                });
                entry.on("error", reject);
              } catch (e) {
                parser.abort(e as Error);
              }
            },
          });
          parser.on("error", reject);
          parser.on("end", resolve);
          parser.end(bytes);
        });
      } else result.add(file.path, file.bytes);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "스킬 압축파일을 읽을 수 없습니다. ZIP·TAR·TAR.GZ 형식을 확인하세요.",
        422,
      );
    }
  }
  return result.files;
}

export function skillMetadata(bytes: Buffer, fallback: string) {
  if (bytes.length > 64 * 1024) throw new AppError("스킬 지침은 64KB 이하여야 합니다.", 413);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new AppError("스킬 지침은 UTF-8 Markdown 파일이어야 합니다.", 422);
  }
  if (text.includes("\0")) throw new AppError("스킬 지침에 바이너리 데이터가 있습니다.", 422);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  let meta: Record<string, unknown> = {};
  if (match) {
    try {
      const doc = parseDocument(match[1], { uniqueKeys: true });
      if (doc.errors.length) throw doc.errors[0];
      const value = doc.toJS({ maxAliasCount: 20 });
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
      meta = value;
    } catch {
      throw new AppError("SKILL.md의 YAML 메타데이터를 확인하세요.", 422);
    }
    text = text.slice(match[0].length);
  } else if (text.startsWith("---\n") || text.startsWith("---\r\n"))
    throw new AppError("스킬 메타데이터의 닫는 --- 줄이 없습니다.", 422);
  const name =
    meta.name ??
    fallback
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw new AppError("스킬 name은 영문 소문자·숫자·하이픈으로 1~64자여야 합니다.", 422);
  const description =
    meta.description ??
    text
      .trim()
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.replace(/^#+\s*/, "") ??
    name;
  if (
    typeof description !== "string" ||
    !description.trim() ||
    description.length > 1024 ||
    !text.trim()
  )
    throw new AppError("스킬 설명과 본문을 확인하세요. 설명은 최대 1,024자입니다.", 422);
  return {
    name,
    description: description.trim(),
    instructions: text.trim(),
    explicitOnly: meta["disable-model-invocation"] === true,
  };
}
