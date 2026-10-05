import { Platform } from "react-native";

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ||
  (Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787")
).replace(/\/$/, "");

const sessionTokenKey = `openmuse.session.v1:${new URL(API_URL).origin}`;

/** Keep browser sessions within one tab and scoped to the configured API origin. */
export function readStoredSessionToken(): string | undefined {
  if (Platform.OS !== "web" || typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage.getItem(sessionTokenKey) || undefined;
  } catch {
    return undefined;
  }
}

export function storeSessionToken(token?: string) {
  if (Platform.OS !== "web" || typeof window === "undefined") return;
  try {
    if (token) window.sessionStorage.setItem(sessionTokenKey, token);
    else window.sessionStorage.removeItem(sessionTokenKey);
  } catch {
    // Keep the in-memory session usable when browser storage is unavailable.
  }
}

export class MuseApi {
  constructor(
    readonly token: string,
    private readonly onUnauthorized?: () => void,
  ) {}
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await fetch(`${API_URL}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      if (
        response.status === 401 &&
        (payload.error === "Sign in to OpenMuse" ||
          payload.error === "Session expired. Sign in again.")
      ) {
        storeSessionToken();
        this.onUnauthorized?.();
      }
      throw new Error(
        typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`,
      );
    }
    return payload;
  }
  url(path: string) {
    return path.startsWith("http") ? path : `${API_URL}${path}`;
  }
}

export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function createSession(
  accessKey?: string,
): Promise<{ token: string; mode: "sample" | "live" }> {
  const response = await fetch(`${API_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey }),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new SessionError(payload.error || "워크스페이스에 연결할 수 없습니다.", response.status);
  return payload;
}
