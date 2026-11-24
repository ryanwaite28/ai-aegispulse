// /.well-known/jwks.json (FR-AUTH-05): the registry's bare RFC 7517 set, passed through (not the §8.2 envelope).
import { Controller, Get, Inject, Res } from "@nestjs/common";
import { REGISTRY } from "../../config.js";
import type { RegistryClient } from "../../clients/registry.client.js";
import { Public } from "../../common/guards/jwt-auth.guard.js";

interface ReplyLike {
  header(name: string, value: string): ReplyLike;
  send(body: unknown): unknown;
}

@Public()
@Controller(".well-known")
export class WellKnownController {
  constructor(@Inject(REGISTRY) private readonly registry: RegistryClient) {}

  @Get("jwks.json")
  async jwks(@Res() reply: ReplyLike): Promise<void> {
    const { body, cacheControl } = await this.registry.jwks();
    void reply
      .header("content-type", "application/jwk-set+json")
      .header("cache-control", cacheControl ?? "public, max-age=600")
      .send(body);
  }
}
