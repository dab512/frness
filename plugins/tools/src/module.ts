import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { CapabilityBoundExport } from "../../../packages/abi/src/factory.js";
import type {
  EffectAdapter,
  Json,
  ReducerModule,
  ReloadParticipant,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import type { ToolCall } from "../../../specs/fractal-harness/standard-contracts.js";
import { contentDigest, FileTools } from "./files.js";
import { createRouterReducer } from "./reducer.js";
import { failedObservation, toolError } from "./router.js";

export { singleTool } from "./reducer.js";

let snapshotType: TypeRef;
export function activate(host: BootstrapRegistrationHost) {
  snapshotType = host.snapshotType;
  return () => {};
}
export const router: ReducerModule & CapabilityBoundExport = {
  initialize() {
    throw toolError("CAPABILITY_DENIED");
  },
  reduce() {
    throw toolError("CAPABILITY_DENIED");
  },
  bindCapabilities(context) {
    return createRouterReducer((type, value) => context.registry.validate(type, value));
  },
};
export interface FilesystemGrant {
  readonly root: string;
  readonly access: "read" | "read-write";
}
function fileAdapter(mode: "read" | "write"): EffectAdapter & CapabilityBoundExport {
  return {
    async execute() {
      throw toolError("CAPABILITY_DENIED");
    },
    async reconcile() {
      return {
        kind: "unknown",
        reason: "File adapter capabilities are unavailable",
        evidence: null,
      };
    },
    bindCapabilities(context) {
      const filesystem = context.capability("filesystem.root") as (
        binding: string,
      ) => FilesystemGrant;
      const execute: EffectAdapter["execute"] = async ({ effect }) => {
        const call = effect.input as unknown as ToolCall;
        try {
          const grant = filesystem(
            (effect.adapterConfiguration as { filesystemBinding: string }).filesystemBinding,
          );
          const type: TypeRef = {
            ...effect.adapter,
            name: mode === "read" ? "ReadInput" : "WriteInput",
          };
          context.registry.validate(type, call.arguments);
          const files = await FileTools.open(grant.root, grant.access);
          const value =
            mode === "read"
              ? await files.read(call.arguments as { path: string })
              : await files.write(
                  call.arguments as {
                    path: string;
                    expectedContentDigest: string | null;
                    newContent: string;
                  },
                );
          return {
            kind: "completed",
            actualUnits: 0,
            evidence: null,
            value: { callId: call.id, ok: true, value: { ...value }, errorCode: null, sources: [] },
          };
        } catch (error) {
          const code =
            error instanceof Error && "code" in error ? String(error.code) : "TOOL_OUTCOME_UNKNOWN";
          if (
            !["CAPABILITY_DENIED", "REVISION_CONFLICT", "INVALID_INPUT"].includes(code) &&
            mode === "write"
          )
            return {
              kind: "unknown",
              reason: "File write has no verified read-back",
              evidence: null,
            };
          return {
            kind: "completed",
            actualUnits: 0,
            evidence: null,
            value: failedObservation(call.id, code) as unknown as Json,
          };
        }
      };
      return {
        execute,
        async reconcile({ effect, attemptId }) {
          if (mode === "read") return execute({ effect, attemptId, runnerEpoch: "reconcile-read" });
          const call = effect.input as unknown as ToolCall;
          try {
            const grant = filesystem(
              (effect.adapterConfiguration as { filesystemBinding: string }).filesystemBinding,
            );
            const input = call.arguments as { path: string; newContent: string };
            const observed = await (await FileTools.open(grant.root, grant.access)).read({
              path: input.path,
            });
            if (observed.contentDigest === contentDigest(input.newContent))
              return {
                kind: "completed",
                actualUnits: 0,
                evidence: { reconciledBy: "contentDigest" },
                value: {
                  callId: call.id,
                  ok: true,
                  value: { ...observed },
                  errorCode: null,
                  sources: [],
                },
              };
          } catch {
            /* No verified desired content: keep the outcome unknown. */
          }
          return {
            kind: "unknown",
            reason: "Desired file content was not verified",
            evidence: null,
          };
        },
      } satisfies EffectAdapter;
    },
  };
}
export const readFile = fileAdapter("read");
export const writeFile = fileAdapter("write");
export function suite(value: unknown) {
  if (!value || typeof value !== "object") throw toolError("CONTRACT_MISMATCH");
}
export const reload: ReloadParticipant = {
  async capture() {
    return { type: snapshotType, value: null };
  },
  async restore(snapshot) {
    if (snapshot.value !== null) throw toolError("INVALID_INPUT");
  },
  async ready() {},
  async dispose() {},
};
