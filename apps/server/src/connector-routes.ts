import { Hono } from "hono";
import { z } from "zod";
import { connectorQuerySchema } from "../../../packages/domain/src/connectors.ts";
import { remoteCommandSchema } from "../../../packages/domain/src/remote-host.ts";
import { probeSshFingerprint } from "../../../packages/integrations/src/connectors/remote-host.ts";
import type { ConnectorService } from "./connector-service.ts";

/**
 * Connector management API, mounted under /api/connectors by the core app.
 * All routes require the session middleware's `owner`; provider secrets are
 * write-only and never leave these handlers.
 */
export function connectorRoutes(service: ConnectorService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/providers", (c) => c.json({ providers: service.providers() }));
  app.post("/ssh-fingerprint", async (c) => {
    const input = z
      .strictObject({
        host: z.string().regex(/^[a-zA-Z0-9.:[\]_-]{1,253}$/),
        port: z.number().int().min(1).max(65535).default(22),
      })
      .parse(await c.req.json());
    return c.json({ fingerprint: await probeSshFingerprint(input.host, input.port) });
  });
  app.get("/", async (c) => c.json({ connectors: await service.list(c.get("owner")) }));
  app.post("/", async (c) => c.json(await service.create(c.get("owner"), await c.req.json()), 201));
  app.get("/:id", async (c) => c.json(await service.get(c.get("owner"), c.req.param("id"))));
  app.get("/:id/operations", async (c) =>
    c.json(await service.operations(c.get("owner"), c.req.param("id"))),
  );
  app.patch("/:id", async (c) =>
    c.json(await service.update(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.delete("/:id", async (c) => {
    await service.remove(c.get("owner"), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/:id/test", async (c) =>
    c.json(await service.test(c.get("owner"), c.req.param("id"), c.req.raw.signal)),
  );
  app.post("/:id/query", async (c) => {
    const body = connectorQuerySchema.parse(await c.req.json());
    return c.json({
      data: await service.run(
        c.get("owner"),
        c.req.param("id"),
        body.operation,
        body.params,
        c.req.raw.signal,
      ),
    });
  });
  app.post("/:id/host-command", async (c) => {
    const { operationId, ...command } = remoteCommandSchema
      .extend({ operationId: z.uuid() })
      .parse(await c.req.json());
    return c.json(
      await service.executeHostCommand(c.get("owner"), c.req.param("id"), command, operationId),
    );
  });
  return app;
}
