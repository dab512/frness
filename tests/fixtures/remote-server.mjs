import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import Database from "better-sqlite3";

const db = new Database(process.argv[2]);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.exec(
  "CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY, remote_key TEXT, value TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS native_keys ON changes(remote_key) WHERE remote_key IS NOT NULL",
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
      const row = db.prepare("SELECT value FROM changes WHERE remote_key=?").get(input.remoteKey);
      response.end(
        JSON.stringify(
          row
            ? {
                kind: "completed",
                value: JSON.parse(row.value),
                actualUnits: 0,
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
    const value = db
      .transaction(() => {
        db.prepare("INSERT INTO calls DEFAULT VALUES").run();
        const key = input.nativeKey ? input.remoteKey : null;
        const previous = key
          ? db.prepare("SELECT value FROM changes WHERE remote_key=?").get(key)
          : undefined;
        if (previous) return JSON.parse(previous.value);
        const result = { externalId: randomUUID() };
        db.prepare("INSERT INTO changes(id,remote_key,value) VALUES(?,?,?)").run(
          result.externalId,
          key,
          JSON.stringify(result),
        );
        return result;
      })
      .immediate();
    process.send?.({ point: "remote_accepted", remoteKey: input.remoteKey });
    if (input.mode === "lost-reply") {
      response.destroy();
      return;
    }
    if (input.mode === "hold") {
      held.add({ response, value });
      return;
    }
    response.end(
      JSON.stringify({ kind: "completed", value, actualUnits: 0, evidence: { source: "remote" } }),
    );
  } catch {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: "INVALID_INPUT" }));
  }
});
process.on("message", (message) => {
  if (message === "release") {
    for (const { response, value } of held)
      response.end(
        JSON.stringify({
          kind: "completed",
          value,
          actualUnits: 0,
          evidence: { source: "remote" },
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
