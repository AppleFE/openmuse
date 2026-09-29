import * as FileSystem from "expo-file-system/legacy";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Appearance, Platform, useColorScheme } from "react-native";
import {
  isThemePreference,
  type ResolvedTheme,
  resolveTheme,
  type ThemePreference,
} from "./theme-core";

export type { ResolvedTheme, ThemePreference } from "./theme-core";

export type ThemeColors = {
  canvas: string;
  card: string;
  surface: string;
  surfaceRaised: string;
  surfaceMuted: string;
  text: string;
  muted: string;
  subtle: string;
  line: string;
  lineStrong: string;
  blue: string;
  blueDark: string;
  sky: string;
  green: string;
  lavender: string;
  orange: string;
  danger: string;
  dangerSurface: string;
  success: string;
  overlay: string;
  inverseText: string;
  shadow: string;
  input: string;
  code: string;
};

export const themePalettes: Record<ResolvedTheme, ThemeColors> = {
  light: {
    canvas: "#FCFCFC",
    card: "#FFFFFF",
    surface: "#FFFFFF",
    surfaceRaised: "#FFFFFF",
    surfaceMuted: "#F1F2F3",
    text: "#11191C",
    muted: "#697176",
    subtle: "#949B9F",
    line: "#EEEEF0",
    lineStrong: "#D8DBDE",
    blue: "#C8E7FF",
    blueDark: "#1473C8",
    sky: "#EDF7FD",
    green: "#E3F3E8",
    lavender: "#F0EEFA",
    orange: "#FDF0DF",
    danger: "#AA4A45",
    dangerSurface: "#FBEFED",
    success: "#248258",
    overlay: "rgba(35,48,44,0.25)",
    inverseText: "#FFFFFF",
    shadow: "#18384B",
    input: "#FFFFFF",
    code: "#E2E4E7",
  },
  dark: {
    canvas: "#0E1215",
    card: "#171C20",
    surface: "#171C20",
    surfaceRaised: "#20262B",
    surfaceMuted: "#242B30",
    text: "#F2F5F6",
    muted: "#A7B0B5",
    subtle: "#7E898F",
    line: "#2B3338",
    lineStrong: "#3B464D",
    blue: "#255D80",
    blueDark: "#72BFFF",
    sky: "#162B38",
    green: "#183429",
    lavender: "#29243B",
    orange: "#382A1C",
    danger: "#FF9B95",
    dangerSurface: "#3B2020",
    success: "#74D4A7",
    overlay: "rgba(0,0,0,0.72)",
    inverseText: "#0E1215",
    shadow: "#000000",
    input: "#151A1E",
    code: "#293137",
  },
};

let activePalette: ThemeColors = themePalettes.light;
export const colors = new Proxy({} as ThemeColors, {
  get: (_target, property: keyof ThemeColors) => activePalette[property],
});

const STORAGE_KEY = "openmuse.theme.preference";
const NATIVE_FILE = `${FileSystem.documentDirectory || ""}openmuse-theme.json`;

function webPreference(): ThemePreference {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return "system";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  colors: ThemeColors;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  resolved: "light",
  colors: themePalettes.light,
  setPreference: () => undefined,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme() || Appearance.getColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(webPreference);
  const [loaded, setLoaded] = useState(Platform.OS === "web");
  const resolved = resolveTheme(preference, systemScheme);
  activePalette = themePalettes[resolved];

  useEffect(() => {
    if (Platform.OS === "web") return;
    let active = true;
    void FileSystem.readAsStringAsync(NATIVE_FILE)
      .then((value) => JSON.parse(value) as { preference?: unknown })
      .then((value) => {
        if (active && isThemePreference(value.preference)) setPreferenceState(value.preference);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    if (Platform.OS === "web" && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Browsers can deny storage in private or restricted contexts; the live choice still works.
      }
    } else {
      void FileSystem.writeAsStringAsync(NATIVE_FILE, JSON.stringify({ preference: next })).catch(
        () => undefined,
      );
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    document.documentElement.style.colorScheme = resolved;
    document.documentElement.style.backgroundColor = themePalettes[resolved].canvas;
    document.body.style.backgroundColor = themePalettes[resolved].canvas;
  }, [resolved]);

  const value = useMemo(
    () => ({ preference, resolved, colors: themePalettes[resolved], setPreference }),
    [preference, resolved, setPreference],
  );
  return <ThemeContext.Provider value={value}>{loaded ? children : null}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
