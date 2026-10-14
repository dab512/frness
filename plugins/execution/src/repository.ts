import { createHash } from "node:crypto";
import type { DefinitionReader } from "../../../packages/abi/src/factory.js";
import { assertJson, canonicalJson } from "../../../packages/abi/src/json.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import type {
  CommitBatch,
  ComponentInstance,
  ExecutionContext,
  InvocationRequest,
  Json,
  ObjectRef,
  ObjectStore,
  ProtocolError,
  ReducerCommand,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import { executionError } from "./reducer.js";

export class RepositoryUnavailable extends Error {
  readonly code = "REPOSITORY_UNAVAILABLE";
  constructor() {
    super("Repository result is not durable; scheduler must recover the pending command");
  }
}
export interface RepositoryBridgeOptions {
  readonly registry: Pick<DefinitionReader, "validate">;
  readonly contract: TypeRef;
  readonly store: (instance: ComponentInstance) => ObjectStore;
  readonly grants: (instance: ComponentInstance) => readonly string[];
  readonly cut?: (point: "after_io_before_result") => Promise<void>;
}
export class RepositoryBridge {
  constructor(readonly options: RepositoryBridgeOptions) {}
  validate(request: InvocationRequest, commandId: string): void {
    if (definitionKey(request.operation.contract) !== definitionKey(this.options.contract))
      throw executionError(
        "CONTRACT_MISMATCH",
        "Repository contract does not match the pinned capability",
      );
    if (!["read", "commit"].includes(request.operation.operation))
      throw executionError("INVALID_INPUT", "Repository operation is unavailable");
    if (
      request.operation.operation === "commit" &&
      (request.input as unknown as { batch: CommitBatch }).batch.commitKey !== commandId
    )
      throw executionError("INVALID_INPUT", "Repository commit key must equal its command ID");
  }
  async execute(input: {
    readonly request: InvocationRequest;
    readonly child: ComponentInstance;
    readonly parent: ComponentInstance;
    readonly principal: ExecutionContext;
    readonly parentInvocation: ObjectRef;
    readonly commandId: string;
    readonly outputType: TypeRef;
  }): Promise<ReducerCommand> {
    this.validate(input.request, input.commandId);
    const context: ExecutionContext = {
      principalId: input.principal.principalId,
      scopeId: input.parent.scopeId,
      ownerInstanceId: input.parent.instanceId,
      assemblyRevision: input.request.assemblyRevision,
      grants: this.options
        .grants(input.parent)
        .filter((grant) => input.principal.grants.includes(grant)),
    };
    if (context.scopeId !== input.principal.scopeId || input.child.scopeId !== context.scopeId)
      throw executionError("CAPABILITY_DENIED", "Repository parent scope does not match");
    let output: unknown;
    try {
      const store = this.options.store(input.child);
      if (input.request.operation.operation === "read") {
        const read = input.request.input as unknown as { object: ObjectRef; revision?: string };
        output = await store.read(context, read.object, read.revision);
      } else {
        const request = input.request.input as unknown as { batch: CommitBatch };
        const key = `repo/${createHash("sha256")
          .update(canonicalJson([input.parentInvocation.objectId, input.commandId]))
          .digest("hex")}`;
        output = await store.commit(context, { ...request.batch, commitKey: key });
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (
        ![
          "CAPABILITY_DENIED",
          "NOT_FOUND",
          "SNAPSHOT_UNAVAILABLE",
          "REVISION_CONFLICT",
          "INVALID_INPUT",
          "INVALID_OUTPUT",
          "UNSUPPORTED_SCHEMA_VERSION",
          "DEFINITION_CONFLICT",
          "EVENT_CONFLICT",
        ].includes(code)
      )
        throw new RepositoryUnavailable();
      const protocol: ProtocolError = {
        code,
        message: "Repository operation was rejected",
        details: null,
        retryable: false,
      };
      return { kind: "fail", error: protocol };
    }
    try {
      await this.options.cut?.("after_io_before_result");
    } catch {
      throw new RepositoryUnavailable();
    }
    try {
      assertJson(output);
      this.options.registry.validate(input.outputType, output);
    } catch {
      throw new RepositoryUnavailable();
    }
    return { kind: "complete", output: output as Json };
  }
}
