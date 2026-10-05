import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import { z } from "zod";
import {
  type SkillActivation,
  type SkillInfo,
  skillCommand,
} from "../../../packages/domain/src/skills.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import { type SkillFile, skillMetadata, skillPath, unpackSkills } from "./skill-import.ts";

type Library = { id: string; revision: string; items: SkillInfo[] };
export class Skills {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
  ) {}
  private async library(owner: string): Promise<Library> {
    const library =
      (await this.db.get<Library>(owner, "skills", "library")) ??
      (await this.db.insertIfAbsent(owner, "skills", {
        id: "library",
        revision: randomUUID(),
        items: [],
      })) ??
      (await this.db.get<Library>(owner, "skills", "library"));
    if (!library) throw new AppError("스킬 보관함을 열 수 없습니다.", 503);
    return library;
  }
  async list(owner: string) {
    return (await this.library(owner)).items;
  }
  async get(owner: string, name: string) {
    const skill = (await this.list(owner)).find((s) => s.name === name);
    if (!skill)
      throw new AppError(`스킬 /${name}을 찾을 수 없습니다. 스킬 관리에서 먼저 추가하세요.`, 404);
    return skill;
  }
  private directory(owner: string, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError("잘못된 스킬 ID입니다.", 422);
    const root = resolve(
      this.config.dataDir,
      "skills",
      createHash("sha256").update(owner).digest("hex"),
    );
    const path = resolve(root, id);
    if (relative(root, path) !== id) throw new AppError("잘못된 스킬 경로입니다.", 422);
    return path;
  }
  private async change(owner: string, update: (items: SkillInfo[]) => SkillInfo[]) {
    for (let n = 0; n < 12; n++) {
      const before = await this.library(owner),
        items = update(before.items);
      if (items.length > 128 || items.reduce((sum, s) => sum + s.size, 0) > 256 * 1024 * 1024)
        throw new AppError("스킬은 최대 128개, 합계 256MB까지 보관할 수 있습니다.", 413);
      const saved = await this.db.compareAndSwap<Library>(
        owner,
        "skills",
        "library",
        { revision: before.revision },
        { items, revision: randomUUID() },
      );
      if (saved) return { before: before.items, items: saved.items };
    }
    throw new AppError("다른 스킬 변경이 진행 중입니다. 다시 시도하세요.", 409);
  }
  private async cleanup(owner: string, items: SkillInfo[]) {
    await Promise.all(
      items.map((s) => rm(this.directory(owner, s.id), { recursive: true, force: true })),
    );
  }
  async import(owner: string, uploaded: SkillFile[], replace = false) {
    const files = await unpackSkills(uploaded);
    const roots = files.filter((f) => posix.basename(f.path).toLowerCase() === "skill.md");
    if (!roots.length && files.length === 1 && /\.md$/i.test(files[0].path)) roots.push(files[0]);
    if (!roots.length)
      throw new AppError(
        "SKILL.md를 찾을 수 없습니다. 스킬 파일 또는 SKILL.md가 포함된 폴더·압축파일을 선택하세요.",
        422,
      );
    if (roots.length > 32) throw new AppError("한 번에 최대 32개 스킬을 추가할 수 있습니다.", 413);
    const bundles = roots.map((root) => {
      const base = posix.dirname(root.path),
        prefix = base === "." ? "" : base + "/";
      const own = files.filter(
        (f) =>
          f.path.startsWith(prefix) &&
          !roots.some(
            (other) =>
              other !== root &&
              posix.dirname(other.path).startsWith(prefix) &&
              posix.dirname(other.path) !== base &&
              f.path.startsWith(posix.dirname(other.path) + "/"),
          ),
      );
      const meta = skillMetadata(
        root.bytes,
        base === "." ? posix.basename(root.path).replace(/\.md$/i, "") : posix.basename(base),
      );
      const entries = own.map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
      const info: SkillInfo = {
        id: randomUUID(),
        name: meta.name,
        description: meta.description,
        entryPath: root.path.slice(prefix.length),
        files: entries.map((f) => ({ path: f.path, size: f.bytes.length })),
        size: entries.reduce((sum, f) => sum + f.bytes.length, 0),
        explicitOnly: meta.explicitOnly,
        enabled: true,
        updatedAt: new Date().toISOString(),
      };
      return { info, files: entries };
    });
    const names = new Set(bundles.map((b) => b.info.name));
    if (names.size !== bundles.length)
      throw new AppError("묶음 안에 같은 이름의 스킬이 있습니다.", 409);
    const installed = bundles.map((b) => b.info);
    let committed = false;
    try {
      for (const bundle of bundles) {
        const directory = this.directory(owner, bundle.info.id);
        for (const file of bundle.files) {
          const path = join(directory, skillPath(file.path));
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, file.bytes, { mode: 0o600, flag: "wx" });
        }
      }
      const saved = await this.change(owner, (items) => {
        const conflict = items.filter((s) => names.has(s.name));
        if (conflict.length && !replace)
          throw new AppError(
            `이미 등록된 스킬입니다: ${conflict.map((s) => s.name).join(", ")}. 교체 옵션을 선택하세요.`,
            409,
          );
        return [...items.filter((s) => !names.has(s.name)), ...installed].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      });
      committed = true;
      await this.cleanup(
        owner,
        saved.before.filter((s) => names.has(s.name)),
      ).catch(() => {});
      return installed;
    } finally {
      if (!committed) await this.cleanup(owner, installed).catch(() => {});
    }
  }
  async update(owner: string, name: string, enabled: boolean) {
    const result = await this.change(owner, (items) => {
      if (!items.some((s) => s.name === name)) throw new AppError("스킬을 찾을 수 없습니다.", 404);
      return items.map((s) =>
        s.name === name ? { ...s, enabled, updatedAt: new Date().toISOString() } : s,
      );
    });
    return result.items.find((s) => s.name === name);
  }
  async remove(owner: string, name: string) {
    const result = await this.change(owner, (items) => {
      if (!items.some((s) => s.name === name)) throw new AppError("스킬을 찾을 수 없습니다.", 404);
      return items.filter((s) => s.name !== name);
    });
    await this.cleanup(
      owner,
      result.before.filter((s) => s.name === name),
    );
    return { ok: true };
  }
  async read(
    owner: string,
    name: string,
    path: string,
    revision?: string,
    offset = 0,
    limit = 24000,
  ) {
    const skill = await this.get(owner, name);
    if (!skill.enabled) throw new AppError("비활성화된 스킬입니다.", 409);
    if (revision && skill.id !== revision)
      throw new AppError("스킬이 교체되었습니다. 최신 스킬을 다시 불러오세요.", 409);
    path = skillPath(path);
    if (!skill.files.some((f) => f.path === path))
      throw new AppError("스킬에 해당 파일이 없습니다.", 404);
    const bytes = await readFile(join(this.directory(owner, skill.id), path));
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) throw Error();
    } catch {
      return {
        name,
        revision: skill.id,
        path,
        size: bytes.length,
        encoding: "base64",
        content: bytes.subarray(offset, offset + limit).toString("base64"),
        nextOffset: offset + limit < bytes.length ? offset + limit : null,
      };
    }
    return {
      name,
      revision: skill.id,
      path,
      size: bytes.length,
      encoding: "utf8",
      content: text.slice(offset, offset + limit),
      nextOffset: offset + limit < text.length ? offset + limit : null,
    };
  }
  async activate(owner: string, name: string): Promise<SkillActivation> {
    const info = await this.get(owner, name);
    if (!info.enabled) throw new AppError(`스킬 /${name}은 비활성화되어 있습니다.`, 409);
    return this.inspect(owner, info);
  }
  async inspect(owner: string, info: SkillInfo): Promise<SkillActivation> {
    const bytes = await readFile(join(this.directory(owner, info.id), info.entryPath));
    return {
      id: info.id,
      name: info.name,
      description: info.description,
      entryPath: info.entryPath,
      instructions: skillMetadata(bytes, info.name).instructions,
    };
  }
  async invocation(owner: string, text: string) {
    const command = skillCommand(text);
    return command ? this.activate(owner, command.name) : undefined;
  }
  async piResources(owner: string): Promise<Skill[]> {
    return (await this.list(owner))
      .filter((s) => s.enabled)
      .map((s) => {
        const baseDir = this.directory(owner, s.id),
          filePath = join(baseDir, s.entryPath);
        return {
          name: s.name,
          description: s.description,
          filePath,
          baseDir,
          disableModelInvocation: s.explicitOnly,
          sourceInfo: {
            path: filePath,
            source: "OpenMuse",
            scope: "user",
            origin: "top-level",
            baseDir,
          },
        };
      });
  }
}

export function skillRoutes(skills: Skills) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json({ skills: await skills.list(c.get("owner")) }));
  app.post("/import", async (c) => {
    const form = await c.req.formData(),
      files = form.getAll("files");
    const paths = z
      .array(z.string().max(240))
      .max(512)
      .optional()
      .parse(form.get("paths") ? JSON.parse(String(form.get("paths"))) : undefined);
    if (paths && paths.length !== files.length)
      throw new AppError("파일 경로 목록이 올바르지 않습니다.", 422);
    const uploaded: SkillFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!(file instanceof File)) throw new AppError("스킬 파일을 선택하세요.", 422);
      uploaded.push({
        path: paths?.[i] ?? file.name,
        bytes: Buffer.from(await file.arrayBuffer()),
      });
    }
    return c.json(
      { skills: await skills.import(c.get("owner"), uploaded, form.get("replace") === "true") },
      201,
    );
  });
  app.get("/:name", async (c) => {
    const skill = await skills.get(c.get("owner"), c.req.param("name"));
    return c.json({ skill, ...(await skills.inspect(c.get("owner"), skill)) });
  });
  app.patch("/:name", async (c) =>
    c.json(
      await skills.update(
        c.get("owner"),
        c.req.param("name"),
        z.object({ enabled: z.boolean() }).parse(await c.req.json()).enabled,
      ),
    ),
  );
  app.delete("/:name", async (c) =>
    c.json(await skills.remove(c.get("owner"), c.req.param("name"))),
  );
  return app;
}
