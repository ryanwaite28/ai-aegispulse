// /v1/events* reads (FR-EVT-04/05): transport only. Query values are passed through as strings except `limit`; the
// events service validates them (422) and decides who may read the restricted tier.
import { Body, Controller, Get, Headers, Inject, Param, Patch, Query } from "@nestjs/common";
import { DomainError } from "@aegispulse/ts-platform/errors";
import { EVENTS } from "../../config.js";
import type { EventsClient, EventsSchemas } from "../../clients/events.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody, pageQuery, uuidParam } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,200}$/;

@Controller("v1/events")
export class EventsController {
  constructor(@Inject(EVENTS) private readonly events: EventsClient) {}

  @Operation("searchEvents")
  @Get()
  async search(
    @Headers() headers: H,
    @Query() query: Record<string, unknown>,
  ): Promise<Success<EventsSchemas["EventSummary"][]>> {
    const r = await this.events.call<"searchEvents", EventsSchemas["EventSummary"][]>(
      "searchEvents",
      pageQuery(query) as EventsSchemas["SearchEventsQuery"],
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data, r.meta.nextCursor);
  }

  /** Static segment: declared before `:eventId` and matched first by the router. */
  @Operation("getEventCorrelationChain")
  @Get("correlation/:correlationId")
  async chain(
    @Headers() headers: H,
    @Param("correlationId") correlationId: string,
  ): Promise<Success<EventsSchemas["EventSummary"][]>> {
    if (!CORRELATION_ID.test(correlationId)) throw new DomainError("NOT_FOUND", "not found");
    const r = await this.events.call<"getCorrelationChain", EventsSchemas["EventSummary"][]>(
      "getCorrelationChain",
      { correlationId },
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data);
  }

  @Operation("getEvent")
  @Get(":eventId")
  async get(
    @Headers() headers: H,
    @Param("eventId") eventId: string,
    @Query("tier") tier: string | undefined,
  ): Promise<Success<EventsSchemas["ArchivedEvent"]>> {
    if (tier !== undefined && tier !== "standard" && tier !== "restricted") {
      throw new DomainError("VALIDATION_ERROR", "request failed validation", {
        details: [{ field: "tier", message: "standard or restricted" }],
      });
    }
    const r = await this.events.call<"getEvent", EventsSchemas["ArchivedEvent"]>(
      "getEvent",
      { eventId: uuidParam(eventId, "eventId"), ...(tier === undefined ? {} : { tier }) },
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data);
  }

  /** FR-CLS-07: ANALYST+ override with a justification (the events service enforces every rule). */
  @Operation("overrideEventClassification")
  @Patch(":eventId/classification")
  async override(
    @Headers() headers: H,
    @Param("eventId") eventId: string,
    @Body() body: unknown,
  ): Promise<Success<EventsSchemas["ArchivedEvent"]>> {
    const r = await this.events.call<"overrideClassification", EventsSchemas["ArchivedEvent"]>(
      "overrideClassification",
      {
        ...(objectBody(body) as Omit<EventsSchemas["OverrideClassificationInput"], "eventId">),
        eventId: uuidParam(eventId, "eventId"),
      },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }
}
