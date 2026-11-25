// /v1/cases* (FR-CASE-05/06/07): transport only. Path ids are checked locally (malformed → 404); query filters and
// bodies pass through; cases checks roles and tenant scope, versions, four-eyes and every transition rule.
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { CASES } from "../../config.js";
import type { CasesClient, CasesSchemas } from "../../clients/cases.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody, pageQuery, uuidParam } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;

@Controller("v1/cases")
export class CasesController {
  constructor(@Inject(CASES) private readonly cases: CasesClient) {}

  @Operation("listCases")
  @Get()
  async list(@Headers() headers: H, @Query() query: Record<string, unknown>): Promise<Success<CasesSchemas["Case"][]>> {
    const r = await this.cases.call<"listCases", CasesSchemas["Case"][]>(
      "listCases",
      pageQuery(query) as CasesSchemas["ListCasesQuery"],
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data, r.meta.nextCursor);
  }

  @Operation("getCase")
  @Get(":caseId")
  async get(@Headers() headers: H, @Param("caseId") caseId: string): Promise<Success<CasesSchemas["CaseDetail"]>> {
    const r = await this.cases.call<"getCase", CasesSchemas["CaseDetail"]>(
      "getCase",
      { caseId: uuidParam(caseId, "caseId") },
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data);
  }

  @Operation("getCaseTimeline")
  @Get(":caseId/timeline")
  async timeline(
    @Headers() headers: H,
    @Param("caseId") caseId: string,
  ): Promise<Success<CasesSchemas["CaseTimeline"]>> {
    const r = await this.cases.call<"getCaseTimeline", CasesSchemas["CaseTimeline"]>(
      "getCaseTimeline",
      { caseId: uuidParam(caseId, "caseId") },
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data);
  }

  @Operation("assignCase")
  @Post(":caseId/assign")
  @HttpCode(200)
  async assign(
    @Headers() headers: H,
    @Param("caseId") caseId: string,
    @Body() body: unknown,
  ): Promise<Success<CasesSchemas["Case"]>> {
    const r = await this.cases.call<"assignCase", CasesSchemas["Case"]>(
      "assignCase",
      { ...(objectBody(body) as Omit<CasesSchemas["AssignCaseInput"], "caseId">), caseId: uuidParam(caseId, "caseId") },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("addCaseNote")
  @Post(":caseId/notes")
  @HttpCode(201)
  async note(
    @Headers() headers: H,
    @Param("caseId") caseId: string,
    @Body() body: unknown,
  ): Promise<Success<CasesSchemas["CaseNote"]>> {
    const r = await this.cases.call<"addCaseNote", CasesSchemas["CaseNote"]>(
      "addCaseNote",
      {
        ...(objectBody(body) as Omit<CasesSchemas["AddCaseNoteInput"], "caseId">),
        caseId: uuidParam(caseId, "caseId"),
      },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("recordDisposition")
  @Post(":caseId/dispositions")
  @HttpCode(201)
  async disposition(
    @Headers() headers: H,
    @Param("caseId") caseId: string,
    @Body() body: unknown,
  ): Promise<Success<CasesSchemas["DispositionResult"]>> {
    const r = await this.cases.call<"recordDisposition", CasesSchemas["DispositionResult"]>(
      "recordDisposition",
      {
        ...(objectBody(body) as Omit<CasesSchemas["RecordDispositionInput"], "caseId">),
        caseId: uuidParam(caseId, "caseId"),
      },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("requestCaseReevaluation")
  @Post(":caseId/reevaluate")
  @HttpCode(200)
  async reevaluate(
    @Headers() headers: H,
    @Param("caseId") caseId: string,
    @Body() body: unknown,
  ): Promise<Success<CasesSchemas["Case"]>> {
    const r = await this.cases.call<"requestReevaluation", CasesSchemas["Case"]>(
      "requestReevaluation",
      {
        ...(objectBody(body) as Omit<CasesSchemas["RequestReevaluationInput"], "caseId">),
        caseId: uuidParam(caseId, "caseId"),
      },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }
}
