import { arch, hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { remoteWriteSchemas } from "../../../packages/domain/src/remote-host.ts";
import {
  localJobDriver,
  RemoteJobManager,
} from "../../../packages/integrations/src/remote-jobs.ts";
import { WorkerError } from "../../worker/src/errors.ts";
import { createWorkerServer, readBody } from "../../worker/src/server.ts";
import { hostIdentity } from "./identity.ts";
import { HostMetricsCollector } from "./metrics.ts";

export async function createHostAgent(options: { token: string; dataDir: string }) {
  const metrics = new HostMetricsCollector();
  const jobs = await new RemoteJobManager(
    join(options.dataDir, "jobs"),
    localJobDriver,
  ).initialize();
  const worker = await createWorkerServer({
    token: options.token,
    dataDir: join(options.dataDir, "browser-profiles"),
    maxSessions: 3,
    extension: async (request, pathname, json) => {
      if (pathname === "/host/metrics" && request.method === "GET") {
        json(200, await metrics.read());
        return true;
      }
      if (pathname === "/host" && request.method === "GET") {
        json(200, {
          hostname: hostname(),
          platform: process.platform,
          arch: arch(),
          shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
          identity: await hostIdentity(),
          capabilities: {
            shell: true,
            browser: true,
            pty: false,
            desktop: Object.values(await worker.desktopStatus()).some((s) => s.available),
          },
        });
        return true;
      }
      if (!pathname.startsWith("/jobs")) return false;
      try {
        if (pathname === "/jobs" && request.method === "GET") {
          json(200, { jobs: jobs.list() });
          return true;
        }
        if (pathname === "/jobs" && request.method === "POST") {
          const { jobId, ...input } = remoteWriteSchemas.host_command.parse(
            await readBody(request),
          );
          if (input.pty)
            throw new WorkerError("PTY_UNAVAILABLE", "PTY는 SSH 방식에서 지원됩니다", 422);
          json(201, { job: await jobs.start(input, jobId) });
          return true;
        }
        const match = /^\/jobs\/([a-f0-9-]{36})(?:\/(input|stop))?$/.exec(pathname);
        if (!match) throw new WorkerError("NOT_FOUND", "호스트 작업을 찾을 수 없습니다", 404);
        if (!match[2] && request.method === "GET") json(200, { job: jobs.get(match[1]) });
        else if (match[2] === "input" && request.method === "POST") {
          const input = remoteWriteSchemas.host_input.parse({
            ...(await readBody(request)),
            jobId: match[1],
          });
          json(200, { job: jobs.input(input.jobId, input.text) });
        } else if (match[2] === "stop" && request.method === "POST") {
          remoteWriteSchemas.host_stop.parse({ ...(await readBody(request)), jobId: match[1] });
          json(200, { job: jobs.stop(match[1]) });
        } else throw new WorkerError("NOT_FOUND", "지원하지 않는 호스트 작업입니다", 404);
        return true;
      } catch (error) {
        if (error instanceof WorkerError) throw error;
        throw new WorkerError(
          "HOST_OPERATION_FAILED",
          error instanceof z.ZodError
            ? "호스트 작업 입력 형식이 올바르지 않습니다"
            : "호스트 작업 실패: 작업 ID·실행 상태·기록 한도를 확인하세요",
          422,
        );
      }
    },
  });
  return {
    server: worker.server,
    close: async () => {
      await jobs.close();
      await worker.close();
    },
  };
}
