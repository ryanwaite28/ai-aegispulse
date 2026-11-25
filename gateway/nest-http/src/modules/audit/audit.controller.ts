// /v1/audit* (FR-AUD-03): transport only. Query values pass through (limit and seq bounds as integers); cases checks
// the roles (COMPLIANCE_AUDITOR, TENANT_ADMIN for the list; COMPLIANCE_AUDITOR for verify), scopes the tenant and
// recomputes the chain. A broken chain is a 200 with valid=false (never an error).
import { Controller, Get, Headers, Inject, Query } from "@nestjs/common";
import { DomainError } from "@aegispulse/ts-platform/errors";
import { CASES } from "../../config.js";
import type { CasesClient, CasesSchemas } from "../../clients/cases.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, pageQuery } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;

function seq(value: unknown, field: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = typeof value === "string" && /^[0-9]{1,18}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new DomainError("VALIDATION_ERROR", "request failed validation", {
      details: [{ field, message: "must be a positive integer" }],
    });
  }
  return n;
}

@Controller("v1/audit")
export class AuditController {
  constructor(@Inject(CASES) private readonly cases: CasesClient) {}

  @Operation("listAuditEntries")
  @Get()
  async list(
    @Headers() headers: H,
    @Query() query: Record<string, unknown>,
  ): Promise<Success<CasesSchemas["AuditEntry"][]>> {
    const r = await this.cases.call<"listAuditEntries", CasesSchemas["AuditEntry"][]>(
      "listAuditEntries",
      pageQuery(query) as CasesSchemas["ListAuditQuery"],
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data, r.meta.nextCursor);
  }

  /** Static segment: declared before any parameterized route. */
  @Operation("verifyAuditChain")
  @Get("verify")
  async verify(
    @Headers() headers: H,
    @Query("fromSeq") fromSeq: unknown,
    @Query("toSeq") toSeq: unknown,
  ): Promise<Success<CasesSchemas["AuditChainVerification"]>> {
    const from = seq(fromSeq, "fromSeq");
    const to = seq(toSeq, "toSeq");
    const r = await this.cases.call<"verifyAuditChain", CasesSchemas["AuditChainVerification"]>(
      "verifyAuditChain",
      { ...(from === undefined ? {} : { fromSeq: from }), ...(to === undefined ? {} : { toSeq: to }) },
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data);
  }
}
