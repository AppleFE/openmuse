export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function resolveTheme(
  preference: ThemePreference,
  systemScheme: "light" | "dark" | null | undefined,
): ResolvedTheme {
  return preference === "system" ? (systemScheme === "dark" ? "dark" : "light") : preference;
}
