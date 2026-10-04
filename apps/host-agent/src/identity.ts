import { execFile } from "node:child_process";
import { userInfo } from "node:os";
export async function hostIdentity() {
  const username = userInfo().username;
  const elevated =
    process.platform === "win32"
      ? await new Promise<boolean>((resolve) => {
          execFile(
            "powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-Command",
              "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
            ],
            { windowsHide: true, timeout: 5000 },
            (error, stdout) => resolve(!error && stdout.trim() === "True"),
          );
        })
      : process.getuid?.() === 0;
  return {
    username,
    elevated,
    detail: elevated
      ? "관리자 권한으로 실행 중"
      : "일반 사용자 권한 · 관리자 설치로 전환하면 더 높은 권한을 사용할 수 있습니다",
  };
}
