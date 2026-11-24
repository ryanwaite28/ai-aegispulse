// §8.2 success envelope with the gateway's own request/correlation ids (services' ids stay in their logs).
import { getContext } from "@aegispulse/ts-platform/logging";

export interface Success<T> {
  readonly data: T;
  readonly meta: { requestId?: string; correlationId?: string; nextCursor?: string };
}

export function success<T>(data: T, nextCursor?: string): Success<T> {
  const ctx = getContext();
  return {
    data,
    meta: {
      ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
      ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
  };
}
