// Registry-backed feature routes: auth, tenants, users, service accounts, JWKS (Phase 2); entities, watchlists (Phase 3); files, events (Phases 5–6); dead letters (Phase 7); transactions (Phase 8).
import { Module } from "@nestjs/common";
import { AuthController } from "./auth/auth.controller.js";
import { EntitiesController } from "./entities/entities.controller.js";
import { EventsController } from "./events/events.controller.js";
import { FilesController } from "./files/files.controller.js";
import { DeadLettersController } from "./ops/dead-letters.controller.js";
import { TransactionsController } from "./transactions/transactions.controller.js";
import { AuditController } from "./audit/audit.controller.js";
import { ServiceAccountsController } from "./service-accounts/service-accounts.controller.js";
import { TenantsController } from "./tenants/tenants.controller.js";
import { UsersController } from "./users/users.controller.js";
import { WatchlistsController } from "./watchlists/watchlists.controller.js";
import { WebhookSourcesController } from "./webhook-sources/webhook-sources.controller.js";
import { WebhooksController } from "./webhooks/webhooks.controller.js";
import { WellKnownController } from "./well-known/well-known.controller.js";

@Module({
  controllers: [
    AuthController,
    TenantsController,
    UsersController,
    ServiceAccountsController,
    EntitiesController,
    WatchlistsController,
    WebhookSourcesController,
    WebhooksController,
    FilesController,
    EventsController,
    DeadLettersController,
    TransactionsController,
    AuditController,
    WellKnownController,
  ],
})
export class RegistryRoutesModule {}
