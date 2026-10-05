import {
  emptyMetrics,
  finiteMetric,
  type HostMetrics,
  hostMetricsSchema,
} from "../../domain/src/host-metrics.ts";
import type { RemoteHostConfig } from "../../domain/src/remote-host.ts";

// These scripts are constants: the read API cannot supply a command, path or shell argument.
const linux = String.raw`export LC_ALL=C
printf 'HOST\t%s\t%s\n' "$(hostname)" "$(uname -m)"
awk -F= '/^PRETTY_NAME=/ {gsub(/"/,"",$2); print "OS\t" $2}' /etc/os-release 2>/dev/null
awk '{print "UP\t" $1}' /proc/uptime
awk '/^cpu[0-9]* / {total=0; for(i=2;i<=9;i++) total+=$i; print "CPU\t" $1 "\t" total "\t" $5+$6}' /proc/stat
awk -F: '/model name|Hardware/ {gsub(/^[ \t]+/,"",$2); print "MODEL\t" $2; exit}' /proc/cpuinfo
awk '/^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):/ {gsub(/:/,"",$1); print "MEM\t" $1 "\t" $2*1024}' /proc/meminfo
df -kP -l 2>/dev/null | awk 'NR>1 && $1 ~ /^\/dev\// {mount=$6; for(i=7;i<=NF;i++) mount=mount " " $i; printf "DISK\t%s\t%.0f\t%.0f\t%.0f\t%s\n",$1,$2*1024,$3*1024,$4*1024,mount}'
for dev in /sys/block/*; do
  [ -e "$dev/device" ] || continue
  [ -r "$dev/stat" ] || continue
  awk '{printf "IO\t%.0f\t%.0f\n",$3*512,$7*512}' "$dev/stat"
done
awk -F'[: ]+' 'NR>2 {sub(/^[ \t]+/,""); n=split($0,a,/[: \t]+/); if(a[1]!="lo") printf "NET\t%s\t%s\t%s\n",a[1],a[2],a[10]}' /proc/net/dev
for bat in /sys/class/power_supply/*; do
  [ -r "$bat/type" ] || continue
  [ "$(cat "$bat/type")" = Battery ] || continue
  printf 'BAT\t%s\t%s\n' "$(cat "$bat/capacity" 2>/dev/null)" "$(cat "$bat/status" 2>/dev/null)"
done
printf 'END\n'
`;
const macos = String.raw`export LC_ALL=C
printf 'HOST\t%s\t%s\n' "$(hostname)" "$(uname -m)"
printf 'OS\tmacOS %s\n' "$(sw_vers -productVersion)"
printf 'MODEL\t%s\n' "$(sysctl -n machdep.cpu.brand_string)"
printf 'CORES\t%s\n' "$(sysctl -n hw.logicalcpu)"
sysctl -n kern.boottime | awk -v now="$(date +%s)" '{print "UP\t" now-$4}'
printf 'MEM\tMemTotal\t%s\n' "$(sysctl -n hw.memsize)"
vm_stat | awk 'NR==1 {p=$8+0} /Pages free:|Pages inactive:|Pages speculative:/ {v=$NF+0; a+=v*p} END {printf "MEM\tMemAvailable\t%.0f\n",a}'
df -kP 2>/dev/null | awk 'NR>1 && $1 ~ /^\/dev\// {mount=$6; for(i=7;i<=NF;i++) mount=mount " " $i; printf "DISK\t%s\t%.0f\t%.0f\t%.0f\t%s\n",$1,$2*1024,$3*1024,$4*1024,mount}'
ioreg -r -c IOBlockStorageDriver -w 0 | awk '/"Statistics"/ && /"Bytes \(Read\)"/ {r=$0; w=$0; sub(/.*"Bytes \(Read\)"=/,"",r); sub(/.*"Bytes \(Write\)"=/,"",w); printf "IO\t%.0f\t%.0f\n",r+0,w+0}'
netstat -ibn | awk 'NR==1 {for(i=1;i<=NF;i++){if($i=="Ibytes")rx=i;if($i=="Obytes")tx=i}} /<Link#/ && $1!="lo0" && rx && tx {printf "NET\t%s\t%s\t%s\n",$1,$rx,$tx}'
pmset -g batt | awk '/InternalBattery/ {for(i=1;i<=NF;i++) if($i ~ /%/) {p=$i+0; print "BAT\t" p "\t" ($0 ~ /discharging/ ? "Discharging" : $0 ~ /charging/ ? "Charging" : "Full")}}'
top -l 2 -s 1 -n 0 | awk '/CPU usage:/ {idle=$7+0} END {if(NR) print "LOAD\t" 100-idle}'
printf 'END\n'
`;
const windows = String.raw`
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$os=Get-CimInstance Win32_OperatingSystem
$cpu=Get-CimInstance Win32_Processor
if(!$os -or !$cpu){throw 'Host metrics unavailable: operating system or CPU query failed'}
$load=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
$io=Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
$net=@(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Select-Object -First 128)
$disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -First 128)
$bat=Get-CimInstance Win32_Battery | Select-Object -First 1
function metric($v){if($null -eq $v){return $null};return [double]$v}
$data=@{version=1;collectedAt=[DateTime]::UtcNow.ToString('o');hostname=$env:COMPUTERNAME;platform='win32';arch=$env:PROCESSOR_ARCHITECTURE;os=[string]$os.Caption;uptime=$null;warnings=@();cpu=@{model=[string](($cpu|Select-Object -First 1).Name);cores=[double](($cpu|Measure-Object NumberOfLogicalProcessors -Sum).Sum);percent=(metric $load.PercentProcessorTime)};memory=@{total=$null;available=$null;used=$null;swapTotal=$null;swapUsed=$null};disks=@();diskIO=@{readBytes=$null;writeBytes=$null;readBps=(metric $io.DiskReadBytesPersec);writeBps=(metric $io.DiskWriteBytesPersec)};network=@();energy=@{hasBattery=[bool]$bat;percent=(metric $bat.EstimatedChargeRemaining);charging=$null;acConnected=$null;watts=$null;source='unavailable';detail='Windows SSH does not provide system power in watts.'}}
if($os){$data.uptime=([DateTime]::Now-$os.LastBootUpTime).TotalSeconds;$data.memory.total=[double]$os.TotalVisibleMemorySize*1024;$data.memory.available=[double]$os.FreePhysicalMemory*1024;$data.memory.used=$data.memory.total-$data.memory.available}
$data.disks=@($disks|Where-Object {$_.Size -gt 0}|ForEach-Object {@{device=[string]$_.DeviceID;mount=[string]$_.DeviceID;type=[string]$_.FileSystem;total=[double]$_.Size;used=[double]($_.Size-$_.FreeSpace);available=[double]$_.FreeSpace}})
$data.network=@($net|ForEach-Object {@{name=[string]$_.Name;state='unknown';speedMbps=if($_.CurrentBandwidth){[double]$_.CurrentBandwidth/1000000}else{$null};rxBytes=$null;txBytes=$null;rxBps=(metric $_.BytesReceivedPersec);txBps=(metric $_.BytesSentPersec)}})
$data|ConvertTo-Json -Depth 8 -Compress
`;
export const hostMetricsScript = (platform: RemoteHostConfig["platform"]) =>
  ({ linux, macos, windows })[platform];
export function parseSshMetrics(
  platform: RemoteHostConfig["platform"],
  output: string,
): HostMetrics {
  if (platform === "windows") {
    const data = hostMetricsSchema.parse(JSON.parse(output));
    data.energy.detail = "Windows SSH는 표준 OS 조회로 실소비전력(W)을 제공하지 않습니다.";
    return data;
  }
  const data = emptyMetrics(platform === "macos" ? "darwin" : "linux"),
    memory = new Map<string, number>();
  if (!output.trimEnd().endsWith("END")) throw new Error("Incomplete host metrics");
  const number = (v?: string) => (v?.trim() ? finiteMetric(Number(v)) : null);
  const cores: { total: number; idle: number }[] = [];
  for (const line of output.trim().split(/\r?\n/)) {
    const [key, ...v] = line.split("\t");
    if (key === "HOST") {
      data.hostname = v[0];
      data.arch = v[1];
    }
    if (key === "OS") data.os = v[0] ?? "";
    if (key === "UP") data.uptime = number(v[0]);
    if (key === "MODEL") data.cpu.model = v[0] ?? "";
    if (key === "CORES") data.cpu.cores = number(v[0]) ?? 0;
    if (key === "LOAD") data.cpu.percent = number(v[0]);
    if (key === "CPU" && number(v[1]) !== null && number(v[2]) !== null) {
      const tick = { total: Number(v[1]), idle: Number(v[2]) };
      if (v[0] === "cpu") data.cpu.ticks = tick;
      else cores.push(tick);
    }
    if (key === "MEM" && number(v[1]) !== null) memory.set(v[0], Number(v[1]));
    if (key === "DISK" && [v[1], v[2], v[3]].every((v) => number(v) !== null))
      data.disks.push({
        device: v[0],
        total: Number(v[1]),
        used: Number(v[2]),
        available: Number(v[3]),
        mount: v[4],
        type: "",
      });
    if (key === "IO" && number(v[0]) !== null && number(v[1]) !== null) {
      data.diskIO.readBytes = (data.diskIO.readBytes ?? 0) + Number(v[0]);
      data.diskIO.writeBytes = (data.diskIO.writeBytes ?? 0) + Number(v[1]);
    }
    if (key === "NET")
      data.network.push({
        name: v[0],
        rxBytes: number(v[1]),
        txBytes: number(v[2]),
        rxBps: null,
        txBps: null,
        speedMbps: null,
        state: "unknown",
      });
    if (key === "BAT")
      Object.assign(data.energy, {
        hasBattery: true,
        percent: number(v[0]),
        charging: v[1] === "Charging",
        acConnected: v[1] !== "Discharging",
      });
  }
  if (cores.length) {
    data.cpu.cores = cores.length;
    data.cpu.perCore = cores;
  }
  const total = memory.get("MemTotal") ?? null,
    available = memory.get("MemAvailable") ?? null;
  data.memory = {
    total,
    available,
    used: total !== null && available !== null ? Math.max(0, total - available) : null,
    swapTotal: memory.get("SwapTotal") ?? null,
    swapUsed:
      memory.has("SwapTotal") && memory.has("SwapFree")
        ? Math.max(0, Number(memory.get("SwapTotal")) - Number(memory.get("SwapFree")))
        : null,
  };
  data.energy.detail =
    "SSH는 실소비전력(W)을 수집하지 않습니다. 지원 하드웨어와 관리자 Host Agent가 필요합니다.";
  if (!data.hostname || !data.cpu.cores || !data.memory.total)
    throw new Error("Missing host metrics");
  data.disks = data.disks.slice(0, 128);
  data.network = data.network.slice(0, 128);
  return hostMetricsSchema.parse(data);
}
