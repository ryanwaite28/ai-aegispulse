// Sends a signed AEGIS_MARKET_EVENT_V1 webhook through the gateway (FR-WHK-02; Phase 4 exit evidence).
//   WEBHOOK_SECRET=<signing secret> node scripts/demo/webhook-sign.mts <sourceKey> [payload.json]
// The secret is read from the environment (never an argument, so it stays out of shell history and `ps`).
// Without a payload file a sample MARKET_ALERT is sent. Prints the HTTP status and the response body only.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const base = process.env["GATEWAY_URL"] ?? "http://127.0.0.1:8080";
const secret = process.env["WEBHOOK_SECRET"];
const [sourceKey, file] = process.argv.slice(2);
if (secret === undefined || secret === "" || sourceKey === undefined) {
  process.stderr.write(
    "usage: WEBHOOK_SECRET=<secret> node scripts/demo/webhook-sign.mts <sourceKey> [payload.json]\n",
  );
  process.exit(2);
}
const raw =
  file === undefined
    ? Buffer.from(
        JSON.stringify({
          externalId: `demo-${randomUUID()}`,
          category: "MARKET_ALERT",
          title: "Demo: unusual trading volume in ACMH",
          summary: "Synthetic alert sent by scripts/demo/webhook-sign.mts",
          publishedAt: new Date().toISOString(),
          severity: "HIGH",
          mentionedEntities: ["ACME Holdings"],
          tickers: ["ACMH"],
        }),
      )
    : readFileSync(file);
const timestamp = String(Math.floor(Date.now() / 1000));
const deliveryId = `demo-${randomUUID()}`;
const signature = createHmac("sha256", secret)
  .update(Buffer.concat([Buffer.from(`${timestamp}.${deliveryId}.`), raw]))
  .digest("hex");
const res = await fetch(`${base}/webhooks/${sourceKey}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-aegis-signature": `v1=${signature}`,
    "x-aegis-timestamp": timestamp,
    "x-aegis-delivery-id": deliveryId,
  },
  body: raw,
});
process.stdout.write(`${String(res.status)} ${await res.text()}\n`);
process.exit(res.status === 202 ? 0 : 1);
