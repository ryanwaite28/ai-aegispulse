// /v1/watchlists* (FR-ENT-04): parse → one registry action → map.
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { REGISTRY } from "../../config.js";
import type { RegistryClient, RegistrySchemas } from "../../clients/registry.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody, pageQuery, uuidParam } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;
type Watchlist = RegistrySchemas["Watchlist"];

@Controller("v1/watchlists")
export class WatchlistsController {
  constructor(@Inject(REGISTRY) private readonly registry: RegistryClient) {}

  @Operation("listWatchlists")
  @Get()
  async list(@Headers() headers: H, @Query() query: Record<string, unknown>): Promise<Success<Watchlist[]>> {
    const r = await this.registry.call<"listWatchlists", Watchlist[]>(
      "listWatchlists",
      pageQuery(query) as RegistrySchemas["ListWatchlistsQuery"],
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data, r.meta.nextCursor);
  }

  @Operation("createWatchlist")
  @Post()
  @HttpCode(201)
  async create(@Headers() headers: H, @Body() body: unknown): Promise<Success<Watchlist>> {
    const r = await this.registry.call<"createWatchlist", Watchlist>(
      "createWatchlist",
      objectBody(body) as RegistrySchemas["CreateWatchlistInput"],
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("updateWatchlist")
  @Patch(":id")
  async update(@Headers() headers: H, @Param("id") id: string, @Body() body: unknown): Promise<Success<Watchlist>> {
    const r = await this.registry.call<"updateWatchlist", Watchlist>(
      "updateWatchlist",
      {
        ...(objectBody(body) as Omit<RegistrySchemas["UpdateWatchlistInput"], "watchlistId">),
        watchlistId: uuidParam(id, "id"),
      },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("deleteWatchlist")
  @Delete(":id")
  async remove(@Headers() headers: H, @Param("id") id: string): Promise<Success<unknown>> {
    const r = await this.registry.call(
      "deleteWatchlist",
      { watchlistId: uuidParam(id, "id") },
      forwardFrom(headers, { idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("addWatchlistEntry")
  @Post(":id/entries")
  @HttpCode(201)
  async addEntry(
    @Headers() headers: H,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<Success<RegistrySchemas["WatchlistEntry"]>> {
    const r = await this.registry.call<"addWatchlistEntry", RegistrySchemas["WatchlistEntry"]>(
      "addWatchlistEntry",
      {
        ...(objectBody(body) as Omit<RegistrySchemas["AddWatchlistEntryInput"], "watchlistId">),
        watchlistId: uuidParam(id, "id"),
      },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("removeWatchlistEntry")
  @Delete(":id/entries/:entityId")
  async removeEntry(
    @Headers() headers: H,
    @Param("id") id: string,
    @Param("entityId") entityId: string,
  ): Promise<Success<unknown>> {
    const r = await this.registry.call(
      "removeWatchlistEntry",
      { watchlistId: uuidParam(id, "id"), entityId: uuidParam(entityId, "entityId") },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }
}
