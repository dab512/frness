import { activePlugin, installPlugin } from "../../cli/src/plugins.js";

process.once(
  "message",
  async (input: { workspace: string; source?: string; executable?: string }) => {
    try {
      const result = input.source
        ? await installPlugin(
            input.workspace,
            input.source,
            input.executable ? { codex: input.executable, claude: input.executable } : {},
          )
        : await activePlugin(input.workspace);
      process.send?.({
        kind: "plugins",
        source: result?.source ?? "",
        revision: result?.revision ?? "",
        assembly: result?.profiles.codex.services ?? null,
      });
    } catch (error) {
      process.send?.({
        kind: "error",
        message: error instanceof Error ? error.message : "Plugin load failed",
      });
    } finally {
      process.disconnect?.();
    }
  },
);
