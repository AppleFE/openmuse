import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function installCli({ user = false } = {}) {
  const source = fileURLToPath(new URL("cli.mjs", import.meta.url));
  if (process.platform === "win32") {
    const root = join(process.env.ProgramData ?? "C:\\ProgramData", "OpenMuseCLI");
    await mkdir(root, { recursive: true });
    await copyFile(source, join(root, "cli.mjs"));
    await copyFile(process.execPath, join(root, "node.exe"));
    await writeFile(
      join(root, "openmuse.cmd"),
      '@echo off\r\n"%~dp0node.exe" "%~dp0cli.mjs" %*\r\n',
    );
    const quote = (s) => `'${s.replace(/'/g, "''")}'`;
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; & icacls.exe ${quote(root)} /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /T | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'CLI ACL failed' }; $old=[Environment]::GetEnvironmentVariable('Path','Machine'); if (($old -split ';') -notcontains ${quote(root)}) { [Environment]::SetEnvironmentVariable('Path',($old.TrimEnd(';')+';'+${quote(root)}),'Machine') }`,
      ],
      { windowsHide: true, stdio: "inherit" },
    );
    if (result.status !== 0) throw Error("CLI installation failed");
    console.log(`OpenMuse CLI: ${join(root, "openmuse.cmd")} (새 터미널에서 openmuse 사용)`);
  } else {
    const root = user ? join(homedir(), ".local/lib/openmuse-cli") : "/usr/local/lib/openmuse-cli",
      bin = user ? join(homedir(), ".local/bin/openmuse") : "/usr/local/bin/openmuse";
    await mkdir(root, { recursive: true, mode: 0o755 });
    await chmod(root, 0o755);
    await copyFile(source, join(root, "cli.mjs"));
    await chmod(join(root, "cli.mjs"), 0o644);
    await copyFile(process.execPath, join(root, "node"));
    await chmod(join(root, "node"), 0o755);
    await mkdir(dirname(bin), { recursive: true, mode: 0o755 });
    await writeFile(bin, `#!/bin/sh\nexec '${root}/node' '${root}/cli.mjs' "$@"\n`, {
      mode: 0o755,
    });
    await chmod(bin, 0o755);
    console.log(`OpenMuse CLI: ${bin}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await installCli({ user: process.argv.includes("--user") });
