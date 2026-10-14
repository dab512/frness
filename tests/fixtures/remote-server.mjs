import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import Database from "better-sqlite3";

const db = new Database(process.argv[2]);
const actualUnits = Number(process.argv[3] ?? 0);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.exec(
  "CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY, remote_key TEXT, value TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS native_keys ON changes(remote_key) WHERE remote_key IS NOT NULL",
);
db.exec(
  "CREATE TABLE IF NOT EXISTS receipts(attempt_id TEXT PRIMARY KEY, remote_key TEXT NOT NULL, payload TEXT NOT NULL)",
);
const held = new Set();
const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/counts") {
      response.end(
        JSON.stringify({
          calls: db.prepare("SELECT COUNT(*) AS n FROM calls").get().n,
          changes: db.prepare("SELECT COUNT(*) AS n FROM changes").get().n,
        }),
      );
      return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1048576) throw new Error("Payload too large");
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.url === "/reconcile") {
      db.prepare("INSERT INTO calls DEFAULT VALUES").run();
      const row = db.prepare("SELECT value FROM changes WHERE remote_key=?").get(input.remoteKey);
      response.end(
        JSON.stringify(
          row
            ? {
                kind: "completed",
                value: JSON.parse(row.value),
                actualUnits,
                evidence: { source: "remote" },
              }
            : { kind: "unknown", reason: "No native evidence", evidence: null },
        ),
      );
      return;
    }
    if (request.url !== "/execute") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const receipt = db
      .transaction(() => {
        db.prepare("INSERT INTO calls DEFAULT VALUES").run();
        const key = input.nativeKey ? input.remoteKey : null;
        const previous = key
          ? db.prepare("SELECT value FROM changes WHERE remote_key=?").get(key)
          : undefined;
        if (previous) {
          const value = JSON.parse(previous.value);
          db.prepare(
            "INSERT OR IGNORE INTO receipts(attempt_id,remote_key,payload) VALUES(?,?,?)",
          ).run(input.attemptId, input.remoteKey, JSON.stringify({ value, actualUnits }));
          return { value, created: false };
        }
        const result = { externalId: randomUUID() };
        db.prepare("INSERT INTO changes(id,remote_key,value) VALUES(?,?,?)").run(
          result.externalId,
          key,
          JSON.stringify(result),
        );
        db.prepare(
          "INSERT OR IGNORE INTO receipts(attempt_id,remote_key,payload) VALUES(?,?,?)",
        ).run(input.attemptId, input.remoteKey, JSON.stringify({ value: result, actualUnits }));
        return { value: result, created: true };
      })
      .immediate();
    const value = receipt.value;
    const original = db
      .prepare("SELECT attempt_id,payload FROM receipts WHERE remote_key=? ORDER BY rowid LIMIT 1")
      .get(input.remoteKey);
    const evidence = {
      source: "remote",
      originalReceipt: { attemptId: original.attempt_id, ...JSON.parse(original.payload) },
    };
    process.send?.({ point: "remote_accepted", remoteKey: input.remoteKey });
    if (input.mode === "lost-reply" && receipt.created) {
      response.destroy();
      return;
    }
    if (input.mode === "hold") {
      held.add({ response, value, evidence });
      return;
    }
    response.end(JSON.stringify({ kind: "completed", value, actualUnits, evidence }));
  } catch {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: "INVALID_INPUT" }));
  }
});
process.on("message", (message) => {
  if (message === "release") {
    for (const { response, value, evidence } of held)
      response.end(
        JSON.stringify({
          kind: "completed",
          value,
          actualUnits,
          evidence,
        }),
      );
    held.clear();
  }
});
server.listen(0, "127.0.0.1", () => {
  process.send?.({ port: server.address().port });
});
process.on("disconnect", () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  for (const { response } of held) response.destroy();
});
