import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";
import { parseStoredThreadSelections, storeThreadSelection } from "./thread-state";

const STORAGE_KEY = "openmuse.thread.selection";
const NATIVE_FILE = `${FileSystem.documentDirectory || ""}openmuse-thread-selection.json`;

async function readSelections() {
  if (Platform.OS === "web") {
    if (typeof localStorage === "undefined") return {};
    try {
      return parseStoredThreadSelections(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }
  try {
    return parseStoredThreadSelections(await FileSystem.readAsStringAsync(NATIVE_FILE));
  } catch {
    return {};
  }
}

export async function readStoredThreadId(runtimeUrl: string) {
  return (await readSelections())[runtimeUrl];
}

export async function writeStoredThreadId(runtimeUrl: string, threadId: string) {
  const serialized = JSON.stringify(
    storeThreadSelection(await readSelections(), runtimeUrl, threadId),
  );
  if (Platform.OS === "web") {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, serialized);
    } catch {
      // Restricted browser storage should not prevent the live selection from working.
    }
    return;
  }
  await FileSystem.writeAsStringAsync(NATIVE_FILE, serialized);
}
