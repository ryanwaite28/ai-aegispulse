// Probes (NFR-11). The gateway has no datastore; readiness covers its own process state only.
import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { HealthRegistry } from "@aegispulse/ts-platform/health";
import { HEALTH } from "../../config.js";
import { Public } from "../../common/guards/jwt-auth.guard.js";

interface ReplyLike {
  status(code: number): ReplyLike;
  send(body: unknown): unknown;
}

@Public()
@Controller()
export class HealthController {
  constructor(@Inject(HEALTH) private readonly health: HealthRegistry) {}

  @Get("livez")
  livez(): { status: "ok" } {
    return this.health.livez();
  }

  @Get("readyz")
  async readyz(@Res() reply: ReplyLike): Promise<void> {
    const r = await this.health.readyz();
    void reply.status(r.ready ? 200 : 503).send(r);
  }

  @Get("healthz")
  async healthz(@Res() reply: ReplyLike): Promise<void> {
    await this.readyz(reply);
  }
}
