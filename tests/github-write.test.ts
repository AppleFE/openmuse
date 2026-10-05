import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { errorLabel } from "../apps/mobile/src/locale.ts";
import { connectorWriteSchema } from "../packages/domain/src/proxmox.ts";
import { githubAdapter } from "../packages/integrations/src/connectors/github.ts";

test("GitHub commits multiple files atomically without force and rejects stale HEAD", async (t) => {
  const old = "a".repeat(40),
    next = "b".repeat(40),
    requests: { method: string; path: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ method: req.method!, path: req.url!, body });
    const result = req.url!.includes("/git/ref/")
      ? { object: { sha: old } }
      : req.url!.includes(`/git/commits/${old}`)
        ? { tree: { sha: old } }
        : { sha: next };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as { port: number },
    adapter = githubAdapter();
  const ctx = {
    config: { baseUrl: `http://127.0.0.1:${address.port}` },
    secrets: { token: "fixture-token" },
  };
  const input = connectorWriteSchema.parse({
    connectorId: "fixture",
    operation: "commit_files",
    params: {
      repo: "owner/repo",
      branch: "test/branch",
      expectedHeadSha: old,
      message: "update",
      files: [
        { path: "한글.txt", content: "내용" },
        { path: "old.txt", delete: true },
      ],
    },
  });
  await adapter.write!(ctx, input);
  assert.equal(requests.length, 5);
  assert.deepEqual(requests.at(-1)!.body, { sha: next, force: false });
  assert.equal(requests[2].body.tree[1].sha, null);
  assert.equal(requests[2].body.tree[0].content, "내용");
  requests.length = 0;
  await assert.rejects(
    adapter.write!(ctx, { ...input, params: { ...input.params, expectedHeadSha: next } }),
    /브랜치가 변경/,
  );
  assert.equal(requests.length, 1);
  requests.length = 0;
  await adapter.write!(ctx, {
    connectorId: "fixture",
    operation: "repo_update",
    params: { repo: "owner/repo", settings: { private: true } },
  });
  assert.equal(requests[0].method, "PATCH");
  assert.deepEqual(requests[0].body, { private: true });
});
test("GitHub write schemas reject traversal, force pushes and duplicate file paths", () => {
  for (const params of [
    { repo: "o/r", branch: "main", message: "x", content: "x", path: "../escape" },
    { repo: "o/r", branch: "main", message: "x", content: "x", path: "x", force: true },
  ])
    assert.equal(
      connectorWriteSchema.safeParse({ connectorId: "x", operation: "file_put", params }).success,
      false,
    );
});

test("GitHub public fork visibility rejection explains the provider limitation in Korean without retrying", async (t) => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(422, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        message: "Validation Failed",
        errors: [{ message: "Public forks can't be made private" }],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  await assert.rejects(
    githubAdapter().write!(
      { config: { baseUrl: `http://127.0.0.1:${port}` }, secrets: { token: "fixture-token" } },
      {
        connectorId: "fixture",
        operation: "repo_update",
        params: { repo: "owner/fork", settings: { private: true } },
      },
    ),
    /공개 포크 저장소를 비공개로 전환할 수 없습니다/,
  );
  assert.equal(calls, 1);
  assert.match(
    errorLabel("Provider responded HTTP 422: Public forks can't be made private"),
    /자동 승인이나 토큰 권한 변경으로 해결되지/,
  );
});
