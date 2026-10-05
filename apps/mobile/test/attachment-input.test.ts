import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkUploadFiles,
  droppedAttachments,
  ignoredAttachmentPath,
} from "../src/attachment-input.ts";

test("folder drops preserve paths, read multiple directory batches and skip generated directories", async () => {
  const entry = (name: string, text: string) => ({
    name,
    isFile: true,
    isDirectory: false,
    file: (done: (f: File) => void) => done(new File([text], name)),
  });
  const directory = (name: string, batches: unknown[][]) => ({
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let i = 0;
      return { readEntries: (done: (entries: unknown[]) => void) => done(batches[i++] ?? []) };
    },
  });
  const root = directory("project", [
    [entry("README.md", "read")],
    [
      directory("src", [[entry("main.ts", "code")]]),
      directory("node_modules", [[entry("skip.js", "ignored")]]),
    ],
  ]);
  const transfer = {
    items: [{ kind: "file", webkitGetAsEntry: () => root, getAsFile: () => null }],
    files: [],
  } as unknown as DataTransfer;
  const files = await droppedAttachments(transfer);
  assert.deepEqual(
    files.map((f) => f.path),
    ["project/README.md", "project/src/main.ts"],
  );
  assert.equal(await files[1].file.text(), "code");
  assert.equal(ignoredAttachmentPath("project\\.git\\config"), true);
  assert.equal(ignoredAttachmentPath("project/src/app.ts"), false);
});

test("file-only clipboard/drop fallback and cumulative selection limits are supported", async () => {
  const file = new File(["clipboard text file"], "pasted.txt");
  assert.deepEqual(
    (await droppedAttachments({ files: [file] } as unknown as DataTransfer)).map((f) => f.path),
    ["pasted.txt"],
  );
  checkUploadFiles([{ size: 20 * 1024 * 1024 }]);
  assert.throws(() => checkUploadFiles([{ size: 20 * 1024 * 1024 + 1 }]));
  assert.throws(() => checkUploadFiles([{ size: 1 }], Array(200).fill({ size: 1 })));
  assert.throws(() => checkUploadFiles(Array(6).fill({ size: 20 * 1024 * 1024 })));
});
