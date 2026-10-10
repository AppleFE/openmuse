import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  generatedUiMessageSchema,
  parseGeneratedUi,
} from "../packages/domain/src/generative-ui.ts";
import {
  generatedUiDocument,
  generatedUiWrapper,
} from "../packages/domain/src/generative-ui-document.ts";
import { interactiveAnswer } from "./helpers/generated-ui.ts";

test("generated UI validation bounds code and bridge messages", () => {
  assert.equal(parseGeneratedUi(interactiveAnswer).title, "복리 계산기");
  assert.throws(() => parseGeneratedUi({ ...interactiveAnswer, html: "x".repeat(64001) }));
  assert.throws(() =>
    parseGeneratedUi({ ...interactiveAnswer, libraries: ["https://evil.test/code.js"] }),
  );
  assert.throws(() =>
    parseGeneratedUi({ ...interactiveAnswer, jsExpressions: Array(16).fill("x".repeat(12000)) }),
  );
  for (const message of [
    { type: "height", height: Infinity },
    { type: "prompt", text: "x".repeat(4001) },
    { type: "execute", command: "shell" },
  ])
    assert.equal(generatedUiMessageSchema.safeParse(message).success, false);
});

test("real sandbox renders interactive answers, exports and isolates generated code", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("http://ui.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
  );
  await page.goto("http://ui.test/");
  await page.evaluate(() => {
    localStorage.setItem("secret", "host-token-sentinel");
  });
  await page
    .context()
    .addCookies([{ name: "secret", value: "host-cookie-sentinel", url: "http://ui.test" }]);
  const options = { channel: "test_channel", nonce: "test_nonce_123" };
  async function mount(frameDocument: string) {
    await page.evaluate((html) => {
      document.body.replaceChildren();
      const frame = document.createElement("iframe");
      frame.sandbox.add("allow-scripts");
      frame.title = "test";
      frame.srcdoc = html;
      document.body.append(frame);
    }, frameDocument);
  }
  const full = generatedUiDocument(interactiveAnswer, options);
  await mount(full);
  const frame = page.frameLocator("iframe");
  await frame.locator("#amount").filter({ hasText: "1,628,895원" }).waitFor();
  await frame.locator("#years").fill("20");
  assert.equal(await frame.locator("#amount").innerText(), "2,653,298원");
  await page.evaluate(() => {
    (window as unknown as { draft: string }).draft = "";
    window.addEventListener("message", (e) => {
      if (e.data.type === "prompt") (window as unknown as { draft: string }).draft = e.data.text;
    });
  });
  await frame.locator("#follow").click();
  await page.waitForFunction(
    () => (window as unknown as { draft: string }).draft === "20년 복리 계산 결과를 설명해줘",
  );
  assert.equal(
    await page.evaluate(() => (window as unknown as { draft: string }).draft),
    "20년 복리 계산 결과를 설명해줘",
  );

  const attack = generatedUiDocument(
    {
      ...interactiveAnswer,
      html: '<h2>Safe</h2><script>parent.document.body.innerHTML="pwned"</script><img src="http://ui.test/stolen" onerror="document.body.innerHTML=\'pwned\'"><iframe src="http://ui.test/iframe"></iframe><meta http-equiv="refresh" content="0;url=http://ui.test/navigation"><div id="isolation"></div>',
      css: "</style><script>parent.pwned=true</script>",
      jsFunctions: "",
      jsExpressions: [
        `(async()=>{const blocked=[];for(const f of [()=>parent.document.cookie,()=>localStorage.getItem('secret'),()=>document.cookie]){try{f();blocked.push(false)}catch{blocked.push(true)}}try{await fetch('http://ui.test/api/stolen');blocked.push(false)}catch{blocked.push(true)}document.getElementById('isolation').textContent=JSON.stringify(blocked);})();`,
      ],
    },
    options,
  );
  await mount(attack);
  await frame.locator("#isolation").filter({ hasText: "[true,true,true,true]" }).waitFor();
  assert.deepEqual(requests, ["http://ui.test/"]);
  assert.equal(await page.evaluate(() => localStorage.getItem("secret")), "host-token-sentinel");
  assert.equal(
    await frame.locator("iframe,meta[http-equiv=refresh],#openmuse-widget script").count(),
    0,
  );

  await mount(generatedUiDocument(interactiveAnswer, { ...options, preview: true }));
  await frame.locator("#years").waitFor();
  assert.equal(
    await frame.locator("#amount").innerText(),
    "",
    "partial or failed tool calls cannot execute JavaScript",
  );
  // The exported document preserves isolation and works without an OpenMuse session.
  await page.setContent(generatedUiWrapper(full, options.channel));
  await frame.locator("#amount").filter({ hasText: "1,628,895원" }).waitFor();
  await frame.locator("#follow").click();
  await page.locator("#note").filter({ hasText: "10년 복리 계산 결과를 설명해줘" }).waitFor();
});
