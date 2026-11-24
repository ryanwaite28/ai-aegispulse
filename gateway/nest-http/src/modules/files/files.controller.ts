// /v1/files/uploads* (FR-FILE-01..04): transport only. The files service authorizes (contract roles, X-Aegis-Tenant
// for PLATFORM_ADMIN) and owns dedup, quotas, presigning and the lifecycle.
import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Res } from "@nestjs/common";
import { FILES } from "../../config.js";
import type { FilesClient, FilesSchemas } from "../../clients/files.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody, uuidParam } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;
/** The only reply capability used here (status code); avoids a direct fastify dependency. */
interface StatusReply {
  status(code: number): unknown;
}
type File = FilesSchemas["File"];

@Controller("v1/files")
export class FilesController {
  constructor(@Inject(FILES) private readonly files: FilesClient) {}

  /** 201 with a presigned PUT for a new upload; 200 with `deduplicated: true` and no URL for a dedup hit. */
  @Operation("initUpload")
  @Post("uploads/init")
  async init(
    @Headers() headers: H,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: StatusReply,
  ): Promise<Success<FilesSchemas["InitUploadResult"]>> {
    const r = await this.files.call<"initUpload", FilesSchemas["InitUploadResult"]>(
      "initUpload",
      objectBody(body) as FilesSchemas["InitUploadInput"],
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    res.status(r.data.deduplicated ? 200 : 201);
    return success(r.data);
  }

  @Operation("completeUpload")
  @Post("uploads/:fileId/complete")
  @HttpCode(200)
  async complete(
    @Headers() headers: H,
    @Param("fileId") fileId: string,
    @Body() body: unknown,
  ): Promise<Success<File>> {
    const parts = body === undefined || body === null ? {} : objectBody(body);
    const r = await this.files.call<"completeUpload", File>(
      "completeUpload",
      { ...(parts as Omit<FilesSchemas["CompleteUploadInput"], "fileId">), fileId: uuidParam(fileId, "fileId") },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("abortUpload")
  @Post("uploads/:fileId/abort")
  @HttpCode(200)
  async abort(@Headers() headers: H, @Param("fileId") fileId: string): Promise<Success<File>> {
    const r = await this.files.call<"abortUpload", File>(
      "abortUpload",
      { fileId: uuidParam(fileId, "fileId") },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }
}
