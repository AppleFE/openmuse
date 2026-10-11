import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, utilityProcess } from "electron";
import { startGateway } from "./gateway.mjs";
import { ChatGPTAccounts } from "./oauth.mjs";

const root = dirname(fileURLToPath(import.meta.url));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window,
    backend,
    gateway,
    accounts,
    apiUrl,
    stopping = false;
  const accessKey = randomBytes(32).toString("hex");
  const gatewayKey = randomBytes(32).toString("hex");
  let appSession;
  async function session() {
    const response = await fetch(`${apiUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey }),
    });
    if (!response.ok) throw new Error("로컬 워크스페이스에 연결할 수 없습니다.");
    appSession = await response.json();
    return appSession;
  }
  async function refreshCatalog() {
    if (!apiUrl) return;
    const current = await session();
    await fetch(`${apiUrl}/api/agent/models/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${current.token}` },
    });
  }
  function handle(name, action) {
    ipcMain.handle(`openmuse:${name}`, async (event, arg) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== apiUrl ||
        new URL(event.senderFrame.url).pathname !== "/"
      )
        throw new Error("OpenMuse 창에서만 사용할 수 있습니다.");
      return action(arg);
    });
  }
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (stopping) return;
    stopping = true;
    event.preventDefault();
    accounts?.cancelSignIn();
    accounts?.cancelRequests();
    gateway?.close();
    const finish = () =>
      void Promise.resolve(accounts?.refreshing)
        .catch(() => {})
        .then(() => app.quit());
    if (!backend) {
      finish();
      return;
    }
    backend.once("exit", finish);
    backend.postMessage({ shutdown: true });
    setTimeout(() => {
      backend.kill();
      finish();
    }, 8_000).unref();
  });
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("ai.openmuse.desktop");
      const dataDir = app.getPath("userData");
      await mkdir(dataDir, { recursive: true });
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("Windows 보안 저장소를 사용할 수 없습니다.");
      const encryption = {
        encrypt: (text) => safeStorage.encryptString(text),
        decrypt: (bytes) => safeStorage.decryptString(Buffer.from(bytes)),
      };
      let encryptionKey;
      const keyFile = join(dataDir, "workspace-key.bin");
      try {
        encryptionKey = encryption.decrypt(await readFile(keyFile));
      } catch (error) {
        if (error.code !== "ENOENT")
          throw new Error("워크스페이스 암호화 키를 열 수 없습니다. 기존 데이터는 보존됩니다.");
        encryptionKey = randomBytes(32).toString("base64");
        await writeFile(keyFile, encryption.encrypt(encryptionKey), { flag: "wx" });
      }
      accounts = new ChatGPTAccounts({
        file: join(dataDir, "chatgpt-accounts.bin"),
        encryption,
        openBrowser: (url) => {
          if (new URL(url).origin !== "https://auth.openai.com")
            throw new Error("허용되지 않은 로그인 주소입니다.");
          return shell.openExternal(url);
        },
      });
      await accounts.load();
      gateway = await startGateway(accounts, gatewayKey);
      // An explicit OS environment allowlist prevents developer API keys, .env paths,
      // proxy endpoints and preexisting databases from leaking into this installation.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(SystemRoot|WINDIR|SystemDrive|COMSPEC|PATH|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES|USERNAME|USERDOMAIN|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(
            key,
          ),
        ),
      );
      backend = utilityProcess.fork(join(root, "dist/apps/server/src/desktop-entry.js"), [], {
        cwd: dataDir,
        env,
        stdio: "pipe",
        serviceName: "OpenMuse local workspace",
      });
      // Log only startup categories; model inputs and credential-bearing request errors stay out of logs.
      backend.stderr.on("data", (chunk) => {
        if (!app.isPackaged) process.stderr.write(chunk);
      });
      backend.stdout.on("data", () => {});
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("로컬 서버 시작 시간이 초과되었습니다.")),
          60_000,
        );
        backend.once("message", (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        backend.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`로컬 서버가 종료되었습니다 (${code}).`));
        });
      });
      backend.postMessage({
        dataDir: join(dataDir, "workspace"),
        webRoot: join(root, "web"),
        accessKey,
        encryptionKey,
        gatewayUrl: gateway.url,
        gatewayKey,
      });
      apiUrl = (await ready).url;
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiUrl))
        throw new Error("로컬 서버 주소가 올바르지 않습니다.");
      handle("session", session);
      handle("account-status", () => accounts.status());
      handle("sign-in", async (id) => {
        if (id !== undefined && typeof id !== "string") throw new Error("잘못된 계정 ID입니다.");
        try {
          return await accounts.signIn(id);
        } finally {
          await refreshCatalog();
        }
      });
      handle("enable-plan", async (id) => {
        if (typeof id !== "string") throw new Error("잘못된 계정 ID입니다.");
        try {
          return await accounts.signIn(id, true);
        } finally {
          await refreshCatalog();
        }
      });
      handle("cancel-sign-in", () => accounts.cancelSignIn());
      handle("select-account", async (id) => {
        if (typeof id !== "string") throw new Error("잘못된 계정 ID입니다.");
        const result = await accounts.select(id);
        await refreshCatalog();
        return result;
      });
      handle("sign-out", async () => {
        const result = await accounts.disconnect();
        await refreshCatalog();
        return result;
      });
      handle("usage", () => shell.openExternal("https://chatgpt.com/settings/usage"));
      window = new BrowserWindow({
        width: 1220,
        height: 900,
        minWidth: 760,
        minHeight: 600,
        title: "OpenMuse",
        backgroundColor: "#0d1215",
        autoHideMenuBar: true,
        webPreferences: {
          preload: join(root, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          additionalArguments: [`--openmuse-origin=${apiUrl}`],
        },
      });
      const web = window.webContents;
      web.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      web.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) void shell.openExternal(url);
        return { action: "deny" };
      });
      web.on("will-navigate", (event, url) => {
        if (new URL(url).origin !== apiUrl || new URL(url).pathname !== "/") event.preventDefault();
      });
      web.on("will-attach-webview", (event) => event.preventDefault());
      backend.on("exit", () => {
        if (!stopping) {
          void dialog.showMessageBox(window, {
            type: "error",
            message: "로컬 서버가 종료되었습니다. OpenMuse를 다시 실행해 주세요.",
          });
        }
      });
      await window.loadURL(apiUrl);
    })
    .catch(async (error) => {
      if (!app.isPackaged) console.error(error);
      await dialog.showMessageBox({
        type: "error",
        title: "OpenMuse",
        message:
          "OpenMuse를 시작할 수 없습니다. 앱을 다시 실행해 주세요. 기존 데이터는 보존됩니다.",
      });
      app.quit();
    });
}
