import http from "node:http";
import https from "node:https";

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code: "timeout" | "auth" | "provider" | "malformed" | "unreachable" = "provider",
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

/** Replace every occurrence of a stored secret (raw or URL-encoded) in provider output. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join("[redacted]");
  }
  return out;
}

export interface ConnectorHttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** TLS overrides for providers commonly fronted by self-signed certificates. */
  tls?: { ca?: string; rejectUnauthorized?: boolean };
  /** Secret values that must never appear in error messages. */
  secrets?: (string | undefined)[];
  maxBytes?: number;
}

/**
 * Minimal read-only JSON request on node:http/https so per-connection TLS
 * options (custom CA, self-signed Proxmox/Headscale endpoints) work without an
 * extra dependency. Enforces a response cap, a hard timeout, and redacts stored
 * secrets out of every error it raises.
 */
export function httpJson(url: string | URL, options: ConnectorHttpOptions = {}): Promise<unknown> {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15000;
  const secretList = options.secrets ?? [];
  let target: URL;
  try {
    target = typeof url === "string" ? new URL(url) : url;
  } catch {
    return Promise.reject(
      new ConnectorError("Connector endpoint URL is invalid", undefined, "malformed"),
    );
  }
  if (target.protocol !== "https:" && target.protocol !== "http:")
    return Promise.reject(
      new ConnectorError("Connector endpoints must use http or https", undefined, "malformed"),
    );
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: "GET",
        headers: { Accept: "application/json", ...options.headers },
        ca: options.tls?.ca,
        rejectUnauthorized: options.tls?.rejectUnauthorized,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy(
              new ConnectorError(
                "Provider response exceeded the size limit",
                undefined,
                "malformed",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            if (status === 401 || status === 403) {
              reject(
                new ConnectorError(
                  `Provider rejected the configured credentials (HTTP ${status})`,
                  status,
                  "auth",
                ),
              );
              return;
            }
            const detail = redact(body.slice(0, 300), secretList).replace(/\s+/g, " ").trim();
            reject(
              new ConnectorError(
                `Provider responded HTTP ${status}${detail ? `: ${detail}` : ""}`,
                status,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new ConnectorError("Provider returned malformed JSON", status, "malformed"));
          }
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(new ConnectorError("Provider did not respond in time", undefined, "timeout")),
    );
    request.on("error", (error) => {
      if (error instanceof ConnectorError) reject(error);
      else
        reject(
          new ConnectorError(
            `Provider is unreachable: ${redact(error.message, secretList)}`,
            undefined,
            "unreachable",
          ),
        );
    });
    request.end();
  });
}
