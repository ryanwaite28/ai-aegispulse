// Runs once on first init (before the replica set is initiated). PROJECT.md §5.7.3.
const admin = db.getSiblingDB("admin");
admin.createUser({ user: "svc_events", pwd: process.env.MONGO_SVC_EVENTS_PASSWORD,
  roles: [{ role: "readWrite", db: "aegispulse_events" }] });
admin.createUser({ user: "backup", pwd: process.env.MONGO_BACKUP_PASSWORD, roles: [{ role: "backup", db: "admin" }] });
print("mongo init: users created");
