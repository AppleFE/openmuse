import { createHash } from "node:crypto";
import { z } from "zod";
import type { ModelCapability, ModelCatalogStatus } from "../../../../packages/domain/src/agent.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";

const intervalMs = 60_000;
const modelSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(280)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject unsafe control characters in provider model IDs.
    .regex(/^[^\s\x00-\x1f\x7f]+$/),
  capabilities: z
    .object({
      supports_tool_use: z.boolean().optional(),
      supports_vision: z.boolean().optional(),
      input_modalities: z.array(z.string()).optional(),
    })
    .optional(),
});
const catalogSchema = z.object({ data: z.array(modelSchema).max(2000) });
type Catalog = z.infer<typeof catalogSchema>;
interface SavedCatalog {
  id: string;
  fingerprint: string;
  catalog: Catalog;
  syncedAt: string;
}

/** Only contacts the explicitly configured data endpoint, never a management API. */
export class OpenCodexCatalog {
  readonly enabled: boolean;
  catalog?: Catalog;
  private statusValue: ModelCatalogStatus;
  private pending?: Promise<void>;
  private restored = false;
  private lastAttempt = -Infinity;
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private closed = false;

  constructor(
    private db: Store,
    private config: Config,
    private now = Date.now,
  ) {
    this.enabled =
      config.openCodexModelDiscovery !== false &&
      Boolean(config.openCodexBaseUrl && config.openCodexApiKey);
    this.statusValue = {
      enabled: this.enabled,
      state: this.enabled ? "pending" : "disabled",
      refreshIntervalSeconds: intervalMs / 1000,
      modelCount: 0,
    };
  }
  status(): ModelCatalogStatus {
    return { ...this.statusValue };
  }
  start() {
    if (!this.enabled || this.timer || this.closed) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }
  async stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.pending;
  }
  async refresh(force = false) {
    if (!this.enabled || this.closed) return;
    if (this.pending) return this.pending;
    if (!force && this.now() - this.lastAttempt < intervalMs) return;
    this.lastAttempt = this.now();
    this.statusValue.lastAttemptAt = new Date(this.lastAttempt).toISOString();
    this.pending = this.load().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async load() {
    let failure = "OpenCodex 모델 목록을 불러오지 못했습니다. 연결 상태를 확인하세요.";
    try {
      const base = new URL(this.config.openCodexBaseUrl ?? "");
      if (
        !["http:", "https:"].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      )
        throw new Error("Invalid model endpoint");
      base.pathname = `${base.pathname.replace(/\/$/, "")}/models`;
      const fingerprint = createHash("sha256")
        .update(`${base.href}\0${this.config.openCodexApiKey}`)
        .digest("hex");
      if (!this.restored) {
        this.restored = true;
        const saved = await this.db.get<SavedCatalog>("system", "model-catalog", "opencodex");
        const parsed = catalogSchema.safeParse(saved?.catalog);
        if (saved?.fingerprint === fingerprint && parsed.success) {
          this.catalog = parsed.data;
          this.statusValue.lastSyncedAt = saved.syncedAt;
          this.statusValue.modelCount = parsed.data.data.length;
        }
      }
      this.controller = new AbortController();
      const response = await fetch(base, {
        headers: {
          Authorization: `Bearer ${this.config.openCodexApiKey}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(8000)]),
      });
      if (!response.ok) {
        failure = `OpenCodex 모델 목록 조회 실패 (HTTP ${response.status}). 연결 설정을 확인하세요.`;
        await response.body?.cancel();
        throw new Error("Provider error");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing model response");
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) throw new Error("Model catalog too large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const parsed = catalogSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const catalog = {
        data: [...new Map(parsed.data.map((model) => [model.id, model])).values()],
      };
      const syncedAt = new Date(this.now()).toISOString();
      await this.db.put<SavedCatalog>("system", "model-catalog", {
        id: "opencodex",
        fingerprint,
        catalog,
        syncedAt,
      });
      this.catalog = catalog;
      this.statusValue = {
        ...this.statusValue,
        state: "ready",
        lastSyncedAt: syncedAt,
        modelCount: catalog.data.length,
        error: undefined,
      };
    } catch {
      this.statusValue = { ...this.statusValue, state: "error", error: failure };
    } finally {
      this.controller = undefined;
    }
  }
}

export function discoveredModelId(id: string) {
  return `oc-${id.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60)}-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}
export function discoveredCapabilities(model: Catalog["data"][number]): ModelCapability[] {
  const result: ModelCapability[] = ["chat"];
  // Compatible gateways that omit metadata retain the existing tool-capable default.
  if (model.capabilities?.supports_tool_use !== false) result.push("tools", "coding");
  if (
    model.capabilities?.supports_vision ||
    model.capabilities?.input_modalities?.includes("image")
  )
    result.push("vision");
  return result;
}
