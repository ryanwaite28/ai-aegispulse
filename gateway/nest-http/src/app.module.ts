// Root module: transport only (ADR-0002). Feature modules (auth, cases, events, files, …) arrive with their FRs.
import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { JwtVerifier } from "@aegispulse/ts-platform/auth";
import type { HealthRegistry } from "@aegispulse/ts-platform/health";
import { CONFIG, type Config, HEALTH, JWT_VERIFIER } from "./config.js";
import { ErrorEnvelopeFilter } from "./common/filters/error-envelope.filter.js";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard.js";
import { HealthModule } from "./modules/health/health.module.js";
import { OpenApiModule } from "./modules/openapi/openapi.module.js";

@Module({})
export class AppModule {
  static register(deps: { config: Config; verifier: JwtVerifier; health: HealthRegistry }): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [HealthModule, OpenApiModule],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: JWT_VERIFIER, useValue: deps.verifier },
        { provide: HEALTH, useValue: deps.health },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
      ],
      exports: [CONFIG, JWT_VERIFIER, HEALTH],
    };
  }
}
