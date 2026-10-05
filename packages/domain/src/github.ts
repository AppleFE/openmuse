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
  issue: z.strictObject({ repo, number: z.number().int().positive() }),
  pull: z.strictObject({ repo, number: z.number().int().positive() }),
  comments: z.strictObject({ repo, number: z.number().int().positive(), ...page }),
  releases: z.strictObject({ repo, ...page }),
};
const text = z.string().max(20000);
const title = z.string().min(1).max(256);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const branch = ref.refine(
  (v) => !/[ ~^:?*[]/.test(v) && !v.includes("..") && !v.endsWith("/") && !v.startsWith("/"),
);
const issueFields = {
  title: title.optional(),
  body: text.optional(),
  state: z.enum(["open", "closed"]).optional(),
  labels: z.array(z.string().min(1).max(100)).max(30).optional(),
  assignees: z.array(z.string().min(1).max(100)).max(10).optional(),
};
export const githubWriteParams = {
  repo_update: z.strictObject({
    repo,
    settings: z
      .strictObject({
        private: z.boolean().optional(),
        visibility: z.enum(["public", "private"]).optional(),
        description: text.nullable().optional(),
        homepage: z.string().max(2048).nullable().optional(),
        default_branch: branch.optional(),
        archived: z.boolean().optional(),
        has_issues: z.boolean().optional(),
        has_wiki: z.boolean().optional(),
        allow_squash_merge: z.boolean().optional(),
        allow_merge_commit: z.boolean().optional(),
        allow_rebase_merge: z.boolean().optional(),
        delete_branch_on_merge: z.boolean().optional(),
      })
      .refine((v) => Object.keys(v).length > 0)
      .refine(
        (v) =>
          v.private === undefined ||
          v.visibility === undefined ||
          v.private === (v.visibility === "private"),
        "private and visibility must agree",
      ),
  }),
  branch_create: z.strictObject({ repo, branch, sha }),
  branch_delete: z.strictObject({ repo, branch }),
  file_put: z.strictObject({
    repo,
    path: path.min(1),
    branch,
    message: title,
    content: z.string().max(30000),
    sha: sha.optional(),
  }),
  file_delete: z.strictObject({ repo, path: path.min(1), branch, message: title, sha }),
  commit_files: z
    .strictObject({
      repo,
      branch,
      expectedHeadSha: sha,
      message: title,
      files: z
        .array(
          z
            .strictObject({
              path: path.min(1),
              content: z.string().max(30000).optional(),
              delete: z.boolean().default(false),
            })
            .refine((v) => (v.delete ? v.content === undefined : v.content !== undefined)),
        )
        .min(1)
        .max(100),
    })
    .refine(
      (v) =>
        new Set(v.files.map((f) => f.path)).size === v.files.length &&
        JSON.stringify(v.files).length < 48000,
    ),
  issue_create: z.strictObject({
    repo,
    title,
    body: text.optional(),
    labels: issueFields.labels,
    assignees: issueFields.assignees,
  }),
  issue_update: z.strictObject({ repo, number: z.number().int().positive(), ...issueFields }),
  issue_comment: z.strictObject({ repo, number: z.number().int().positive(), body: text.min(1) }),
  pull_create: z.strictObject({
    repo,
    title,
    head: ref,
    base: branch,
    body: text.optional(),
    draft: z.boolean().default(false),
  }),
  pull_update: z.strictObject({
    repo,
    number: z.number().int().positive(),
    title: title.optional(),
    body: text.optional(),
    state: z.enum(["open", "closed"]).optional(),
    base: branch.optional(),
  }),
  pull_merge: z.strictObject({
    repo,
    number: z.number().int().positive(),
    sha,
    merge_method: z.enum(["merge", "squash", "rebase"]).default("squash"),
    commit_title: title.optional(),
    commit_message: text.optional(),
  }),
  release_create: z.strictObject({
    repo,
    tag_name: ref,
    target_commitish: ref.optional(),
    name: title.optional(),
    body: text.optional(),
    draft: z.boolean().default(false),
    prerelease: z.boolean().default(false),
    generate_release_notes: z.boolean().default(false),
  }),
  workflow_dispatch: z.strictObject({
    repo,
    workflow: z.string().regex(/^[a-zA-Z0-9_.-]{1,256}$/),
    ref,
    inputs: z
      .record(z.string().max(100), z.union([z.string().max(2000), z.boolean(), z.number()]))
      .optional(),
  }),
};
export const githubWriteOperations = Object.keys(
  githubWriteParams,
) as (keyof typeof githubWriteParams)[];
export function parseGithubWrite(operation: string, params: unknown): Record<string, unknown> {
  const schema = (githubWriteParams as Record<string, z.ZodType>)[operation];
  if (!schema) throw new Error("지원하지 않는 GitHub 쓰기 작업입니다");
  return schema.parse(params) as Record<string, unknown>;
}
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
  issue: "이슈 상세",
  pull: "풀 리퀘스트 상세",
  comments: "이슈·PR 댓글",
  releases: "릴리스 목록",
  repo_update: "저장소 설정·공개 여부 변경",
  branch_create: "브랜치 생성",
  branch_delete: "브랜치 삭제",
  file_put: "파일 작성·수정·커밋",
  file_delete: "파일 삭제·커밋",
  commit_files: "여러 파일 커밋·푸시",
  issue_create: "이슈 생성",
  issue_update: "이슈 수정",
  issue_comment: "이슈·PR 댓글 작성",
  pull_create: "풀 리퀘스트 생성",
  pull_update: "풀 리퀘스트 수정",
  pull_merge: "풀 리퀘스트 병합",
  release_create: "릴리스 생성",
  workflow_dispatch: "워크플로 실행",
};
