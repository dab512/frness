import { writeFileSync } from "node:fs";

const mode = process.argv[2];
const marker = process.argv[3];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString();
if (marker) writeFileSync(marker, prompt);
if (mode === "invalid") {
  process.stdout.write("{broken\n");
} else if (mode === "missing-final") {
  process.stdout.write('{"kind":"text","text":"partial"}\n');
} else if (mode === "nonzero") {
  process.stderr.write("secret-token-must-not-be-returned");
  process.exitCode = 2;
} else if (mode === "hold") {
  process.stdout.write('{"kind":"ready"}\n');
  const timer = setInterval(() => {}, 1000);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.stdout.write('{"kind":"cancelled"}\n');
  });
} else {
  const bytes = Buffer.from(
    `${JSON.stringify({ kind: "text", text: "Привет 🌲", prompt })}\n${JSON.stringify({ kind: "completed", result: "ok" })}\n`,
  );
  const split = bytes.indexOf(Buffer.from("🌲")) + 2;
  process.stdout.write(bytes.subarray(0, split));
  process.stdout.write(bytes.subarray(split));
}
