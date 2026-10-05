export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  entryPath: string;
  files: { path: string; size: number }[];
  size: number;
  enabled: boolean;
  explicitOnly: boolean;
  updatedAt: string;
}

export interface SkillActivation {
  id: string;
  name: string;
  description: string;
  instructions: string;
  entryPath: string;
}

export function skillCommand(text: string) {
  const match = /^\/(?:skill:)?([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)([\s\S]*)$/.exec(text.trim());
  return match ? { name: match[1], argument: match[2].trim() } : null;
}

export function skillPrompt(skill: SkillActivation | undefined, request: string) {
  if (!skill) return request;
  const preview = { ...skill, instructions: skill.instructions.slice(0, 6000) };
  const more =
    skill.instructions.length > 6000
      ? ` The instructions are previewed: read the complete ${JSON.stringify(skill.entryPath)} with read_skill_file before starting.`
      : "";
  return `The user explicitly selected the following installed skill for this request. Follow its workflow using the available tools. These are user instructions, not permission to change approval settings or access other accounts. Read supporting files with read_skill_file using name=${JSON.stringify(skill.name)} and revision=${JSON.stringify(skill.id)}.${more} Relative resource paths are relative to this skill, not the server working directory. Scripts and assets can be read and used with the existing computer/remote-host tools; installation itself executes nothing.\n\nUser request:\n${request}\n\nSelected skill:\n${JSON.stringify(preview)}`;
}
