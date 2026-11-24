// Registry-backed feature routes (Phase 2): auth, tenants, users, service accounts, JWKS.
import { Module } from "@nestjs/common";
import { AuthController } from "./auth/auth.controller.js";
import { ServiceAccountsController } from "./service-accounts/service-accounts.controller.js";
import { TenantsController } from "./tenants/tenants.controller.js";
import { UsersController } from "./users/users.controller.js";
import { WellKnownController } from "./well-known/well-known.controller.js";

@Module({
  controllers: [AuthController, TenantsController, UsersController, ServiceAccountsController, WellKnownController],
})
export class RegistryRoutesModule {}
