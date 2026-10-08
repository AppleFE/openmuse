import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = dirname(fileURLToPath(import.meta.url));
const win = process.platform === "win32";
const root = join(
  win ? (process.env.LOCALAPPDATA ?? homedir()) : join(homedir(), ".local/share"),
  "OpenMuseDesktop",
);
const configPath = join(root, "config.json");
const launch = join(bundle, "desktop-helper.mjs");
const hostPath = resolve(process.argv[2] ?? join(bundle, "..", "config.json"));
if ((!win && process.getuid?.() === 0) || (win && userInfo().username.toUpperCase() === "SYSTEM"))
  throw Error(
    "로그인한 사용자로 설치하세요. Windows는 그 사용자의 관리자 PowerShell을 사용하세요. SYSTEM/root 설치는 실제 사용자 화면에 연결되지 않습니다.",
  );
const host = JSON.parse(await readFile(hostPath, "utf8"));
if (typeof host.token !== "string" || host.token.length < 32)
  throw Error("먼저 Host Agent를 설치하고 config.json 경로를 지정하세요.");
await mkdir(root, { recursive: true, mode: 0o700 });
function run(file, args, options = {}) {
  const r = spawnSync(file, args, { stdio: "inherit", windowsHide: true, ...options });
  if (r.status !== 0) throw Error(`설치 명령 실패: ${file}`);
  return r;
}
const psQuote = (s) => `'${String(s).replaceAll("'", "''")}'`;
function powershell(script) {
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-OutputFormat",
    "Text",
    "-EncodedCommand",
    Buffer.from(
      "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'\n" + script,
      "utf16le",
    ).toString("base64"),
  ]);
}
if (win) {
  const sid = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  }).stdout?.match(/S-1-5-[\d-]+/)?.[0];
  if (!sid) throw Error("현재 Windows 사용자 SID를 확인할 수 없습니다.");
  run(
    "icacls.exe",
    [
      root,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ],
    { stdio: "ignore" },
  );
} else await chmod(root, 0o700);
const pythonCandidates = win
  ? [
      ["py", ["-3"]],
      ["python", []],
    ]
  : [["python3", []]];
const python = pythonCandidates.find(
  ([file, args]) =>
    spawnSync(file, [...args, "-c", "import sys; assert sys.version_info >= (3,10)"], {
      stdio: "ignore",
      windowsHide: true,
    }).status === 0,
);
if (!python)
  throw Error(
    "Python 3.10 이상을 먼저 설치하세요. Windows: winget install Python.Python.3.12 / macOS: brew install python / Ubuntu·Debian: sudo apt install python3-venv python3-tk scrot xclip",
  );
// An active native session holds python.exe open on Windows. Stop before
// rebuilding its venv, and prevent the service manager from restarting it mid-update.
const helperToken = host.desktopProxy?.token ?? randomBytes(32).toString("hex");
await fetch("http://127.0.0.1:8793/desktop/shutdown", {
  method: "POST",
  headers: { Authorization: `Bearer ${helperToken}` },
  signal: AbortSignal.timeout(3000),
}).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 500));
if (win) {
  powershell(`Stop-ScheduledTask -TaskName 'OpenMuse Desktop' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -eq ${psQuote(process.execPath)} -and $_.CommandLine.Contains(${psQuote(`"${launch}"`)}) -and $_.CommandLine.Contains(${psQuote(`"${configPath}"`)}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`);
} else if (process.platform === "darwin") {
  spawnSync(
    "/bin/launchctl",
    [
      "bootout",
      `gui/${process.getuid()}`,
      join(homedir(), "Library/LaunchAgents/com.openmuse.desktop.plist"),
    ],
    { stdio: "ignore" },
  );
} else {
  spawnSync("systemctl", ["--user", "stop", "openmuse-desktop.service"], { stdio: "ignore" });
}
run(python[0], [
  ...python[1],
  "-m",
  "venv",
  ...(process.platform === "linux" ? ["--system-site-packages"] : []),
  join(root, "venv"),
]);
const executable = join(root, "venv", win ? "Scripts/python.exe" : "bin/python");
run(executable, [
  "-m",
  "pip",
  "install",
  "--disable-pip-version-check",
  "-r",
  join(bundle, "infra/desktop/requirements.txt"),
]);
const config = {
  token: helperToken,
  port: 8793,
  python: executable,
  driver: join(bundle, "infra/desktop/driver.py"),
  dataDir: join(root, "state"),
  log: join(root, "desktop.log"),
};
await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
if (win) {
  // Interactive logon, not Session 0. The requested elevated level applies only
  // to this user's existing administrator rights; UAC/secure desktop is excluded.
  const wrapper = join(root, "start.ps1");
  await writeFile(
    wrapper,
    `$p=Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(`"${launch}" "${configPath}"`)} -WindowStyle Hidden -PassThru -Wait\nexit $p.ExitCode\n`,
  );
  powershell(`$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote(`-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${wrapper}"`)} -WorkingDirectory ${psQuote(bundle)}
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Stop-ScheduledTask -TaskName 'OpenMuse Desktop' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -eq ${psQuote(process.execPath)} -and $_.CommandLine.Contains(${psQuote(`"${launch}"`)}) -and $_.CommandLine.Contains(${psQuote(`"${configPath}"`)}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
Register-ScheduledTask -TaskName 'OpenMuse Desktop' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'OpenMuse Desktop'`);
} else if (process.platform === "darwin") {
  const xml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const plist = join(homedir(), "Library/LaunchAgents/com.openmuse.desktop.plist");
  await mkdir(dirname(plist), { recursive: true });
  await writeFile(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.openmuse.desktop</string><key>ProgramArguments</key><array>${[process.execPath, launch, configPath].map((v) => `<string>${xml(v)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(config.log)}</string><key>StandardErrorPath</key><string>${xml(config.log)}</string></dict></plist>`,
    { mode: 0o600 },
  );
  spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}`, plist], { stdio: "ignore" });
  run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plist]);
} else {
  const unit = join(homedir(), ".config/systemd/user/openmuse-desktop.service");
  await mkdir(dirname(unit), { recursive: true });
  const quote = (s) =>
    '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%") + '"';
  await writeFile(
    unit,
    `[Unit]\nDescription=OpenMuse logged-in desktop\nAfter=graphical-session.target\nPartOf=graphical-session.target\n[Service]\nExecStart=${[process.execPath, launch, configPath].map(quote).join(" ")}\nRestart=on-failure\nRestartSec=5\n[Install]\nWantedBy=graphical-session.target\n`,
    { mode: 0o600 },
  );
  run("systemctl", [
    "--user",
    "import-environment",
    ...["DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE"].filter((k) => process.env[k]),
  ]);
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", "openmuse-desktop.service"]);
  run("systemctl", ["--user", "restart", "openmuse-desktop.service"]);
}
host.desktopProxy = { url: `http://127.0.0.1:${config.port}`, token: config.token };
await writeFile(hostPath, JSON.stringify(host, null, 2), { mode: 0o600 });
console.log(
  "OpenMuse Desktop 설치 완료. 로그인 시 자동 실행됩니다. Host Agent 0.10.0 이상은 재시작 없이 연결 설정을 읽습니다.",
);
if (process.platform === "darwin")
  console.log(
    `macOS 시스템 설정 → 개인정보 보호 및 보안에서 화면 기록과 손쉬운 사용을 허용하세요: ${executable}`,
  );
console.log(
  "OpenMuse → 에이전트 컴퓨터 → 데스크톱 → 호스트 화면에서 연결 상태를 확인하세요. 잠금 화면·UAC 화면·Wayland는 지원하지 않습니다.",
);
