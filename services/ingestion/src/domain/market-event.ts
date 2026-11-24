// Payload profile AEGIS_MARKET_EVENT_V1 (FR-WHK-04; gateway.public.yaml MarketEventV1). Unknown extra fields are
// tolerated (the contract does not reject them); everything listed is validated. Pure.
import { z } from "zod";

export const CATEGORIES = [
  "REGULATION_PUBLISHED",
  "IPO_FILED",
  "ACQUISITION_ANNOUNCED",
  "MARKET_ALERT",
  "COMPLIANCE_DISCLOSURE",
] as const;
export type Category = (typeof CATEGORIES)[number];

const httpsUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\//)
  .refine((u) => URL.canParse(u), "must be a URL");

export const marketEventV1 = z.looseObject({
  externalId: z.string().min(1).max(128),
  category: z.enum(CATEGORIES),
  title: z.string().min(1).max(500),
  summary: z.string().max(4000).optional(),
  body: z.string().max(65536).optional(),
  publishedAt: z.iso.datetime({ offset: true }),
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  url: httpsUrl.optional(),
  mentionedEntities: z.array(z.string().min(1)).max(50).optional(),
  tickers: z.array(z.string().min(1)).optional(),
  attachments: z
    .array(
      z.strictObject({
        url: httpsUrl,
        filename: z.string().min(1).max(255),
        contentType: z.string().min(1),
      }),
    )
    .max(5)
    .optional(),
  version: z.number().int().min(1).default(1),
});
export type MarketEventV1 = z.output<typeof marketEventV1>;

/** FR-WHK-05 category → routing key. */
export const EVENT_TYPE: Readonly<Record<Category, string>> = {
  REGULATION_PUBLISHED: "external.regulatory.published",
  IPO_FILED: "external.ipo.filed",
  ACQUISITION_ANNOUNCED: "external.acquisition.announced",
  MARKET_ALERT: "external.market.alert",
  COMPLIANCE_DISCLOSURE: "external.compliance.disclosed",
};
