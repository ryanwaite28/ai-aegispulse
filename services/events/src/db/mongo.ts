// MongoDB client as svc_events (readWrite on aegispulse_events, no dbAdmin; §5.7.3).
import { MongoClient } from "mongodb";
import type { Config } from "../config.js";

export const DATABASE = "aegispulse_events";
/** Newest migrate-mongo file this build requires in `schema_meta` (NFR-11 c). */
export const REQUIRED_MIGRATION = "20261122000001-baseline.cjs";

export async function connectMongo(config: Config): Promise<MongoClient> {
  const client = new MongoClient(config.MONGO_URI, { serverSelectionTimeoutMS: 5_000, appName: "aegispulse-events" });
  await client.connect();
  return client;
}

export function mongoPingCheck(client: MongoClient): () => Promise<void> {
  return async () => {
    await client.db(DATABASE).command({ ping: 1 });
  };
}

export function mongoSchemaCheck(client: MongoClient): () => Promise<void> {
  return async () => {
    const applied = await client.db(DATABASE).collection("schema_meta").findOne({ fileName: REQUIRED_MIGRATION });
    if (applied === null) throw new Error(`schema_meta lacks ${REQUIRED_MIGRATION}`);
  };
}
