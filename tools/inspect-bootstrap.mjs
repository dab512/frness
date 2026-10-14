import { resolve } from "node:path";
import { bootstrap } from "../packages/host/src/bootstrap.ts";

const generation = await bootstrap({ directory: resolve(process.argv[2] ?? ".frness/bootstrap") });
try {
  console.log(
    JSON.stringify(
      {
        generationId: generation.generationId,
        definitions: generation.description.definitions.map((definition) => definition.ref),
        abis: generation.abiIds(),
      },
      null,
      2,
    ),
  );
} finally {
  await generation.close();
}
