// Request body handling for the gateway (NFR-08, FR-WHK-02). Webhook bodies stay raw bytes up to 1 MiB: the HMAC is
// computed over them and malformed JSON must surface as 422 only *after* signature verification, so the gateway never
// parses them. Every other JSON route is parsed strictly here (malformed → 400) with the 256 KiB limit.
import type { HttpServer } from "@aegispulse/ts-platform/http";

export const WEBHOOK_PREFIX = "/webhooks/";
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;

export function installBodyParsing(app: HttpServer): void {
  app.addHook("onRoute", (route) => {
    if (route.url.startsWith(WEBHOOK_PREFIX)) route.bodyLimit = WEBHOOK_BODY_LIMIT;
  });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const raw = body as Buffer;
    if (request.url.startsWith(WEBHOOK_PREFIX)) {
      done(null, raw);
      return;
    }
    if (raw.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw.toString("utf8")) as unknown);
    } catch {
      const error = Object.assign(new Error("malformed JSON body"), { statusCode: 400 });
      done(error, undefined);
    }
  });
}
