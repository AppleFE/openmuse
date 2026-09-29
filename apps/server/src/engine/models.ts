import { z } from "zod";
import {
  modelCapabilitySchema,
  type ModelProfile,
  type ModelProvider,
  type ModelSelection,
} from "../../../../packages/domain/src/agent.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

const profileInputSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._-]+$/),
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
    provider === "opencodex"
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
    return { ...value, provider: providerOf(value.model) };
  });
}

export class ModelRegistry {
  private readonly profiles: ModelProfile[];
  constructor(
    private readonly db: Store,
    config: Config,
  ) {
    this.profiles = config.models ?? parseModelCatalog(undefined, config.model);
  }
  list(): ModelProfile[] {
    return this.profiles.map((profile) => ({ ...profile, capabilities: [...profile.capabilities] }));
  }
  require(id: string): ModelProfile {
    const profile = this.profiles.find((candidate) => candidate.id === id && candidate.enabled);
    if (!profile) throw new AppError("Model is not configured or enabled on this server", 422);
    return profile;
  }
  defaultProfile(): ModelProfile | null {
    return this.profiles.find((profile) => profile.enabled) ?? null;
  }
  async selection(owner: string): Promise<ModelSelection> {
    const saved = await this.db.get<ModelSelection>(owner, "model-settings", "default");
    if (saved?.modelId === null) return saved;
    if (saved?.modelId && this.profiles.some((profile) => profile.id === saved.modelId && profile.enabled))
      return saved;
    return {
      id: "default",
      modelId: this.defaultProfile()?.id ?? null,
      updatedAt: saved?.updatedAt ?? new Date(0).toISOString(),
    };
  }
  async select(owner: string, modelId: string | null): Promise<ModelSelection> {
    if (modelId !== null) this.require(modelId);
    return this.db.put(owner, "model-settings", {
      id: "default",
      modelId,
      updatedAt: new Date().toISOString(),
    });
  }
  async resolve(owner: string, requested?: string): Promise<ModelProfile | null> {
    if (requested) return this.require(requested);
    const selected = await this.selection(owner);
    return selected.modelId ? this.require(selected.modelId) : null;
  }
}
