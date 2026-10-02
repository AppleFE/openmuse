import { z } from "zod";

const repo = z
  .string()
  .max(512)
  .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Use a repository reference like owner/name")
  .refine((v) => v.split("/").every((part) => ![".", ".."].includes(part)));
const path = z
  .string()
  .max(4096)
  .refine(
    (v) =>
      !v.startsWith("/") &&
      !v.includes("\\") &&
      !v.includes("\0") &&
      !/[\r\n]/.test(v) &&
      (v === "" || v.split("/").every((part) => part && ![".", ".."].includes(part))),
    "Use a relative repository path without traversal",
  );
const ref = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (v) => ![".", ".."].includes(v) && !v.includes("\0") && !/[\r\n\\]/.test(v),
    "Use a branch, tag or commit SHA",
  );
const page = {
  limit: z.number().int().min(1).max(100).default(30),
  page: z.number().int().min(1).max(10000).default(1),
};
const slice = {
  offset: z.number().int().min(0).max(1000000).default(0),
  limit: z.number().int().min(1).max(1000).default(200),
};
const issues = z.strictObject({
  repo,
  state: z.enum(["open", "closed", "all"]).default("open"),
  ...page,
});

export const githubReadParams = {
  repos: z.strictObject({ ...page, limit: page.limit.default(100) }),
  issues,
  pulls: issues,
  repo: z.strictObject({ repo }),
  branches: z.strictObject({ repo, ...page }),
  contents: z.strictObject({ repo, path: path.default(""), ref: ref.optional(), ...slice }),
  tree: z.strictObject({
    repo,
    ref: ref.default("HEAD"),
    recursive: z.boolean().default(false),
    path: path.optional(),
    ...slice,
  }),
  file: z.strictObject({
    repo,
    path: path.refine((v) => v.length > 0, "Supply a file path"),
    ref: ref.optional(),
    offset: z.number().int().min(0).max(1048576).default(0),
    limit: z.number().int().min(1).max(40000).default(20000),
  }),
  commits: z.strictObject({ repo, ref: ref.optional(), path: path.optional(), ...page }),
};
export const githubReadOperations = Object.keys(
  githubReadParams,
) as (keyof typeof githubReadParams)[];
export const githubOperationLabels: Record<string, string> = {
  repos: "저장소 목록",
  issues: "이슈 목록",
  pulls: "풀 리퀘스트 목록",
  repo: "저장소 정보",
  branches: "브랜치 목록",
  contents: "폴더 내용",
  tree: "파일 트리",
  file: "파일 내용",
  commits: "커밋 기록",
};
