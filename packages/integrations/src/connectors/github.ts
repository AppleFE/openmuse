import { z } from "zod";
import {
  type ConnectorProviderInfo,
  githubConfigSchema,
  githubSecretsSchema,
} from "../../../domain/src/connectors.ts";
import { ConnectorError, httpJson } from "./http.ts";
import type { ConnectorAdapter, ConnectorContext } from "./types.ts";

const DEFAULT_BASE = "https://api.github.com";
const repoRef = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Use a repository reference like owner/name");

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
const listParams = z.object({
  repo: repoRef,
  state: z.enum(["open", "closed", "all"]).default("open"),
  limit: z.number().int().min(1).max(100).default(30),
});

function request(ctx: ConnectorContext, path: string) {
  const config = githubConfigSchema.parse(ctx.config);
  const secrets = githubSecretsSchema.parse(ctx.secrets);
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  return httpJson(`${base}${path}`, {
    timeoutMs: ctx.timeoutMs,
    secrets: [secrets.token],
    headers: {
      Authorization: `Bearer ${secrets.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "OpenMuse-Connector",
    },
  });
}

export function githubAdapter(): ConnectorAdapter {
  const info: ConnectorProviderInfo = {
    provider: "github",
    label: "GitHub",
    description: "Read repositories, issues and pull requests from GitHub or GitHub Enterprise.",
    configFields: [
      {
        name: "baseUrl",
        label: "API base URL",
        required: false,
        description: "Defaults to https://api.github.com. Set for GitHub Enterprise Server.",
      },
    ],
    secretFields: [
      {
        name: "token",
        label: "Personal access token",
        required: true,
        description: "Fine-grained or classic PAT with repository read access.",
      },
    ],
    operations: [
      {
        name: "repos",
        description: "List repositories visible to the token, most recently updated first.",
        params: [],
      },
      {
        name: "issues",
        description: "List issues in a repository.",
        params: [
          { name: "repo", type: "string", required: true, description: "owner/name" },
          { name: "state", type: "string", description: "open, closed or all" },
          { name: "limit", type: "number", description: "1-100, default 30" },
        ],
      },
      {
        name: "pulls",
        description: "List pull requests in a repository.",
        params: [
          { name: "repo", type: "string", required: true, description: "owner/name" },
          { name: "state", type: "string", description: "open, closed or all" },
          { name: "limit", type: "number", description: "1-100, default 30" },
        ],
      },
    ],
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
      switch (operation) {
        case "repos": {
          const repos = z
            .array(repoSchema)
            .parse(
              await request(
                ctx,
                "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
              ),
            );
          return {
            repos: repos.map((repo) => ({
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
            })),
          };
        }
        case "issues":
        case "pulls": {
          const input = listParams.parse(params);
          const items = z
            .array(operation === "issues" ? issueSchema : pullSchema)
            .parse(
              await request(
                ctx,
                `/repos/${input.repo}/${operation === "issues" ? "issues" : "pulls"}?state=${input.state}&per_page=${input.limit}`,
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
            };
          return {
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
    },
  };
}
