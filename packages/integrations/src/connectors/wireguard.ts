import { execFile } from "node:child_process";
import {
  type ConnectorProviderInfo,
  wireguardConfigSchema,
} from "../../../domain/src/connectors.ts";
import { ConnectorError } from "./http.ts";
import type { ConnectorAdapter, ConnectorContext, ConnectorExec } from "./types.ts";

const DEFAULT_WG = "wg";
const EXEC_TIMEOUT_MS = 10000;

const execWg: ConnectorExec = (file, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    // execFile never spawns a shell; argv is fixed and cannot be influenced by
    // user input beyond the schema-validated interface name.
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const missing = "code" in error && error.code === "ENOENT";
          const detail = (stderr || error.message).replace(/\s+/g, " ").trim().slice(0, 300);
          reject(
            new ConnectorError(
              missing
                ? "WireGuard tools are not installed (wg not found)"
                : `wg failed${detail ? `: ${detail}` : ""}`,
              undefined,
              missing ? "unreachable" : "provider",
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

export interface WireguardPeer {
  publicKey: string;
  endpoint: string | null;
  allowedIps: string[];
  latestHandshake: number;
  latestHandshakeAt: string | null;
  transferRx: number;
  transferTx: number;
  persistentKeepalive: number | null;
}
export interface WireguardInterface {
  name: string;
  publicKey: string | null;
  listenPort: number;
  peers: WireguardPeer[];
}

/**
 * Parse `wg show <iface|all> dump`. The dump's interface lines carry the
 * private key in field two and peer lines carry the preshared key in field
 * three; both are dropped here and never reach the returned structure.
 */
export function parseWgDump(dump: string): WireguardInterface[] {
  const interfaces = new Map<string, WireguardInterface>();
  for (const raw of dump.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length === 5) {
      // name, private-key, public-key, listen-port, fwmark
      const [name, , publicKey, listenPort] = fields;
      if (!name || interfaces.has(name))
        throw new ConnectorError("wg output was malformed", undefined, "malformed");
      interfaces.set(name, {
        name,
        publicKey: publicKey === "(none)" ? null : publicKey,
        listenPort: Number(listenPort) || 0,
        peers: [],
      });
    } else if (fields.length === 9) {
      // name, public-key, preshared-key, endpoint, allowed-ips,
      // latest-handshake, transfer-rx, transfer-tx, persistent-keepalive
      const [name, publicKey, , endpoint, allowedIps, handshake, rx, tx, keepalive] = fields;
      const iface = interfaces.get(name);
      if (!iface || !publicKey)
        throw new ConnectorError("wg output was malformed", undefined, "malformed");
      const latestHandshake = Number(handshake) || 0;
      iface.peers.push({
        publicKey,
        endpoint: endpoint === "(none)" ? null : endpoint,
        allowedIps: allowedIps === "(none)" ? [] : allowedIps.split(","),
        latestHandshake,
        latestHandshakeAt:
          latestHandshake > 0 ? new Date(latestHandshake * 1000).toISOString() : null,
        transferRx: Number(rx) || 0,
        transferTx: Number(tx) || 0,
        persistentKeepalive: keepalive === "off" ? null : Number(keepalive) || null,
      });
    } else {
      throw new ConnectorError("wg output was malformed", undefined, "malformed");
    }
  }
  return [...interfaces.values()];
}

export function wireguardAdapter(exec: ConnectorExec = execWg): ConnectorAdapter {
  const info: ConnectorProviderInfo = {
    provider: "wireguard",
    label: "WireGuard",
    description:
      "Read local WireGuard interface and peer status via `wg show dump`. Private and preshared keys are never returned.",
    configFields: [
      {
        name: "wgPath",
        label: "wg executable path",
        required: false,
        description: "Defaults to `wg` on PATH.",
      },
      {
        name: "interface",
        label: "Interface",
        required: false,
        description: "Limit status to one interface such as wg0; defaults to all.",
      },
    ],
    secretFields: [],
    operations: [
      {
        name: "status",
        description:
          "Run `wg show dump` and return interfaces, listen ports and peer transfer/handshake status.",
        params: [],
      },
    ],
  };
  const dump = async (ctx: ConnectorContext) => {
    const config = wireguardConfigSchema.parse(ctx.config);
    const file = config.wgPath ?? DEFAULT_WG;
    const args = config.interface ? ["show", config.interface, "dump"] : ["show", "all", "dump"];
    const { stdout } = await exec(file, args, {
      timeoutMs: ctx.timeoutMs ?? EXEC_TIMEOUT_MS,
    });
    return parseWgDump(stdout);
  };
  return {
    info,
    async test(ctx) {
      try {
        const interfaces = await dump(ctx);
        return {
          ok: true,
          detail: `wg returned ${interfaces.length} interface${interfaces.length === 1 ? "" : "s"}`,
        };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : "WireGuard check failed",
        };
      }
    },
    async run(ctx, operation) {
      if (operation !== "status")
        throw new ConnectorError(
          `Unsupported WireGuard operation: ${operation}`,
          undefined,
          "malformed",
        );
      return { interfaces: await dump(ctx) };
    },
  };
}
