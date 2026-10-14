import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DaemonProfile, startDaemon } from "../../../apps/daemon/src/main.js";
import { CliRuntime } from "../../../plugins/agent-runtime/src/runtime.js";
import type { InvocationReceipt, ObjectRef } from "../../../specs/fractal-harness/contracts.js";
import { cliProfile } from "../../support/cli-profile.js";

const directory = process.argv[2]!;
if (process.argv[3] === "recover") {
  const profile = JSON.parse(
    await readFile(join(directory, "profile.json"), "utf8"),
  ) as DaemonProfile;
  const receipt = JSON.parse(
    await readFile(join(directory, "receipt.json"), "utf8"),
  ) as InvocationReceipt;
  const daemon = await startDaemon(profile, { FRNESS_API_TOKEN: "cli-only-test-authorization" });
  const runtime = (daemon.service("cli") as { runtime: CliRuntime }).runtime;
  const turn = (await runtime.read(receipt.invocation)).value as unknown as {
    session: ObjectRef;
    phase: string;
  };
  process.send?.({
    recovered: true,
    phase: turn.phase,
    session: await runtime.resume(turn.session),
  });
  process.on("message", async (message) => {
    if (message === "close") {
      await daemon.close();
      process.exit(0);
    }
  });
} else {
  const rig = await cliProfile(directory);
  await writeFile(join(directory, "profile.json"), JSON.stringify(rig.profile));
  const desired = process.argv[3] === "run" ? undefined : process.argv[3];
  const runtime = new CliRuntime({
    ...rig.runtime.options,
    ...(desired
      ? {
          cut: async (value: { point: string; turn: ObjectRef; pid: number | null }) => {
            if (value.point === desired) {
              const record = (await rig.runtime.read(value.turn)).value as unknown as {
                request: ObjectRef;
              };
              await writeFile(
                join(directory, "receipt.json"),
                JSON.stringify({ request: record.request, invocation: value.turn }),
              );
              process.send?.({ barrier: value.point, pid: value.pid });
              await new Promise<void>(() => {});
            }
          },
        }
      : {}),
    observers: [
      {
        async observe(input) {
          const value = input.event.value as unknown as {
            event: { kind: string; value?: { type?: string; pid?: number } };
          };
          if (value.event.kind === "provider" && value.event.value?.type === "test.ready")
            process.send?.({ running: true, pid: value.event.value.pid });
        },
      },
    ],
  });
  const receipt = await runtime.invoke({
    targetInstanceId: "cli",
    assemblyRevision: "v1",
    operation: { contract: rig.ref("std.agent-runtime", "Runner"), operation: "run" },
    input: { prompt: desired === "after_terminal_commit" ? "answer" : "hold" },
    idempotencyKey: "crash",
  });
  await writeFile(join(directory, "receipt.json"), JSON.stringify(receipt));
  process.send?.({ accepted: true });
}
