// migrate-mongo config for aegispulse_events (PROJECT.md §7.6). Runs as mig_events (readWrite + dbAdmin on aegispulse_events).
const url = process.env.MONGO_MIGRATE_URI;
if (!url) throw new Error("MONGO_MIGRATE_URI is required");

module.exports = {
  mongodb: { url, databaseName: "aegispulse_events", options: {} },
  migrationsDir: `${__dirname}/mongo-migrations`,
  changelogCollectionName: "schema_meta",
  migrationFileExtension: ".cjs",
  useFileHash: false, // immutability is enforced by the guard hook + ci/check-migrations.sh; a hash change must never re-run a migration
  moduleSystem: "commonjs",
};
