// Registry-backed feature routes: auth, tenants, users, service accounts, JWKS (Phase 2); entities, watchlists (Phase 3).
import { Module } from "@nestjs/common";
import { AuthController } from "./auth/auth.controller.js";
import { EntitiesController } from "./entities/entities.controller.js";
import { FilesController } from "./files/files.controller.js";
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
    WellKnownController,
  ],
})
export class RegistryRoutesModule {}
