// Preload entry for ESM services: `node --import @aegispulse/ts-platform/telemetry/register dist/main.js`.
// Registers the OTel ESM loader hook so instrumentations can patch modules imported after this point.
// The service itself calls startTelemetry() first thing in main (it knows its name/version).
import { register } from "node:module";

register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
