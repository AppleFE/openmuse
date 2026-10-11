import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { remoteHostAdapter } from "../../../packages/integrations/src/connectors/remote-host.ts";
import type { Config } from "./config.ts";
import type { ConnectorService } from "./connector-service.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const version = "0.10.2",
  nodeVersion = "24.21.0";
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
type Invitation = { id: string; owner: string; name: string; expiresAt: number; used: boolean };
export function posixInstaller(base: string) {
  return `#!/bin/sh
set -eu
umask 077
if [ "$(id -u)" != 0 ]; then
  script=$(mktemp /tmp/openmuse-install.XXXXXX)
  curl -fsSL '${base}/install.sh' -o "$script"
  chmod 700 "$script"
  exec sudo /bin/sh "$script"
fi
case "$(uname -s)" in Darwin) platform=darwin; root='/Library/Application Support/OpenMuse/HostAgent' ;; Linux) platform=linux; root=/opt/openmuse-host-agent ;; *) echo 'Unsupported operating system' >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo 'Unsupported architecture' >&2; exit 1 ;; esac
mkdir -p "$root"
curl -fsSL '${base}/manifest' -o "$root/manifest.json"
curl -fsSL '${base}/bundle.tar.gz' -o "$root/bundle.tar.gz"
case "$platform-$arch" in
 darwin-arm64) expected=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
 darwin-x64) expected=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
 linux-arm64) expected=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5 ;;
 linux-x64) expected=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff ;;
esac
archive="node-v${nodeVersion}-$platform-$arch.tar.gz"
curl -fsSL "https://nodejs.org/download/release/v${nodeVersion}/$archive" -o "$root/node.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$root/node.tar.gz" | cut -d ' ' -f 1); else actual=$(shasum -a 256 "$root/node.tar.gz" | cut -d ' ' -f 1); fi
[ "$actual" = "$expected" ] || { echo 'Node checksum mismatch' >&2; exit 1; }
tar -xzf "$root/node.tar.gz" -C "$root"
node="$root/node-v${nodeVersion}-$platform-$arch/bin/node"
"$node" -e 'const f=require("fs"),c=require("crypto"),r=process.argv[1],m=JSON.parse(f.readFileSync(r+"/manifest.json"));if(c.createHash("sha256").update(f.readFileSync(r+"/bundle.tar.gz")).digest("hex")!==m.sha256)throw Error("Host Agent checksum mismatch")' "$root"
tar -xzf "$root/bundle.tar.gz" -C "$root"
"$node" "$root/host-agent/install.mjs" '${base}'
`;
}
export function windowsInstaller(base: string) {
  // Run the installer in a clean process even when users pipe it into iex from an existing
  // terminal. Windows PowerShell 5.1 needs the BOM when it reads the downloaded .ps1 file.
  return `& {
$ErrorActionPreference='Stop'
$openmuseInstallerFile=Join-Path ([IO.Path]::GetTempPath()) ('openmuse-install-'+[Guid]::NewGuid()+'.ps1')
try {
 $openmuseInstallerContent=(Microsoft.PowerShell.Utility\\Invoke-WebRequest -UseBasicParsing '${base}/install.ps1?worker=1').Content
 [IO.File]::WriteAllText($openmuseInstallerFile,$openmuseInstallerContent,[Text.UTF8Encoding]::new($true))
 $openmusePowerShell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
 $openmuseNativePowerShell=Join-Path $env:SystemRoot 'Sysnative/WindowsPowerShell/v1.0/powershell.exe'
 if ([IO.File]::Exists($openmuseNativePowerShell)) { $openmusePowerShell=$openmuseNativePowerShell }
 & $openmusePowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $openmuseInstallerFile
 if ($LASTEXITCODE -ne 0) { throw 'Host Agent 설치 실패: 위 오류와 C:\\ProgramData\\OpenMuseHostAgent\\install.log를 확인하세요.' }
} finally {
 if ([IO.File]::Exists($openmuseInstallerFile)) { [IO.File]::Delete($openmuseInstallerFile) }
}
}
`;
}
export function windowsInstallerWorker(base: string) {
  return `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$invitation='${base}'
$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
 Write-Host '관리자 인증 후 설치합니다. 완료될 때까지 기다려 주세요.'
 $elevated=Start-Process (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'))
 if ($elevated.ExitCode -ne 0) { throw '관리자 설치 실패: C:\\ProgramData\\OpenMuseHostAgent\\install.log를 확인하세요.' }
 return
}
$agentRoot=Join-Path $env:ProgramData 'OpenMuseHostAgent'
New-Item -ItemType Directory -Path $agentRoot -Force | Out-Null
& icacls.exe $agentRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '설치 폴더 권한 설정 실패' }
Start-Transcript -Path (Join-Path $agentRoot 'install.log') -Append | Out-Null
try {
$manifest=Invoke-RestMethod ($invitation+'/manifest')
$bundle=Join-Path $agentRoot 'bundle.tar.gz'
Invoke-WebRequest -UseBasicParsing ($invitation+'/bundle.tar.gz') -OutFile $bundle
$bundleHash=[string](Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $bundle).Hash
if ($bundleHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Host Agent 체크섬을 읽지 못했습니다.' }
if ($bundleHash -ine $manifest.sha256) { throw 'Host Agent checksum mismatch' }
$nativeArchitecture=[string][Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if (-not $nativeArchitecture) { $nativeArchitecture=if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE } }
$architecture=switch ($nativeArchitecture) { 'Arm64' {'arm64'} 'X64' {'x64'} 'AMD64' {'x64'} default { throw '지원하지 않는 Windows 아키텍처입니다. x64 또는 ARM64가 필요합니다.' } }
$expected=if ($architecture -eq 'arm64') {'8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921'} else {'158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'}
$nodeArchive=Join-Path $agentRoot 'node.zip'
Invoke-WebRequest -UseBasicParsing ('https://nodejs.org/download/release/v${nodeVersion}/node-v${nodeVersion}-win-'+$architecture+'.zip') -OutFile $nodeArchive
$nodeHash=[string](Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $nodeArchive).Hash
if ($nodeHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Node.js 체크섬을 읽지 못했습니다.' }
if ($nodeHash -ine $expected) { throw 'Node checksum mismatch' }
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $agentRoot -Force
& tar.exe -xzf $bundle -C $agentRoot
if ($LASTEXITCODE -ne 0) { throw 'Host Agent archive extraction failed' }
$node=Join-Path $agentRoot ('node-v${nodeVersion}-win-'+$architecture+'/node.exe')
& $node (Join-Path $agentRoot 'host-agent/install.mjs') $invitation
if ($LASTEXITCODE -ne 0) { throw 'Host Agent installation failed' }
} finally {
Stop-Transcript | Out-Null
}
`;
}
export function hostInstallerRoutes(db: Store, config: Config, connectors: ConnectorService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const archive = () =>
    readFile(
      import.meta.url.endsWith(".js")
        ? new URL(`../../../openmuse-host-agent-${version}.tar.gz`, import.meta.url)
        : resolve(`dist/openmuse-host-agent-${version}.tar.gz`),
    ).catch(() => {
      throw new AppError("Host Agent 설치 패키지가 준비되지 않았습니다", 503);
    });
  const invitation = async (ticket: string) => {
    if (!/^[a-f0-9]{64}$/.test(ticket)) throw new AppError("설치 링크가 올바르지 않습니다", 404);
    const v = await db.get<Invitation>("system", "host-install-invitations", hash(ticket));
    if (!v || v.used || v.expiresAt < Date.now())
      throw new AppError("설치 링크가 만료되었거나 사용됐습니다. 새 명령을 만드세요", 410);
    return v;
  };
  app.post("/invitations", async (c) => {
    const { name } = z
      .strictObject({ name: z.string().trim().min(1).max(120).default("새 호스트") })
      .parse(await c.req.json());
    await archive();
    const ticket = randomBytes(32).toString("hex"),
      expiresAt = Date.now() + 3600000;
    await db.put("system", "host-install-invitations", {
      id: hash(ticket),
      owner: c.get("owner"),
      name,
      expiresAt,
      used: false,
    });
    const base = `${new URL(config.publicUrl).origin}/api/host-agent/install/${ticket}`;
    return c.json({
      expiresAt,
      windows: `irm '${base}/install.ps1' | iex`,
      posix: `curl -fsSL '${base}/install.sh' | sh`,
      privileges: "Linux·macOS: root 서비스 · Windows: SYSTEM 관리자 작업",
      network:
        "Tailscale 주소를 우선 사용합니다. 서버에서 대상 호스트의 8791 포트에 접근할 수 있어야 합니다.",
    });
  });
  app.get("/install/:ticket/:file", async (c) => {
    await invitation(c.req.param("ticket"));
    const base = `${new URL(config.publicUrl).origin}/api/host-agent/install/${c.req.param("ticket")}`,
      file = c.req.param("file");
    if (file === "manifest") {
      const bytes = await archive();
      return c.json({ version, sha256: hash(bytes), nodeVersion });
    }
    if (file === "bundle.tar.gz") {
      c.header("Content-Type", "application/gzip");
      return c.body(await archive());
    }
    if (file === "install.sh") {
      c.header("Content-Type", "text/plain; charset=utf-8");
      return c.body(posixInstaller(base));
    }
    if (file === "install.ps1") {
      c.header("Content-Type", "text/plain; charset=utf-8");
      return c.body(
        c.req.query("worker") === "1" ? windowsInstallerWorker(base) : windowsInstaller(base),
      );
    }
    throw new AppError("Not found", 404);
  });
  app.post("/install/:ticket/enroll", async (c) => {
    const v = await invitation(c.req.param("ticket")),
      body = z
        .strictObject({
          baseUrl: z.url().max(2048),
          token: z.string().min(32).max(512),
          connectorId: z.uuid().optional(),
        })
        .parse(await c.req.json());
    const status = (await remoteHostAdapter().run(
      {
        config: { mode: "agent", platform: "linux", baseUrl: body.baseUrl, allowAgentShell: true },
        secrets: { token: body.token },
        timeoutMs: 10000,
      },
      "host_status",
      {},
    )) as { platform: string; hostname: string };
    if (
      !(await db.compareAndSwap(
        "system",
        "host-install-invitations",
        v.id,
        { used: false },
        { used: true },
      ))
    )
      throw new AppError("이미 사용된 설치 링크입니다", 409);
    const cfg = {
      mode: "agent",
      platform:
        status.platform === "darwin" ? "macos" : status.platform === "win32" ? "windows" : "linux",
      baseUrl: body.baseUrl,
      allowAgentShell: true,
    };
    const existing = body.connectorId ? await connectors.get(v.owner, body.connectorId) : null;
    if (existing && existing.provider !== "remote_host")
      throw new AppError("원격 호스트 연결 ID가 아닙니다", 409);
    const connection = existing
      ? await connectors.update(v.owner, existing.id, {
          config: cfg,
          secrets: { token: body.token },
        })
      : await connectors.create(v.owner, {
          provider: "remote_host",
          name: v.name === "새 호스트" ? status.hostname : v.name,
          config: cfg,
          secrets: { token: body.token },
        });
    await connectors.test(v.owner, connection.id);
    return c.json({ id: connection.id, name: connection.name });
  });
  return app;
}
