module.exports = {
  appId: "ai.openmuse.desktop",
  productName: "OpenMuse",
  directories: { output: "dist/windows" },
  electronVersion: "44.7.0",
  npmRebuild: false,
  asar: true,
  asarUnpack: ["**/*.node", "**/*.wasm", "**/*.data"],
  files: ["main.mjs", "preload.cjs", "package.json", "LICENSE", "dist/**", "web/**", "!**/*.map"],
  win: {
    target: "nsis",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
    artifactName: "OpenMuse-Setup-${version}-${arch}.exe",
    signExecutable: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    installerLanguages: ["ko_KR", "en_US"],
    language: "1042",
  },
  publish: null,
};
