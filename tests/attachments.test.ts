import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { PDFDocument } from "pdf-lib";
import { PNG } from "pngjs";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { attachmentPath } from "../apps/server/src/attachments.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { PiAgentRunInput } from "../apps/server/src/engine/pi-agent.ts";
import { attachmentMessage } from "../packages/domain/src/attachments.ts";
import { modelFixture } from "./helpers/model.ts";

let db: Store,
  directory: string,
  config: Config,
  server: Awaited<ReturnType<typeof createApp>>,
  token: string;
const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text) });
const png = PNG.sync.write(new PNG({ width: 3, height: 2 }));
const input = (messages: Message[], threadId = "test-thread"): RunAgentInput => ({
  threadId,
  runId: crypto.randomUUID(),
  messages,
  tools: [],
  context: [],
  state: {},
});
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-attachments-"));
  db = await createStore();
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    googleRedirectUri: "http://localhost/callback",
    allowedOrigins: [],
    models: [
      {
        id: "vision",
        label: "Vision",
        model: "openai/fixture",
        provider: "openai",
        capabilities: ["chat", "vision", "tools"],
        enabled: true,
        available: true,
      },
    ],
  };
  server = await createApp(db, config);
  token = (await server.auth.session()).token;
});
after(async () => {
  await server?.agent.stop();
  await db?.close();
  await rm(directory, { recursive: true, force: true });
});

test("folder upload keeps Unicode paths, authenticates downloads and serves active formats safely", async () => {
  const form = new FormData();
  form.append("threadId", "api-upload");
  form.append(
    "paths",
    JSON.stringify(["폴더/src/example.html", "폴더/picture.png", "폴더/archive.zip"]),
  );
  form.append("files", new File(["<script>alert(1)</script>"], "example.html"));
  form.append("files", new File([new Uint8Array(png)], "picture.png"));
  form.append("files", new File(["not extracted"], "archive.zip"));
  const response = await server.app.request("/api/attachments", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(response.status, 201, await response.clone().text());
  const { files } = await response.json();
  assert.deepEqual(
    files.map((f: { kind: string }) => f.kind),
    ["text", "image", "binary"],
  );
  assert.equal(files[0].path, "폴더/src/example.html");
  assert.equal((await server.app.request(`/api/attachments/${files[0].id}/content`)).status, 401);
  const html = await server.app.request(files[0].url);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(html.headers.get("content-disposition") ?? "", /^attachment/);
  assert.match(html.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.match(
    (await server.app.request(files[1].url)).headers.get("content-disposition") ?? "",
    /^inline/,
  );
  assert.match(
    (await server.app.request(`${files[1].url}&download=1`)).headers.get("content-disposition") ??
      "",
    /^attachment/,
  );
  const tampered = new URL(files[0].url);
  tampered.searchParams.set("owner", "other");
  assert.equal((await server.app.request(tampered)).status, 403);
  await assert.rejects(server.agent.attachments.get("other", files[0].id), { status: 404 });
  await assert.rejects(server.agent.attachments.get("local-user", files[0].id, "other-thread"), {
    status: 404,
  });
});

test("rejects traversal, duplicate paths, corrupt images, oversized batches and forged references", async () => {
  for (const path of [
    "../secret",
    "/absolute",
    "a//b",
    "C:\\temp\\file",
    "a/./file",
    "a\u0000.txt",
  ])
    assert.throws(() => attachmentPath(path));
  const service = server.agent.attachments;
  await assert.rejects(
    service.import("validation", "thread", [file("a.txt", "a"), file("a.txt", "b")]),
    /중복/,
  );
  await assert.rejects(service.import("validation", "thread", [file("a.png", "bad")]), /이미지/);
  await assert.rejects(
    service.import(
      "validation",
      "thread",
      Array.from({ length: 201 }, (_, i) => file(`${i}.txt`, "")),
    ),
    /200/,
  );
  const files = await service.import("validation", "thread", [
    file("code/main.ts", "const n = 42;"),
    { path: "image.png", bytes: png },
  ]);
  const message: Message = { id: "m", role: "user", content: attachmentMessage("read", files) };
  await service.validate("validation", "thread", [message]);
  await assert.rejects(service.validate("validation", "wrong-thread", [message]), { status: 404 });
  await assert.rejects(service.validate("wrong-owner", "thread", [message]), { status: 404 });
  await assert.rejects(
    service.validate("validation", "thread", [
      {
        ...message,
        content: [
          { type: "binary", id: files[0].id, mimeType: "image/png", filename: files[0].path },
        ],
      },
    ]),
    /일치/,
  );
  for (const part of [{ url: "http://localhost/private" }, { data: "YWJj" }])
    await assert.rejects(
      service.validate("validation", "thread", [
        { ...message, content: [{ type: "binary", mimeType: "image/png", ...part }] },
      ]),
      /업로드/,
    );
  await assert.rejects(
    service.validate("validation", "thread", [
      { ...message, content: attachmentMessage("", Array(7).fill(files[1])) },
    ]),
    /6개/,
  );
  assert.equal((await service.read("validation", "thread", files[0].id, 6, 5)).text, "n = 4");
});

test("PDF extraction runs in a bounded worker and paginates text without inventing OCR", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("FIRST_PAGE_MARKER");
  pdf.addPage().drawText("SECOND_PAGE_MARKER");
  const [saved] = await server.agent.attachments.import("pdf", "pdf-thread", [
    { path: "document.pdf", bytes: await pdf.save() },
  ]);
  const first = await server.agent.attachments.read("pdf", "pdf-thread", saved.id, 0, 5, 1);
  assert.equal(first.text, "FIRST");
  assert.equal(first.nextPage, 1);
  assert.equal(first.nextOffset, 5);
  const second = await server.agent.attachments.read("pdf", "pdf-thread", saved.id, 0, 24000, 2);
  assert.match(String(second.text), /SECOND_PAGE_MARKER/);
  assert.equal(second.pageCount, 2);
  assert.equal(second.nextPage, null);
  assert.match(String(second.note), /OCR/);
});

test("model transport receives real image bytes and text tools, while persisted user content remains IDs", async (t) => {
  const files = await server.agent.attachments.import("model", "test-thread", [
    { path: "pic.png", bytes: png },
    file("folder/data.csv", "x,y\n10,20"),
  ]);
  const original = input([{ id: "m", role: "user", content: attachmentMessage("inspect", files) }]);
  const snapshot = structuredClone(original);
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "read_attachment", arguments: { id: files[1].id, offset: 0, page: 1, limit: 1000 } }
      : undefined,
  );
  const pi = server.agent.pi;
  Object.defineProperty(server.agent, "pi", {
    configurable: true,
    value: { supports: async () => false },
  });
  try {
    const events = await lastValueFrom(
      new ConversationAgent(config, server.agent, "model", config.models?.[0])
        .run(original)
        .pipe(toArray()),
    );
    assert.equal(events.at(-1)?.type, "RUN_FINISHED", JSON.stringify(events));
    assert.equal(requests.length, 2);
    assert.match(requests[0].body, /input_image/);
    assert.ok(requests[0].body.includes(png.toString("base64")));
    assert.match(requests[1].body, /10,20/);
    assert.deepEqual(original, snapshot);
    const next = input([...original.messages, { id: "followup", role: "user", content: "next" }]);
    const prepared = await server.agent.attachments.prepare("model", "test-thread", next.messages);
    assert.equal(prepared.images.length, 0);
    assert.ok(!JSON.stringify(prepared.input(next)).includes(png.toString("base64")));
  } finally {
    Object.defineProperty(server.agent, "pi", { configurable: true, value: pi });
  }
});

test("embedded Pi receives uploaded images and an explicitly selected skill together", async () => {
  const files = await server.agent.attachments.import("pi-image", "test-thread", [
    { path: "pic.png", bytes: png },
  ]);
  await server.agent.skills.import("pi-image", [
    file("SKILL.md", "---\nname: inspect\ndescription: Inspect input\n---\nSKILL_MARKER"),
  ]);
  const calls: PiAgentRunInput[] = [],
    pi = server.agent.pi;
  Object.defineProperty(server.agent, "pi", {
    configurable: true,
    value: {
      supports: async () => true,
      run: async (arg: PiAgentRunInput) => {
        calls.push(arg);
        return "done";
      },
    },
  });
  try {
    const original = input([
      { id: "m", role: "user", content: attachmentMessage("/inspect look", files) },
    ]);
    const events = await lastValueFrom(
      new ConversationAgent(config, server.agent, "pi-image", config.models?.[0])
        .run(original)
        .pipe(toArray()),
    );
    assert.equal(events.at(-1)?.type, "RUN_FINISHED");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].images?.[0].data, png.toString("base64"));
    assert.match(calls[0].prompt, /SKILL_MARKER/);
    assert.match(calls[0].prompt, /pic.png/);
    const profile = config.models?.[0];
    assert.ok(profile);
    const nonvision = { ...profile, capabilities: ["chat" as const] };
    const errors = await lastValueFrom(
      new ConversationAgent(config, server.agent, "pi-image", nonvision)
        .run(original)
        .pipe(toArray()),
    );
    assert.ok(errors.some((e) => e.type === "RUN_ERROR"));
    assert.equal(calls.length, 1);
  } finally {
    Object.defineProperty(server.agent, "pi", { configurable: true, value: pi });
  }
});

test("unsent attachments can be removed but attachments referenced by a conversation cannot", async () => {
  const service = server.agent.attachments;
  const files = await service.import("delete", "delete-thread", [
    file("a.txt", "a"),
    file("b.txt", "b"),
  ]);
  await service.remove("delete", files[0].id);
  await assert.rejects(service.get("delete", files[0].id), { status: 404 });
  await db.put("delete", "conversation-threads", {
    id: "delete-thread",
    messages: [{ id: "m", role: "user", content: attachmentMessage("", [files[1]]) }],
    activeRunId: null,
  });
  await assert.rejects(service.remove("delete", files[1].id), { status: 409 });
});
