// Maps every exception to the §8.2 error envelope with §8.4 codes (5xx never leaks internals).
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import { DomainError } from "@aegispulse/ts-platform/errors";
import { toErrorResponse } from "@aegispulse/ts-platform/http";

interface ReplyLike {
  status(code: number): ReplyLike;
  send(body: unknown): unknown;
}

const NEST_STATUS_CODES: Readonly<Record<number, string>> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  413: "PAYLOAD_TOO_LARGE",
  422: "VALIDATION_ERROR",
  429: "RATE_LIMITED",
};

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<ReplyLike>();
    const error =
      exception instanceof HttpException && NEST_STATUS_CODES[exception.getStatus()] !== undefined
        ? new DomainError(NEST_STATUS_CODES[exception.getStatus()] ?? "BAD_REQUEST", exception.message)
        : exception;
    const { status, body } = toErrorResponse(error);
    void reply.status(status).send(body);
  }
}
