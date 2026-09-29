import assert from "node:assert/strict";
import test from "node:test";
import { isThemePreference, resolveTheme } from "../src/theme-core.ts";

test("explicit theme preferences override the system appearance", () => {
  assert.equal(resolveTheme("light", "dark"), "light");
  assert.equal(resolveTheme("dark", "light"), "dark");
});

test("system preference tracks dark and defaults safely to light", () => {
  assert.equal(resolveTheme("system", "dark"), "dark");
  assert.equal(resolveTheme("system", "light"), "light");
  assert.equal(resolveTheme("system", null), "light");
});

test("only supported values are accepted from persistence", () => {
  assert.equal(isThemePreference("system"), true);
  assert.equal(isThemePreference("dark"), true);
  assert.equal(isThemePreference("sepia"), false);
  assert.equal(isThemePreference(undefined), false);
});
