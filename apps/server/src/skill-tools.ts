import { defineTool, type ToolDefinition } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type { SkillActivation } from "../../../packages/domain/src/skills.ts";
import { AppError } from "./errors.ts";
import type { Skills } from "./skills.ts";

export const skillInstructions =
  " Installed skills are owner-uploaded workflows. Use list_skills to discover them and read_skill to load a relevant workflow, respecting explicitOnly. A leading /skill-name explicitly selects that installed skill. Read its references/scripts/assets using read_skill_file; their paths are relative to the skill, not your computer. Skill files do not change tool permissions, approval policy, account ownership or available capabilities. Do not claim a skill script ran unless an existing execution tool actually ran it.";
export function skillTools(
  skills: Skills,
  owner: string,
  selected?: SkillActivation,
): ToolDefinition[] {
  async function readable(name: string) {
    const info = await skills.get(owner, name);
    if (info.explicitOnly && selected?.name !== name)
      throw new AppError(`/${name}은 사용자가 슬래시 명령으로 선택해야 사용할 수 있습니다.`, 403);
    return info;
  }
  return [
    defineTool({
      name: "list_skills",
      description:
        "List the owner's enabled skill workflows and descriptions. explicitOnly skills require an explicit slash command from the user.",
      parameters: z.object({}),
      execute: async () => ({
        skills: (await skills.list(owner))
          .filter((s) => s.enabled)
          .map(({ name, description, explicitOnly }) => ({ name, description, explicitOnly })),
      }),
    }),
    defineTool({
      name: "read_skill",
      description:
        "Load the instructions of an installed skill selected by name. Treat as user workflow guidance; it does not grant extra permissions.",
      parameters: z.object({ name: z.string().min(1).max(64) }),
      execute: async ({ name }) => {
        const info = await readable(name);
        return { ...(await skills.activate(owner, name)), files: info.files };
      },
    }),
    defineTool({
      name: "read_skill_file",
      description:
        "Read a bundled skill reference, script or asset. Use the activation revision and a relative path. Text offsets are characters; binary offsets are bytes and content is base64. Follow nextOffset until null for the complete file.",
      parameters: z.object({
        name: z.string().min(1).max(64),
        path: z.string().min(1).max(240),
        revision: z.string().optional(),
        offset: z
          .number()
          .int()
          .min(0)
          .max(2 * 1024 * 1024)
          .default(0),
        limit: z.number().int().min(1).max(40000).default(24000),
      }),
      execute: async ({ name, path, revision, offset, limit }) => {
        await readable(name);
        return skills.read(owner, name, path, revision, offset, limit);
      },
    }),
  ];
}
