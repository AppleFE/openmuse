import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { crc32, gzipSync } from "node:zlib";
import { Header } from "tar";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { PiAgentRunInput } from "../apps/server/src/engine/pi-agent.ts";
import { emptyResourceLoader } from "../apps/server/src/engine/pi-runtime.ts";
import { skillMetadata, skillPath, unpackSkills } from "../apps/server/src/skill-import.ts";
import { skillTools } from "../apps/server/src/skill-tools.ts";
import { Skills } from "../apps/server/src/skills.ts";
import { skillCommand, skillPrompt } from "../packages/domain/src/skills.ts";

const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text) });
const md = (name: string, body = "Read references/check.txt, then follow its checklist.") =>
  `---\nname: ${name}\ndescription: A repeatable review workflow\n---\n${body}`;
function zip(entries: { path: string; bytes: Buffer; mode?: number }[]) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path),
      head = Buffer.alloc(30),
      index = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc32(entry.bytes), 14);
    head.writeUInt32LE(entry.bytes.length, 18);
    head.writeUInt32LE(entry.bytes.length, 22);
    head.writeUInt16LE(name.length, 26);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(0x314, 4);
    index.writeUInt16LE(20, 6);
    head.copy(index, 8, 6, 28);
    index.writeUInt32LE(((entry.mode ?? 0o100600) << 16) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    local.push(head, name, entry.bytes);
    central.push(index, name);
    offset += head.length + name.length + entry.bytes.length;
  }
  const end = Buffer.alloc(22),
    directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function tar(entries: { path: string; bytes: Buffer; link?: string }[]) {
  return Buffer.concat([
    ...entries.flatMap((f) => {
      const header = Buffer.alloc(512);
      new Header({
        path: f.path,
        size: f.bytes.length,
        mode: 0o600,
        type: f.link ? "SymbolicLink" : "File",
        linkpath: f.link,
      }).encode(header);
      return [header, f.bytes, Buffer.alloc((512 - (f.bytes.length % 512)) % 512)];
    }),
    Buffer.alloc(1024),
  ]);
}

let db: Store,
  directory: string,
  config: Config,
  server: Awaited<ReturnType<typeof createApp>>,
  token: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-skills-"));
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
        id: "coder",
        label: "Coder",
        provider: "openai",
        model: "openai/test-coder",
        capabilities: ["chat", "coding", "tools"],
        enabled: true,
        available: true,
      },
    ],
  };
  server = await createApp(db, config);
  const r = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await r.json()).token;
});
after(async () => {
  await server?.agent.stop();
  await db?.close();
  await rm(directory, { recursive: true, force: true });
});

test("imports folder resources, multiple zip skills and tar/gzip bundles without executing scripts", async () => {
  const skills = new Skills(db, config);
  const installed = await skills.import("bundles", [
    file("review/SKILL.md", md("review")),
    file("review/references/check.txt", "verify tests"),
    file("review/scripts/run.sh", "exit 99"),
    file("review/.git/config", "ignored"),
  ]);
  assert.equal(installed[0].files.length, 3);
  assert.equal(
    (await skills.read("bundles", "review", "references/check.txt", installed[0].id)).content,
    "verify tests",
  );
  const archive = zip([
    file("bundle/one/SKILL.md", md("one")),
    file("bundle/one/assets/data.json", "{}"),
    file("bundle/two/SKILL.md", md("two")),
  ]);
  assert.deepEqual(
    (await skills.import("bundles", [{ path: "bundle.zip", bytes: archive }])).map((s) => s.name),
    ["one", "two"],
  );
  assert.equal((await skills.get("bundles", "one")).files.length, 2);
  assert.equal((await skills.get("bundles", "two")).files.length, 1);
  const packed = tar([
    file("tar-skill/SKILL.md", md("tar-skill")),
    file("tar-skill/references/check.txt", "from tar"),
  ]);
  await skills.import("tar", [{ path: "test.tar", bytes: packed }]);
  await skills.import("gzip", [{ path: "test.tgz", bytes: gzipSync(packed) }]);
  assert.equal((await skills.activate("gzip", "tar-skill")).name, "tar-skill");
  await skills.import("plain", [
    file("review.MD", "# Review\nRun the tests and summarize failures."),
  ]);
  assert.equal((await skills.list("plain"))[0].name, "review");
});

test("rejects unsafe paths, links, collisions, oversized files and corrupt metadata atomically", async () => {
  const skills = new Skills(db, config);
  for (const path of [
    "../escape",
    "/etc/passwd",
    "C:\\escape",
    "a/../../x",
    "a\u0000b",
    "NUL",
    "CON.txt",
    "a.",
    "a/b:c",
  ])
    assert.throws(() => skillPath(path), { status: 422 });
  for (const archive of [
    zip([file("../escape", "x")]),
    zip([{ ...file("link", "../outside"), mode: 0o120777 }]),
    tar([{ ...file("link", ""), link: "../outside" }]),
  ])
    await assert.rejects(
      unpackSkills([
        { path: archive.readUInt32LE(0) === 0x04034b50 ? "bad.zip" : "bad.tar", bytes: archive },
      ]),
      { status: 422 },
    );
  await assert.rejects(unpackSkills([file("folder", "x"), file("folder/file", "y")]), {
    status: 422,
  });
  await assert.rejects(unpackSkills([file("FILE.md", "x"), file("file.md", "y")]), { status: 422 });
  await assert.rejects(
    unpackSkills([
      {
        path: "large.zip",
        bytes: zip([{ path: "huge", bytes: Buffer.alloc(2 * 1024 * 1024 + 1) }]),
      },
    ]),
    { status: 413 },
  );
  await assert.rejects(unpackSkills([{ path: "broken.zip", bytes: Buffer.from("broken") }]), {
    status: 422,
  });
  for (const text of [
    "---\nname: x\nname: y\n---\nbody",
    "---\nname: [array]\n---\nbody",
    "---\nname: missing-end",
    "---\nname: UpperCase\n---\nbody",
    "\u0000",
  ])
    assert.throws(() => skillMetadata(Buffer.from(text), "fallback"), { status: 422 });
  await assert.rejects(
    skills.import("atomic", [file("ok/SKILL.md", md("ok")), file("bad/SKILL.md", md("Bad"))]),
    { status: 422 },
  );
  assert.deepEqual(await skills.list("atomic"), []);
});

test("owner isolation, explicit replacement, revision pinning, disabling and deletion persist", async () => {
  const skills = new Skills(db, config),
    owner = "lifecycle";
  const [first] = await skills.import(owner, [
    file("SKILL.md", md("check")),
    file("references/check.txt", "abcdef"),
    { path: "assets/binary", bytes: Buffer.from([0, 255, 1, 2]) },
  ]);
  await assert.rejects(skills.get("other", "check"), { status: 404 });
  await assert.rejects(skills.read(owner, "check", "../secret"), { status: 422 });
  const second = new Skills(db, config);
  assert.equal((await second.activate(owner, "check")).id, first.id);
  assert.deepEqual(
    (await second.read(owner, "check", "references/check.txt", first.id, 2, 2)).content,
    "cd",
  );
  assert.equal(
    (await second.read(owner, "check", "references/check.txt", first.id, 2, 2)).nextOffset,
    4,
  );
  assert.equal(
    (await second.read(owner, "check", "assets/binary", first.id, 1, 2)).content,
    Buffer.from([255, 1]).toString("base64"),
  );
  await assert.rejects(skills.import(owner, [file("SKILL.md", md("check", "new instructions"))]), {
    status: 409,
  });
  assert.equal((await skills.get(owner, "check")).id, first.id);
  const resources = await skills.piResources(owner);
  assert.equal(emptyResourceLoader("prompt", resources).getSkills().skills[0].name, "check");
  await skills.update(owner, "check", false);
  await assert.rejects(skills.invocation(owner, "/check inspect"), { status: 409 });
  assert.deepEqual(await skills.piResources(owner), []);
  assert.match(
    (await skills.inspect(owner, await skills.get(owner, "check"))).instructions,
    /checklist/,
  );
  await skills.import(owner, [file("SKILL.md", md("check", "new instructions"))], true);
  await assert.rejects(skills.read(owner, "check", "SKILL.md", first.id), { status: 409 });
  await assert.rejects(readdir(resources[0].baseDir), { code: "ENOENT" });
  const [last] = await skills.piResources(owner);
  await skills.remove(owner, "check");
  await assert.rejects(readdir(last.baseDir), { code: "ENOENT" });
  assert.deepEqual(await new Skills(db, config).list(owner), []);
});

test("multipart API requires authentication and supports preview of disabled skills", async () => {
  assert.equal((await server.app.request("/api/skills")).status, 401);
  const form = new FormData();
  form.append("files", new File([md("api-skill")], "SKILL.md"));
  form.append("files", new File(["notes"], "notes.txt"));
  form.append("paths", JSON.stringify(["api/SKILL.md", "api/references/notes.txt"]));
  const headers = { Authorization: `Bearer ${token}` };
  const imported = await server.app.request("/api/skills/import", {
    method: "POST",
    headers,
    body: form,
  });
  assert.equal(imported.status, 201, await imported.clone().text());
  assert.equal((await imported.json()).skills[0].files.length, 2);
  const disabled = await server.app.request("/api/skills/api-skill", {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.status, 200);
  const detail = await server.app.request("/api/skills/api-skill", { headers });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).skill.enabled, false);
  assert.equal(
    (await server.app.request("/api/skills/api-skill", { method: "DELETE", headers })).status,
    200,
  );
  assert.equal((await server.app.request("/api/skills/api-skill", { headers })).status, 404);
});

test("slash commands inject selected instructions in pi without mutating chat history and survive delegation", async () => {
  const skills = server.agent.skills;
  await skills.import("chat-owner", [
    file("SKILL.md", md("review", "WORKFLOW_MARKER: read references/check.txt.")),
    file("references/check.txt", "CHECK_REFERENCE"),
  ]);
  const calls: PiAgentRunInput[] = [];
  Object.defineProperty(server.agent, "pi", {
    value: {
      supports: async () => true,
      run: async (input: PiAgentRunInput) => {
        calls.push(input);
        return "done";
      },
    },
  });
  const messages = [
    { id: "message", role: "user" as const, content: "/review inspect this change" },
  ];
  const agent = new ConversationAgent(config, server.agent, "chat-owner", config.models?.[0]);
  const input = {
    threadId: "chat-skill",
    runId: "run",
    messages,
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const events: { type: string }[] = [];
  await new Promise<void>((resolve, reject) =>
    agent
      .run(input)
      .subscribe({ next: (event) => events.push(event), complete: resolve, error: reject }),
  );
  assert.ok(events.some((e) => e.type === "RUN_FINISHED"));
  assert.equal(messages[0].content, "/review inspect this change");
  assert.match(calls[0].prompt, /WORKFLOW_MARKER/);
  const read = calls[0].tools.find((tool) => tool.name === "read_skill_file");
  assert.ok(read?.execute);
  assert.equal(
    ((await read.execute({ name: "review", path: "references/check.txt" })) as { content: string })
      .content,
    "CHECK_REFERENCE",
  );
  const delegate = calls[0].tools.find((tool) => tool.name === "delegate_task");
  assert.ok(delegate?.execute);
  const delegated = (await delegate.execute({ prompt: "Inspect the change", kind: "agent" })) as {
    id: string;
  };
  const tasks = await db.list<{ skill?: { instructions: string }; id: string }>(
    "chat-owner",
    "tasks",
  );
  assert.ok(tasks.length > 0, JSON.stringify(delegated));
  assert.match(tasks[0].skill?.instructions ?? "", /WORKFLOW_MARKER/);
  await new Promise<void>((resolve, reject) =>
    agent
      .run({
        ...input,
        runId: "next",
        messages: [...messages, { id: "followup", role: "user", content: "Thanks" }],
      })
      .subscribe({ complete: resolve, error: reject }),
  );
  assert.equal(calls[1].prompt, "Thanks");
  const unknown: { type: string; message?: string }[] = [];
  await new Promise<void>((resolve, reject) =>
    agent
      .run({ ...input, messages: [{ id: "missing", role: "user", content: "/not-installed x" }] })
      .subscribe({ next: (event) => unknown.push(event), complete: resolve, error: reject }),
  );
  assert.ok(unknown.some((e) => e.type === "RUN_ERROR" && e.message?.includes("not-installed")));
  assert.equal(calls.length, 2);
});

test("explicit-only skills require user selection and command parsing ignores ordinary paths", async () => {
  const skills = new Skills(db, config);
  await skills.import("explicit", [
    file(
      "SKILL.md",
      md("manual").replace("description:", "disable-model-invocation: true\ndescription:"),
    ),
  ]);
  const tool = skillTools(skills, "explicit").find((t) => t.name === "read_skill");
  assert.ok(tool?.execute);
  await assert.rejects(tool.execute({ name: "manual" }), { status: 403 });
  const selection = await skills.invocation("explicit", "/skill:manual hello");
  const selected = skillTools(skills, "explicit", selection).find((t) => t.name === "read_skill");
  assert.ok(selected?.execute);
  assert.equal(((await selected.execute({ name: "manual" })) as { name: string }).name, "manual");
  assert.deepEqual(skillCommand(" /manual do this "), { name: "manual", argument: "do this" });
  for (const text of ["/Volumes/disk", "look at /manual", "https://example.com", "/"])
    assert.equal(skillCommand(text), null);
  assert.equal(skillPrompt(undefined, "unchanged"), "unchanged");
});
