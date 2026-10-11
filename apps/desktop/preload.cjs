const { contextBridge, ipcRenderer } = require("electron");
const origin = process.argv
  .find((argument) => argument.startsWith("--openmuse-origin="))
  ?.slice(18);
if (process.isMainFrame && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
  const call = (name, arg) => ipcRenderer.invoke(`openmuse:${name}`, arg);
  contextBridge.exposeInMainWorld(
    "openmuseDesktop",
    Object.freeze({
      apiUrl: origin,
      session: () => call("session"),
      status: () => call("account-status"),
      signIn: (id) => call("sign-in", id),
      enablePlan: (id) => call("enable-plan", id),
      cancelSignIn: () => call("cancel-sign-in"),
      select: (id) => call("select-account", id),
      signOut: () => call("sign-out"),
      usage: () => call("usage"),
      importGoogleClient: () => call("google-import"),
    }),
  );
}
