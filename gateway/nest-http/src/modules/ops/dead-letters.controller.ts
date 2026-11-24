// /v1/ops/dead-letters* (FR-MSG-03): transport only. The events service decides visibility (PLATFORM_ADMIN all
// tenants, TENANT_ADMIN own tenant), validates filters (422) and performs replay/discard with their audit events.
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { DomainError } from "@aegispulse/ts-platform/errors";
import { EVENTS } from "../../config.js";
import type { EventsClient, EventsSchemas } from "../../clients/events.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody, pageQuery } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;
/** Registry ids are opaque to the gateway; anything outside this shape cannot exist (404 like an unknown id). */
const DEAD_LETTER_ID = /^[A-Za-z0-9]{1,64}$/;

function idParam(id: string): string {
  if (!DEAD_LETTER_ID.test(id)) throw new DomainError("DEAD_LETTER_NOT_FOUND", "dead letter not found");
  return id;
}

@Controller("v1/ops/dead-letters")
export class DeadLettersController {
  constructor(@Inject(EVENTS) private readonly events: EventsClient) {}

  @Operation("listDeadLetters")
  @Get()
  async list(
    @Headers() headers: H,
    @Query() query: Record<string, unknown>,
  ): Promise<Success<EventsSchemas["DeadLetterSummary"][]>> {
    const r = await this.events.call<"listDeadLetters", EventsSchemas["DeadLetterSummary"][]>(
      "listDeadLetters",
      pageQuery(query) as EventsSchemas["ListDeadLettersQuery"],
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data, r.meta.nextCursor);
  }

  @Operation("getDeadLetter")
  @Get(":id")
  async get(@Headers() headers: H, @Param("id") id: string): Promise<Success<EventsSchemas["DeadLetter"]>> {
    const r = await this.events.call<"getDeadLetter", EventsSchemas["DeadLetter"]>(
      "getDeadLetter",
      { deadLetterId: idParam(id) },
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data);
  }

  @Operation("replayDeadLetter")
  @Post(":id/replay")
  @HttpCode(200)
  async replay(@Headers() headers: H, @Param("id") id: string): Promise<Success<EventsSchemas["DeadLetter"]>> {
    const r = await this.events.call<"replayDeadLetter", EventsSchemas["DeadLetter"]>(
      "replayDeadLetter",
      { deadLetterId: idParam(id) },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("discardDeadLetter")
  @Post(":id/discard")
  @HttpCode(200)
  async discard(
    @Headers() headers: H,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<Success<EventsSchemas["DeadLetter"]>> {
    const r = await this.events.call<"discardDeadLetter", EventsSchemas["DeadLetter"]>(
      "discardDeadLetter",
      {
        ...(objectBody(body) as Omit<EventsSchemas["DiscardDeadLetterInput"], "deadLetterId">),
        deadLetterId: idParam(id),
      },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }
}
