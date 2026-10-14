CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS namespaces (id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS heads (
  namespace TEXT NOT NULL, object_id TEXT NOT NULL, type_ref TEXT NOT NULL,
  revision TEXT NOT NULL, deleted INTEGER NOT NULL,
  PRIMARY KEY (namespace, object_id), FOREIGN KEY (namespace) REFERENCES namespaces(id)
);
CREATE TABLE IF NOT EXISTS revisions (
  namespace TEXT NOT NULL, object_id TEXT NOT NULL, revision TEXT NOT NULL,
  type_ref TEXT NOT NULL, value TEXT NOT NULL, deleted INTEGER NOT NULL,
  PRIMARY KEY (namespace, object_id, revision)
);
CREATE TABLE IF NOT EXISTS commits (key TEXT PRIMARY KEY, payload TEXT NOT NULL, receipt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  namespace TEXT NOT NULL, object_id TEXT NOT NULL, revision TEXT NOT NULL, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  token TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
  principal TEXT NOT NULL, owner TEXT NOT NULL, scope TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_cursors (
  token TEXT PRIMARY KEY, namespace TEXT NOT NULL, sequence INTEGER NOT NULL,
  principal TEXT NOT NULL, owner TEXT NOT NULL, scope TEXT NOT NULL, issued_at INTEGER NOT NULL
);
