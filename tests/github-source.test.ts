import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { ConnectorError, connectorAdapter } from "../packages/integrations/src/connectors/index.ts";

const github = connectorAdapter("github"),
  token = "ghp_fixture_private_value",
  sha = "a".repeat(40);
async function provider(t: TestContext, handler: (path: string) => unknown) {
  const requests: { path: string; method: string; accept: string | undefined }[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    requests.push({
      path: req.url ?? "",
      method: req.method ?? "",
      accept: String(req.headers.accept),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(handler(req.url ?? "")));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return {
    ctx: { config: { baseUrl: `http://127.0.0.1:${address.port}/api/v3` }, secrets: { token } },
    requests,
  };
}
const entry = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  path: name,
  sha,
  size: 3,
  type: "file",
  html_url: `https://github.example/private/${name}`,
  ...extra,
});

test("GitHub reads private repository metadata, branches and commit history with pagination", async (t) => {
  const mock = await provider(t, (p) => {
    if (p.includes("/branches"))
      return [{ name: "feature/private", commit: { sha }, protected: false }];
    if (p.includes("/commits"))
      return [
        {
          sha,
          html_url: "https://github.example/commit",
          author: null,
          commit: {
            message: "Add private feature",
            author: { name: "author", date: "2026-10-02T00:00:00Z" },
          },
        },
      ];
    return {
      id: 1,
      name: "private",
      full_name: "owner/private",
      private: true,
      description: null,
      html_url: "https://github.example/owner/private",
      default_branch: "main",
      language: null,
    };
  });
  const repo = (await github.run(mock.ctx, "repo", { repo: "owner/private" })) as {
    repo: { private: boolean; defaultBranch: string };
  };
  assert.equal(repo.repo.private, true);
  assert.equal(repo.repo.defaultBranch, "main");
  const branches = (await github.run(mock.ctx, "branches", {
    repo: "owner/private",
    limit: 1,
    page: 2,
  })) as { branches: { commitSha: string }[]; nextPage: number };
  assert.equal(branches.branches[0].commitSha, sha);
  assert.equal(branches.nextPage, 3);
  const commits = (await github.run(mock.ctx, "commits", {
    repo: "owner/private",
    ref: "feature/private",
    path: "src/file name.ts",
    limit: 1,
    page: 2,
  })) as { commits: { message: string; author: string }[]; nextPage: number };
  assert.equal(commits.commits[0].author, "author");
  assert.equal(commits.nextPage, 3);
  assert.equal(
    mock.requests[2].path,
    "/api/v3/repos/owner/private/commits?sha=feature%2Fprivate&path=src%2Ffile+name.ts&per_page=1&page=2",
  );
  assert.ok(mock.requests.every((r) => r.method === "GET"));
});

test("GitHub folder and tree reads preserve complete/truncated states and omit recursive=false", async (t) => {
  const mock = await provider(t, (p) =>
    p.includes("/contents")
      ? {
          entries: [
            entry("src", { type: "dir" }),
            entry("readme.md"),
            entry("external", { submodule_git_url: "https://other.example/repo" }),
          ],
        }
      : {
          sha,
          truncated: p.includes("recursive"),
          tree: [
            { path: "src", type: "tree", sha, mode: "040000" },
            { path: "src/a.ts", type: "blob", sha, mode: "100644", size: 3 },
            { path: "elsewhere.ts", type: "blob", sha, mode: "100644", size: 3 },
          ],
        },
  );
  const contents = (await github.run(mock.ctx, "contents", {
    repo: "owner/private",
    path: "",
    ref: sha,
    limit: 2,
  })) as { entries: { type: string }[]; nextOffset: number; truncated: boolean };
  assert.equal(contents.entries.length, 2);
  assert.equal(contents.nextOffset, 2);
  assert.equal(contents.truncated, true);
  const tail = (await github.run(mock.ctx, "contents", { repo: "owner/private", offset: 2 })) as {
    entries: { type: string }[];
  };
  assert.equal(tail.entries[0].type, "submodule");
  await github.run(mock.ctx, "tree", {
    repo: "owner/private",
    ref: "feature/private",
    recursive: false,
  });
  assert.equal(mock.requests[2].path, "/api/v3/repos/owner/private/git/trees/feature%2Fprivate");
  const tree = (await github.run(mock.ctx, "tree", {
    repo: "owner/private",
    ref: sha,
    recursive: true,
    path: "src",
    limit: 1,
  })) as { entries: { path: string }[]; providerTruncated: boolean; nextOffset: number };
  assert.equal(tree.entries[0].path, "src");
  assert.equal(tree.providerTruncated, true);
  assert.equal(tree.nextOffset, 1);
  assert.ok(mock.requests[3].path.endsWith("?recursive=1"));
});

test("GitHub file reads decode Korean UTF-8, resume bounded sections and redact the stored PAT", async (t) => {
  const source = `한글 코드\nconst token = '${token}';\nexport const pi = true;`,
    clean = source.replace(token, "[redacted]");
  const mock = await provider(t, () =>
    entry("src/한글 file.ts", {
      encoding: "base64",
      content: `${Buffer.from(source).toString("base64")}\n`,
      size: Buffer.byteLength(source),
      download_url: `https://other.example/?token=${token}`,
    }),
  );
  const first = (await github.run(mock.ctx, "file", {
    repo: "owner/private",
    path: "src/한글 file.ts",
    ref: "feature/private",
    limit: 10,
  })) as { file: { content: string; nextOffset: number; truncated: boolean } };
  assert.equal(first.file.content, clean.slice(0, 10));
  assert.equal(first.file.nextOffset, 10);
  assert.equal(first.file.truncated, true);
  const rest = (await github.run(mock.ctx, "file", {
    repo: "owner/private",
    path: "src/한글 file.ts",
    offset: 10,
  })) as { file: { content: string; nextOffset: null } };
  assert.equal(first.file.content + rest.file.content, clean);
  assert.equal(rest.file.nextOffset, null);
  assert.ok(!JSON.stringify(rest).includes(token));
  assert.ok(!JSON.stringify(rest).includes("other.example"));
  assert.equal(mock.requests.length, 2);
  assert.ok(mock.requests[0].path.includes("%ED%95%9C%EA%B8%80%20file.ts?ref=feature%2Fprivate"));
});

test("GitHub reports oversized, binary and non-file content without external fetches or fabricated text", async (t) => {
  const mock = await provider(t, (p) =>
    p.includes("large")
      ? entry("large", { size: 2 * 1024 ** 2, encoding: "none", content: "" })
      : p.includes("binary")
        ? entry("binary", {
            size: 3,
            encoding: "base64",
            content: Buffer.from([0xff, 0, 1]).toString("base64"),
          })
        : p.includes("module")
          ? entry("module", { submodule_git_url: "https://external.example/repo" })
          : entry("folder", { type: "dir" }),
  );
  for (const [path, reason] of [
    ["large", "too_large"],
    ["binary", "binary"],
    ["module", "not_a_file"],
    ["folder", "not_a_file"],
  ]) {
    const result = (await github.run(mock.ctx, "file", { repo: "owner/private", path })) as {
      file: { content: null; unavailableReason: string };
    };
    assert.equal(result.file.content, null);
    assert.equal(result.file.unavailableReason, reason);
  }
  assert.equal(mock.requests.length, 4);
});

test("GitHub validates read parameters before dispatch and rejects corrupt base64", async (t) => {
  const mock = await provider(t, () => entry("bad.ts", { encoding: "base64", content: "%%%" }));
  for (const params of [
    { repo: "owner/..", path: "file" },
    { repo: "owner/private", path: "../file" },
    { repo: "owner/private", path: "/file" },
    { repo: "owner/private", path: "x\\file" },
    { repo: "owner/private", path: "file", ref: ".." },
    { repo: "owner/private", path: "file", limit: 50000 },
    { repo: "owner/private", path: "file", write: true },
  ])
    await assert.rejects(github.run(mock.ctx, "file", params));
  assert.equal(mock.requests.length, 0);
  await assert.rejects(
    github.run(mock.ctx, "file", { repo: "owner/private", path: "bad.ts" }),
    (e) => e instanceof ConnectorError && e.code === "malformed",
  );
});
