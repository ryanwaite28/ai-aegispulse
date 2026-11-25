// Root module: transport only (ADR-0002). Feature modules arrive with their FRs; Phase 2 adds the registry routes.
import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { JwtVerifier } from "@aegispulse/ts-platform/auth";
import type { HealthRegistry } from "@aegispulse/ts-platform/health";
import { CASES, CONFIG, type Config, EVENTS, FILES, HEALTH, INGESTION, JWT_VERIFIER, REGISTRY } from "./config.js";
import type { CasesClient } from "./clients/cases.client.js";
import type { EventsClient } from "./clients/events.client.js";
import type { FilesClient } from "./clients/files.client.js";
import type { IngestionClient } from "./clients/ingestion.client.js";
import type { RegistryClient } from "./clients/registry.client.js";
import { ErrorEnvelopeFilter } from "./common/filters/error-envelope.filter.js";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard.js";
import { HealthModule } from "./modules/health/health.module.js";
import { OpenApiModule } from "./modules/openapi/openapi.module.js";
import { RegistryRoutesModule } from "./modules/registry.module.js";

@Module({})
export class AppModule {
  static register(deps: {
    config: Config;
    verifier: JwtVerifier;
    health: HealthRegistry;
    registry: RegistryClient;
    ingestion: IngestionClient;
    files: FilesClient;
    events: EventsClient;
    cases: CasesClient;
  }): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [HealthModule, OpenApiModule, RegistryRoutesModule],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: JWT_VERIFIER, useValue: deps.verifier },
        { provide: HEALTH, useValue: deps.health },
        { provide: REGISTRY, useValue: deps.registry },
        { provide: INGESTION, useValue: deps.ingestion },
        { provide: FILES, useValue: deps.files },
        { provide: EVENTS, useValue: deps.events },
        { provide: CASES, useValue: deps.cases },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
      ],
      exports: [CONFIG, JWT_VERIFIER, HEALTH, REGISTRY, INGESTION, FILES, EVENTS, CASES],
    };
  }
}
