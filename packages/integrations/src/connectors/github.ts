import { z } from "zod";
import {
  type ConnectorProviderInfo,
  githubConfigSchema,
  githubSecretsSchema,
} from "../../../domain/src/connectors.ts";
import {
  githubOperationLabels,
  githubReadParams,
  githubWriteParams,
  parseGithubWrite,
} from "../../../domain/src/github.ts";
import { ConnectorError, httpJson, redact } from "./http.ts";
import type { ConnectorAdapter, ConnectorContext } from "./types.ts";

const DEFAULT_BASE = "https://api.github.com";
const MAX_FILE_BYTES = 1024 * 1024;

const repoSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  description: z.string().nullable(),
  html_url: z.string(),
  default_branch: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  pushed_at: z.string().nullable().optional(),
  language: z.string().nullable(),
  stargazers_count: z.number().optional(),
  open_issues_count: z.number().optional(),
  archived: z.boolean().optional(),
});
const issueSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  html_url: z.string(),
  user: z.object({ login: z.string() }).nullable().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string().optional() })])).default([]),
  pull_request: z.object({}).optional(),
  comments: z.number().default(0),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
});
const pullSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  html_url: z.string(),
  user: z.object({ login: z.string() }).nullable().optional(),
  head: z.object({ ref: z.string() }).partial().optional(),
  base: z.object({ ref: z.string() }).partial().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  merged_at: z.string().nullable().optional(),
});
const branchSchema = z.object({
  name: z.string(),
  commit: z.object({ sha: z.string() }),
  protected: z.boolean().optional(),
});
const entrySchema = z.object({
  name: z.string(),
  path: z.string(),
  sha: z.string(),
  size: z.number().int().nonnegative(),
  type: z.enum(["file", "dir", "symlink", "submodule"]),
  html_url: z.string().nullable().optional(),
  submodule_git_url: z.string().nullable().optional(),
  encoding: z.string().optional(),
  content: z.string().optional(),
});
const treeSchema = z.object({
  sha: z.string(),
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["blob", "tree", "commit"]),
      sha: z.string(),
      mode: z.string(),
      size: z.number().optional(),
    }),
  ),
});
const commitSchema = z.object({
  sha: z.string(),
  html_url: z.string(),
  author: z.object({ login: z.string() }).nullable().optional(),
  commit: z.object({
    message: z.string(),
    author: z
      .object({
        name: z.string().nullable().optional(),
        date: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
});

function request(
  ctx: ConnectorContext,
  path: string,
  accept = "application/vnd.github+json",
  maxBytes?: number,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  json?: unknown,
) {
  const config = githubConfigSchema.parse(ctx.config);
  const secrets = githubSecretsSchema.parse(ctx.secrets);
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  return httpJson(`${base}${path}`, {
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
    secrets: [secrets.token],
    maxBytes,
    method,
    json,
    headers: {
      Authorization: `Bearer ${secrets.token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "OpenMuse-Connector",
    },
  });
}

function safeData(value: unknown, ctx: ConnectorContext): unknown {
  if (typeof value === "string") return redact(value, [String(ctx.secrets.token)]);
  if (Array.isArray(value)) return value.map((v) => safeData(v, ctx));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safeData(v, ctx)]));
  return value;
}
const segment = encodeURIComponent;
const filePath = (path: string) => path.split("/").map(segment).join("/");
function query(path: string, params: Record<string, unknown>) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== "") search.set(k, String(v));
  return `${path}${search.size ? `?${search}` : ""}`;
}
const nextPage = (page: number, count: number, limit: number) =>
  count === limit ? page + 1 : null;
function repoView(repo: z.infer<typeof repoSchema>) {
  return {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    description: repo.description,
    url: repo.html_url,
    defaultBranch: repo.default_branch ?? null,
    language: repo.language,
    stars: repo.stargazers_count ?? 0,
    openIssues: repo.open_issues_count ?? 0,
    archived: repo.archived ?? false,
    updatedAt: repo.updated_at ?? null,
    pushedAt: repo.pushed_at ?? null,
  };
}
function entryView(entry: z.infer<typeof entrySchema>) {
  return {
    name: entry.name,
    path: entry.path,
    sha: entry.sha,
    size: entry.size,
    type: entry.submodule_git_url ? "submodule" : entry.type,
    url: entry.html_url ?? null,
  };
}
const descriptions: Record<string, string> = {
  repos:
    "List repositories visible to the configured token, including private repositories. Supports page and limit; nextPage can require one extra request to establish completion.",
  issues: "List repository issues, excluding pull requests. Supports state, page and limit.",
  pulls:
    "List repository pull requests with head and base branches. Supports state, page and limit.",
  repo: "Read repository details including private status and defaultBranch. Repository Metadata read permission is required.",
  branches:
    "List branches and immutable commit SHAs. Requires repository Contents read access; pass a returned commitSha to ref when inspecting code consistently.",
  contents:
    "List a folder at ref (branch, tag or commit SHA), defaulting to the repository default branch. path is relative; omit it for the root. Supports offset and limit. An upstream directory may be capped at 1000 entries; use tree for larger directories.",
  tree: "Read a Git file tree by ref, default HEAD. recursive defaults false; true includes descendants. Optional path filters a prefix. Offset/limit bound output; providerTruncated means fetch each subtree by its SHA rather than treating this list as complete. Requires Contents read access.",
  file: "Read UTF-8 source text from a private or public repository at ref. Relative path required. Supports offset/limit in characters; nextOffset retrieves the next section. Returns blob SHA, line range and truncation status. Files above 1 MiB, binary files and submodules return metadata with an unavailableReason. Requires Contents read access. Credentials and external download URLs are never returned or followed.",
  commits:
    "List commit SHAs, messages, authors and dates at ref (branch, tag or SHA), optionally filtered by path. Supports page/limit. Requires Contents read access.",
};
function operations() {
  return Object.entries({ ...githubReadParams, ...githubWriteParams }).map(([name, schema]) => {
    const paramsSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
    const properties = paramsSchema.properties as Record<
      string,
      { type?: string; enum?: string[]; description?: string }
    >;
    const required = paramsSchema.required as string[] | undefined;
    return {
      name,
      kind: name in githubWriteParams ? ("write" as const) : ("read" as const),
      label: githubOperationLabels[name],
      description:
        descriptions[name] ??
        `${githubOperationLabels[name]}. Writes require a prepared connector action and the corresponding GitHub token write permission.`,
      paramsSchema,
      params: Object.entries(properties).map(([key, spec]) => ({
        name: key,
        type:
          spec.type === "boolean"
            ? ("boolean" as const)
            : spec.type === "number" || spec.type === "integer"
              ? ("number" as const)
              : ("string" as const),
        required: required?.includes(key),
        enum: spec.enum,
        description: spec.description ?? key,
      })),
    };
  });
}

export function githubAdapter(): ConnectorAdapter {
  const info: ConnectorProviderInfo = {
    provider: "github",
    label: "GitHub",
    description:
      "GitHub 저장소·파일·이슈·PR을 조회하고, 설정·브랜치·커밋·댓글·릴리스·워크플로를 변경합니다.",
    configFields: [
      {
        name: "baseUrl",
        label: "API base URL",
        required: false,
        type: "url",
        description: "Defaults to https://api.github.com. Set for GitHub Enterprise Server.",
      },
    ],
    secretFields: [
      {
        name: "token",
        label: "Personal access token",
        required: true,
        type: "password",
        description:
          "Fine-grained PAT: 조회는 Metadata/Contents 읽기, 변경은 해당 Contents·Issues·Pull requests·Actions 쓰기, 공개 여부 변경은 Administration 쓰기 권한이 필요합니다. Classic PAT는 repo 범위를 사용하세요.",
      },
    ],
    operations: operations(),
  };
  return {
    info,
    async test(ctx) {
      try {
        const user = z.object({ login: z.string() }).parse(await request(ctx, "/user"));
        return { ok: true, detail: `Authenticated as ${user.login}` };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : "GitHub check failed",
        };
      }
    },
    async run(ctx, operation, params) {
      const read = async () => {
        switch (operation) {
          case "issue":
          case "pull":
          case "comments":
          case "releases": {
            const input = githubReadParams[operation].parse(params);
            const base = `/repos/${input.repo}`;
            const suffix =
              operation === "releases"
                ? "/releases"
                : operation === "pull"
                  ? `/pulls/${"number" in input ? input.number : 0}`
                  : `/issues/${"number" in input ? input.number : 0}${operation === "comments" ? "/comments" : ""}`;
            return request(
              ctx,
              query(
                base + suffix,
                "page" in input ? { page: input.page, per_page: input.limit } : {},
              ),
            );
          }
          case "repos": {
            const input = githubReadParams.repos.parse(params);
            const repos = z
              .array(repoSchema)
              .parse(
                await request(
                  ctx,
                  `/user/repos?per_page=${input.limit}&sort=updated&affiliation=owner,collaborator,organization_member${input.page > 1 ? `&page=${input.page}` : ""}`,
                ),
              );
            return {
              repos: repos.map(repoView),
              page: input.page,
              nextPage: nextPage(input.page, repos.length, input.limit),
            };
          }
          case "repo": {
            const input = githubReadParams.repo.parse(params);
            return { repo: repoView(repoSchema.parse(await request(ctx, `/repos/${input.repo}`))) };
          }
          case "branches": {
            const input = githubReadParams.branches.parse(params);
            const branches = z.array(branchSchema).parse(
              await request(
                ctx,
                query(`/repos/${input.repo}/branches`, {
                  per_page: input.limit,
                  page: input.page,
                }),
              ),
            );
            return {
              repo: input.repo,
              branches: branches.map((b) => ({
                name: b.name,
                commitSha: b.commit.sha,
                protected: b.protected ?? false,
              })),
              page: input.page,
              nextPage: nextPage(input.page, branches.length, input.limit),
            };
          }
          case "contents": {
            const input = githubReadParams.contents.parse(params);
            const raw = await request(
              ctx,
              query(
                `/repos/${input.repo}/contents${input.path ? `/${filePath(input.path)}` : ""}`,
                { ref: input.ref },
              ),
              "application/vnd.github.object+json",
            );
            const entries = Array.isArray(raw)
              ? z.array(entrySchema).parse(raw)
              : raw && typeof raw === "object" && "entries" in raw
                ? z.object({ entries: z.array(entrySchema) }).parse(raw).entries
                : [entrySchema.parse(raw)];
            const end = Math.min(entries.length, input.offset + input.limit);
            return {
              repo: input.repo,
              ref: input.ref ?? null,
              path: input.path,
              entries: entries.slice(input.offset, end).map(entryView),
              totalEntries: entries.length,
              offset: input.offset,
              nextOffset: end < entries.length ? end : null,
              truncated: input.offset > 0 || end < entries.length,
              providerMayBeTruncated: entries.length >= 1000,
            };
          }
          case "tree": {
            const input = githubReadParams.tree.parse(params);
            const tree = treeSchema.parse(
              await request(
                ctx,
                query(`/repos/${input.repo}/git/trees/${segment(input.ref)}`, {
                  recursive: input.recursive ? "1" : undefined,
                }),
                "application/vnd.github+json",
                8 * 1024 * 1024,
              ),
            );
            const entries = input.path
              ? tree.tree.filter(
                  (e) => e.path === input.path || e.path.startsWith(`${input.path}/`),
                )
              : tree.tree;
            const end = Math.min(entries.length, input.offset + input.limit);
            return {
              repo: input.repo,
              ref: input.ref,
              treeSha: tree.sha,
              entries: entries.slice(input.offset, end),
              totalEntries: entries.length,
              offset: input.offset,
              nextOffset: end < entries.length ? end : null,
              providerTruncated: tree.truncated,
              truncated: tree.truncated || input.offset > 0 || end < entries.length,
            };
          }
          case "file": {
            const input = githubReadParams.file.parse(params);
            const entry = entrySchema.parse(
              await request(
                ctx,
                query(`/repos/${input.repo}/contents/${filePath(input.path)}`, { ref: input.ref }),
                "application/vnd.github.object+json",
              ),
            );
            const meta = { ...entryView(entry), repo: input.repo, ref: input.ref ?? null };
            const unavailable = (unavailableReason: string) => ({
              file: { ...meta, content: null, unavailableReason },
            });
            if (entry.type !== "file" || entry.submodule_git_url) return unavailable("not_a_file");
            if (entry.size > MAX_FILE_BYTES) return unavailable("too_large");
            if (entry.encoding !== "base64" || entry.content === undefined)
              return unavailable("unsupported_encoding");
            const encoded = entry.content.replace(/\s/g, "");
            if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded))
              throw new ConnectorError(
                "GitHub returned malformed file encoding",
                undefined,
                "malformed",
              );
            const bytes = Buffer.from(encoded, "base64");
            if (
              bytes.length !== entry.size ||
              bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
            )
              throw new ConnectorError(
                "GitHub returned inconsistent file contents",
                undefined,
                "malformed",
              );
            let text: string;
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            } catch {
              return unavailable("binary");
            }
            if (text.includes("\0")) return unavailable("binary");
            text = redact(text, [String(ctx.secrets.token)]);
            const end = Math.min(text.length, input.offset + input.limit),
              content = text.slice(input.offset, end),
              lineStart = text.slice(0, input.offset).split("\n").length;
            return {
              file: {
                ...meta,
                content,
                offset: input.offset,
                nextOffset: end < text.length ? end : null,
                totalCharacters: text.length,
                lineStart,
                lineEnd: lineStart + content.split("\n").length - 1,
                truncated: input.offset > 0 || end < text.length,
              },
            };
          }
          case "commits": {
            const input = githubReadParams.commits.parse(params);
            const commits = z.array(commitSchema).parse(
              await request(
                ctx,
                query(`/repos/${input.repo}/commits`, {
                  sha: input.ref,
                  path: input.path,
                  per_page: input.limit,
                  page: input.page,
                }),
              ),
            );
            return {
              repo: input.repo,
              ref: input.ref ?? null,
              commits: commits.map((c) => ({
                sha: c.sha,
                url: c.html_url,
                message: c.commit.message.slice(0, 2000),
                author: c.author?.login ?? c.commit.author?.name ?? null,
                date: c.commit.author?.date ?? null,
              })),
              page: input.page,
              nextPage: nextPage(input.page, commits.length, input.limit),
            };
          }
          case "issues":
          case "pulls": {
            const input = githubReadParams[operation].parse(params);
            const items = z
              .array(operation === "issues" ? issueSchema : pullSchema)
              .parse(
                await request(
                  ctx,
                  `/repos/${input.repo}/${operation === "issues" ? "issues" : "pulls"}?state=${input.state}&per_page=${input.limit}${input.page > 1 ? `&page=${input.page}` : ""}`,
                ),
              );
            const toView = (item: z.infer<typeof issueSchema>) => ({
              id: item.id,
              number: item.number,
              title: item.title,
              state: item.state,
              url: item.html_url,
              author: item.user?.login ?? null,
              labels: item.labels
                .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
                .filter(Boolean),
              comments: item.comments,
              createdAt: item.created_at ?? null,
              updatedAt: item.updated_at ?? null,
            });
            if (operation === "issues")
              // The issues endpoint mixes in pull requests; drop them here.
              return {
                issues: (items as z.infer<typeof issueSchema>[])
                  .filter((item) => !item.pull_request)
                  .map(toView),
                page: input.page,
                nextPage: nextPage(input.page, items.length, input.limit),
              };
            return {
              page: input.page,
              nextPage: nextPage(input.page, items.length, input.limit),
              pulls: (items as z.infer<typeof pullSchema>[]).map((pull) => ({
                ...toView({ comments: 0, labels: [], ...pull }),
                draft: pull.draft ?? false,
                head: pull.head?.ref ?? null,
                base: pull.base?.ref ?? null,
                mergedAt: pull.merged_at ?? null,
              })),
            };
          }
          default:
            throw new ConnectorError(
              `Unsupported GitHub operation: ${operation}`,
              undefined,
              "malformed",
            );
        }
      };
      return safeData(await read(), ctx);
    },
    async write(ctx, input) {
      const p = parseGithubWrite(input.operation, input.params);
      const { repo, ...body } = p;
      const base = `/repos/${repo}`;
      const send = (
        path: string,
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        json?: unknown,
      ) => request(ctx, base + path, undefined, undefined, method, json);
      let result: unknown;
      switch (input.operation) {
        case "repo_update":
          result = await send("", "PATCH", p.settings);
          break;
        case "branch_create":
          result = await send("/git/refs", "POST", { ref: `refs/heads/${p.branch}`, sha: p.sha });
          break;
        case "branch_delete":
          result = await send(`/git/refs/heads/${filePath(String(p.branch))}`, "DELETE");
          break;
        case "file_put":
        case "file_delete": {
          const { path, content, ...fields } = body;
          result = await send(
            `/contents/${filePath(String(path))}`,
            input.operation === "file_put" ? "PUT" : "DELETE",
            {
              ...fields,
              ...(content !== undefined
                ? { content: Buffer.from(String(content), "utf8").toString("base64") }
                : {}),
            },
          );
          break;
        }
        case "commit_files": {
          const head = z
            .object({ object: z.object({ sha: z.string() }) })
            .parse(await send(`/git/ref/heads/${filePath(String(p.branch))}`, "GET"));
          if (head.object.sha !== p.expectedHeadSha)
            throw new ConnectorError(
              "브랜치가 변경되었습니다. 최신 HEAD로 다시 준비하세요",
              409,
              "provider",
            );
          const parent = z
            .object({ tree: z.object({ sha: z.string() }) })
            .parse(await send(`/git/commits/${p.expectedHeadSha}`, "GET"));
          const files = p.files as { path: string; content?: string; delete: boolean }[];
          const tree = z
            .object({ sha: z.string() })
            .parse(
              await send("/git/trees", "POST", {
                base_tree: parent.tree.sha,
                tree: files.map((f) => ({
                  path: f.path,
                  mode: "100644",
                  type: "blob",
                  ...(f.delete ? { sha: null } : { content: f.content }),
                })),
              }),
            );
          const commit = z
            .object({ sha: z.string() })
            .parse(
              await send("/git/commits", "POST", {
                message: p.message,
                tree: tree.sha,
                parents: [p.expectedHeadSha],
              }),
            );
          result = await send(`/git/refs/heads/${filePath(String(p.branch))}`, "PATCH", {
            sha: commit.sha,
            force: false,
          });
          break;
        }
        case "issue_create":
          result = await send("/issues", "POST", body);
          break;
        case "issue_update":
        case "pull_update":
        case "pull_merge":
        case "issue_comment": {
          const { number, ...fields } = body;
          const isPull = input.operation.startsWith("pull_");
          result = await send(
            `/${isPull ? "pulls" : "issues"}/${number}${input.operation === "pull_merge" ? "/merge" : input.operation === "issue_comment" ? "/comments" : ""}`,
            input.operation === "pull_merge"
              ? "PUT"
              : input.operation === "issue_comment"
                ? "POST"
                : "PATCH",
            fields,
          );
          break;
        }
        case "pull_create":
          result = await send("/pulls", "POST", body);
          break;
        case "release_create":
          result = await send("/releases", "POST", body);
          break;
        case "workflow_dispatch": {
          const { workflow, ...fields } = body;
          result = await send(
            `/actions/workflows/${segment(String(workflow))}/dispatches`,
            "POST",
            fields,
          );
          break;
        }
        default:
          throw new ConnectorError("지원하지 않는 GitHub 쓰기 작업입니다");
      }
      return safeData({ operation: input.operation, repo, result, completed: true }, ctx);
    },
  };
}
