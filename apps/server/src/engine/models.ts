import { z } from "zod";
import {
  type ModelProfile,
  type ModelProvider,
  type ModelSelection,
  type ModelSnapshot,
  modelCapabilitySchema,
} from "../../../../packages/domain/src/agent.ts";
import { type Config, normalizeOllamaBaseUrl } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { discoveredCapabilities, discoveredModelId, OpenCodexCatalog } from "./model-discovery.ts";

const profileInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9._-]+$/),
  label: z.string().trim().min(1).max(120),
  model: z.string().trim().min(3).max(300),
  capabilities: z.array(modelCapabilitySchema).max(10).default(["chat", "tools"]),
  enabled: z.boolean().default(true),
});

function providerOf(model: string): ModelProvider {
  const provider = model.split(/[/:]/, 1)[0]?.toLowerCase();
  if (
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "google" ||
    provider === "opencodex" ||
    provider === "ollama"
  )
    return provider;
  throw new Error(`Unsupported provider in model "${model}"`);
}

/** Parse the server-owned public catalog. Provider credentials remain in server environment. */
export function parseModelCatalog(raw: string | undefined, fallback?: string): ModelProfile[] {
  let inputs: z.input<typeof profileInputSchema>[];
  if (raw?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("OPENMUSE_MODELS must be valid JSON");
    }
    inputs = z.array(profileInputSchema).max(100).parse(parsed);
  } else if (fallback?.trim()) {
    inputs = [
      {
        id: "default",
        label: fallback.trim(),
        model: fallback.trim(),
        capabilities: ["chat", "tools"],
        enabled: true,
      },
    ];
  } else inputs = [];
  const ids = new Set<string>();
  return inputs.map((input) => {
    const value = profileInputSchema.parse(input);
    if (ids.has(value.id)) throw new Error(`Duplicate model id "${value.id}" in OPENMUSE_MODELS`);
    ids.add(value.id);
    const provider = providerOf(value.model);
    return {
      ...value,
      provider,
      capabilities:
        provider === "ollama" && !value.capabilities.includes("coding")
          ? [...value.capabilities, "coding" as const]
          : value.capabilities,
      available: value.enabled,
      ...(value.enabled ? {} : { unavailableReason: "disabled" as const }),
    };
  });
}

function hasProviderCredential(config: Config, provider: ModelProvider) {
  if (provider === "openai") return Boolean(process.env.OPENAI_API_KEY);
  if (provider === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === "google")
    return Boolean(
      process.env.GOOGLE_API_KEY ??
        process.env.GEMINI_API_KEY ??
        process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    );
  if (provider === "ollama") return Boolean(normalizeOllamaBaseUrl(config.ollamaBaseUrl));
  return Boolean(config.openCodexBaseUrl && config.openCodexApiKey);
}

export class ModelRegistry {
  private readonly profiles: ModelProfile[];
  readonly discovery: OpenCodexCatalog;
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    now = Date.now,
  ) {
    this.discovery = new OpenCodexCatalog(db, config, now);
    this.profiles = (config.models ?? parseModelCatalog(undefined, config.model)).map((profile) => {
      const available = profile.enabled && hasProviderCredential(config, profile.provider);
      return {
        ...profile,
        available,
        ...(available
          ? { unavailableReason: undefined }
          : {
              unavailableReason: profile.enabled
                ? ("missing_credentials" as const)
                : ("disabled" as const),
            }),
      };
    });
  }
  list(): ModelProfile[] {
    const remote = this.discovery.catalog;
    if (!remote)
      return this.profiles.map((profile) => ({
        ...profile,
        capabilities: [...profile.capabilities],
      }));
    const byModel = new Map(remote.data.map((model) => [`opencodex/${model.id}`, model]));
    const configuredModels = new Set(
      this.profiles
        .filter((profile) => profile.provider === "opencodex")
        .map((profile) => profile.model.replace(/^opencodex:/, "opencodex/")),
    );
    const configuredIds = new Set(this.profiles.map((profile) => profile.id));
    const configured = this.profiles.map((profile) => {
      if (profile.provider !== "opencodex") return profile;
      const model = byModel.get(profile.model.replace(/^opencodex:/, "opencodex/"));
      if (!profile.enabled) return profile;
      return model
        ? {
            ...profile,
            capabilities: [
              ...new Set([
                ...profile.capabilities,
                ...(discoveredCapabilities(model).includes("vision") ? ["vision" as const] : []),
              ]),
            ].filter((capability) => discoveredCapabilities(model).includes(capability)),
            available: true,
            unavailableReason: undefined,
          }
        : { ...profile, available: false, unavailableReason: "provider_removed" as const };
    });
    const discovered: ModelProfile[] = remote.data
      .filter((model) => !configuredModels.has(`opencodex/${model.id}`))
      .map((model) => {
        let id = discoveredModelId(model.id);
        while (configuredIds.has(id)) id = discoveredModelId(id);
        return {
          id,
          label: model.id,
          model: `opencodex/${model.id}`,
          provider: "opencodex",
          capabilities: discoveredCapabilities(model),
          available: true,
          enabled: true,
        };
      });
    return [...configured, ...discovered].map((profile) => ({
      ...profile,
      capabilities: [...profile.capabilities],
    }));
  }
  require(id: string): ModelProfile {
    const profile = this.list().find((candidate) => candidate.id === id && candidate.enabled);
    if (!profile) throw new AppError("Model is not configured or enabled on this server", 422);
    if (profile.unavailableReason === "provider_removed")
      throw new AppError("이 모델은 현재 OpenCodex 목록에 없습니다. 다른 모델을 선택하세요.", 422);
    if (!profile.available)
      throw new AppError("The model's server-side provider credential is not configured", 422);
    return profile;
  }
  fromSnapshot(snapshot: ModelSnapshot): ModelProfile {
    const available = hasProviderCredential(this.config, snapshot.provider);
    if (!available)
      throw new AppError("The model's server-side provider credential is not configured", 422);
    return { ...snapshot, enabled: true, available: true };
  }
  defaultProfile(): ModelProfile | null {
    return this.list().find((profile) => profile.available) ?? null;
  }
  async selection(owner: string): Promise<ModelSelection> {
    await this.discovery.refresh();
    const saved = await this.db.get<ModelSelection>(owner, "model-settings", "default");
    if (saved?.modelId === null) return saved;
    if (
      saved?.modelId &&
      this.list().some((profile) => profile.id === saved.modelId && profile.available)
    )
      return saved;
    return {
      id: "default",
      modelId: this.defaultProfile()?.id ?? null,
      updatedAt: saved?.updatedAt ?? new Date(0).toISOString(),
    };
  }
  async select(owner: string, modelId: string | null): Promise<ModelSelection> {
    await this.discovery.refresh();
    if (modelId !== null) this.require(modelId);
    return this.db.put(owner, "model-settings", {
      id: "default",
      modelId,
      updatedAt: new Date().toISOString(),
    });
  }
  async resolve(owner: string, requested?: string): Promise<ModelProfile | null> {
    await this.discovery.refresh();
    if (requested) return this.require(requested);
    const selected = await this.selection(owner);
    return selected.modelId ? this.require(selected.modelId) : null;
  }
}
