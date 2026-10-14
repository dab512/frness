import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRig } from "../../support/repository-rig.js";

const directory = process.argv[2]!;
const recover = process.argv[3] === "recover";
let rig: Awaited<ReturnType<typeof repositoryRig>>;
rig = await repositoryRig(
  directory,
  recover
    ? undefined
    : async () => {
        const record = await rig.store.read(rig.dataContext, rig.object);
        process.send?.({ point: "afterIO", revision: record.revision });
        await new Promise((resolve) => process.once("message", resolve));
      },
  recover,
);
const subscription = rig.store.subscribe(rig.dataContext, "domain");
const cursorFile = join(directory, "data-cursor.txt");
if (!recover) await writeFile(cursorFile, subscription.snapshot().cursor);
const backend = rig.backend();
const receipt = await backend.invoke(rig.request("crash-write", "commit", rig.commitInput));
await backend.idle();
const snapshot = await rig.runtime.snapshot(receipt.invocation);
const record = await rig.store.read(rig.dataContext, rig.object);
process.send?.({
  point: "done",
  phase: snapshot.phase,
  revision: record.revision,
  commits: rig.calls.commit,
  changes: subscription.catchUp(await readFile(cursorFile, "utf8")).length,
});
subscription.close();
await rig.close();
if (process.connected) process.disconnect();
