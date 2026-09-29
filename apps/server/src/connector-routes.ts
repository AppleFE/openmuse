import { Hono } from "hono";
import { connectorQuerySchema } from "../../../packages/domain/src/connectors.ts";
import type { ConnectorService } from "./connector-service.ts";

/**
 * Connector management API, mounted under /api/connectors by the core app.
 * All routes require the session middleware's `owner`; provider secrets are
 * write-only and never leave these handlers.
 */
export function connectorRoutes(service: ConnectorService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/providers", (c) => c.json({ providers: service.providers() }));
  app.get("/", async (c) => c.json({ connectors: await service.list(c.get("owner")) }));
  app.post("/", async (c) => c.json(await service.create(c.get("owner"), await c.req.json()), 201));
  app.get("/:id", async (c) => c.json(await service.get(c.get("owner"), c.req.param("id"))));
  app.patch("/:id", async (c) =>
    c.json(await service.update(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.delete("/:id", async (c) => {
    await service.remove(c.get("owner"), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/:id/test", async (c) => c.json(await service.test(c.get("owner"), c.req.param("id"))));
  app.post("/:id/query", async (c) => {
    const body = connectorQuerySchema.parse(await c.req.json());
    return c.json({
      data: await service.run(c.get("owner"), c.req.param("id"), body.operation, body.params),
    });
  });
  return app;
}
