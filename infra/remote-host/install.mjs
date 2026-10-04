import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const directory = dirname(fileURLToPath(import.meta.url)),
  root = resolve(directory, ".."),
  configPath = resolve(root, "config.json"),
  browserPath = resolve(root, "browsers");
const invitation = new URL(process.argv[2]);
if (
  !/^https?:$/.test(invitation.protocol) ||
  invitation.username ||
  invitation.password ||
  !/^\/api\/host-agent\/install\/[a-f0-9]{64}$/.test(invitation.pathname)
)
  throw Error("Invalid installation invitation");
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { stdio: "inherit", windowsHide: true, ...options });
  if (result.status !== 0) throw Error(`Installation command failed: ${file}`);
}
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  PLAYWRIGHT_BROWSERS_PATH: browserPath,
};
if (process.platform !== "win32" && process.getuid?.() !== 0)
  throw Error("관리자 권한으로 설치 명령을 실행하세요 (sudo)");
const npm = resolve(
  dirname(process.execPath),
  process.platform === "win32"
    ? "node_modules/npm/bin/npm-cli.js"
    : "../lib/node_modules/npm/bin/npm-cli.js",
);
run(process.execPath, [npm, "ci", "--omit=dev", "--ignore-scripts"], { cwd: directory, env });
run(
  process.execPath,
  [
    resolve(directory, "node_modules/playwright/cli.js"),
    "install",
    ...(process.platform === "linux" ? ["--with-deps"] : []),
    "chromium",
  ],
  { cwd: directory, env },
);
await mkdir(root, { recursive: true, mode: 0o700 });
let config;
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.enrollmentOrigin && config.enrollmentOrigin !== invitation.origin)
    throw Error("다른 OpenMuse에 연결된 설치입니다. 기존 연결을 먼저 해제하세요");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((v) => v && v.family === "IPv4" && !v.internal)
  .map((v) => v.address);
const isTailscale = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
};
let address =
  addresses.find(isTailscale) ??
  addresses.find((ip) => ip.startsWith("192.168.") || ip.startsWith("10.")) ??
  addresses[0];
if (!address) throw Error("연결할 네트워크 주소가 없습니다. Tailscale 또는 LAN 연결을 확인하세요");
config = {
  ...config,
  token: config?.token ?? randomBytes(32).toString("hex"),
  host: address,
  port: config?.port ?? 8791,
  dataDir: config?.dataDir ?? resolve(root, "state"),
  browserPath,
  enrollmentOrigin: invitation.origin,
};
await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
const xml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const launch = resolve(directory, "run.mjs");
if (process.platform === "linux") {
  const quote = (v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const service = `[Unit]\nDescription=OpenMuse Host Agent\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nUser=root\nWorkingDirectory=${quote(directory)}\nExecStart=${quote(process.execPath)} ${quote(launch)} ${quote(configPath)}\nRestart=always\nRestartSec=5\nEnvironment=PLAYWRIGHT_BROWSERS_PATH=${browserPath}\n\n[Install]\nWantedBy=multi-user.target\n`;
  await writeFile("/etc/systemd/system/openmuse-host-agent.service", service, { mode: 0o644 });
  run("systemctl", ["daemon-reload"]);
  run("systemctl", ["enable", "--now", "openmuse-host-agent.service"]);
  run("systemctl", ["restart", "openmuse-host-agent.service"]);
} else if (process.platform === "darwin") {
  const plist = "/Library/LaunchDaemons/com.openmuse.host-agent.plist";
  const output = resolve(root, "service.log");
  await writeFile(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.openmuse.host-agent</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(launch)}</string><string>${xml(configPath)}</string></array><key>WorkingDirectory</key><string>${xml(directory)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(output)}</string><key>StandardErrorPath</key><string>${xml(output)}</string></dict></plist>`,
    { mode: 0o644 },
  );
  spawnSync("/bin/launchctl", ["bootout", "system", plist], { stdio: "ignore" });
  run("/bin/launchctl", ["bootstrap", "system", plist]);
} else if (process.platform === "win32") {
  const ps = resolve(root, "service.ps1"),
    quote = (v) => `'${v.replace(/'/g, "''")}'`;
  const serverAddresses = (await import("node:dns/promises"))
    .lookup(invitation.hostname, { all: true })
    .then((values) => values.map((value) => value.address));
  const allowedAddresses = await serverAddresses;
  if (!allowedAddresses.length)
    throw Error("Cannot resolve the OpenMuse server for the Host Agent firewall rule");
  const firewall = `Get-NetFirewallRule -Name 'OpenMuse-Host-Agent' -ErrorAction SilentlyContinue | Remove-NetFirewallRule\nNew-NetFirewallRule -Name 'OpenMuse-Host-Agent' -DisplayName 'OpenMuse Host Agent' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress ${quote(address)} -LocalPort ${config.port} -RemoteAddress @(${allowedAddresses.map(quote).join(",")}) -Profile Any | Out-Null\n`;
  await writeFile(
    ps,
    `$ErrorActionPreference='Stop'\n$action=New-ScheduledTaskAction -Execute ${quote(process.execPath)} -Argument ${quote(`"${launch}" "${configPath}"`)} -WorkingDirectory ${quote(directory)}\n$trigger=New-ScheduledTaskTrigger -AtStartup\n$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest\n$settings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew\nStop-ScheduledTask -TaskName 'OpenMuse Host Agent' -ErrorAction SilentlyContinue\nRegister-ScheduledTask -TaskName 'OpenMuse Host Agent' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null\nStart-ScheduledTask -TaskName 'OpenMuse Host Agent'\n`,
    { mode: 0o600 },
  );
  await writeFile(ps, "$ErrorActionPreference='Stop'\n" + firewall + (await readFile(ps, "utf8")), {
    mode: 0o600,
  });
  run("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps]);
} else throw Error("Unsupported host platform");
const baseUrl = `http://${address}:${config.port}`;
let healthy = false;
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetch(baseUrl + "/host", {
      headers: { Authorization: "Bearer " + config.token },
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok) {
      healthy = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
if (!healthy) throw Error("Host Agent가 시작되지 않았습니다. 서비스 로그와 방화벽을 확인하세요");
const response = await fetch(invitation.href + "/enroll", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ baseUrl, token: config.token, connectorId: config.connectorId }),
  signal: AbortSignal.timeout(30000),
});
if (!response.ok)
  throw Error(
    "서비스가 설치됐지만 OpenMuse 등록에 실패했습니다. 서버에서 이 PC의 주소와 포트에 접근 가능한지 확인한 후 새 설치 명령으로 재시도하세요",
  );
const result = await response.json();
config.connectorId = result.id;
await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log(`Host Agent 설치 완료 · ${hostname()} · 관리자 서비스 · 연결 ${result.id}`);
