import { createHash } from "node:crypto";
import { assertJson, canonicalJson, freezeJson } from "../../../packages/abi/src/json.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import type {
  Assembly,
  ComponentInstance,
  ContractDefinition,
  DefinitionRef,
  EffectAdapter,
  EffectDefinition,
  EffectOutcome,
  ImplementationDefinition,
  Json,
  OperationRef,
  ReducerCommand,
  RetryPolicy,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import { executionError } from "./reducer.js";

interface SchemaCapability {
  get(ref: DefinitionRef): { readonly value: Json };
  validate(type: TypeRef, value: unknown): void;
}
export interface EffectBridgeOptions {
  readonly registry: SchemaCapability;
  readonly adapter: (ref: DefinitionRef, instanceId: string) => EffectAdapter;
  readonly account: (instance: ComponentInstance) => string;
  readonly policy: (instance: ComponentInstance, operation: OperationRef) => RetryPolicy;
  readonly timeoutMs?: number;
}
export interface PrepareEffect {
  readonly assembly: Assembly;
  readonly parentInstanceId: string;
  readonly invocationId: string;
  readonly operation: OperationRef;
  readonly command: Extract<ReducerCommand, { kind: "effect" }>;
  readonly grants: readonly string[];
}
const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const same = (a: DefinitionRef, b: DefinitionRef): boolean => definitionKey(a) === definitionKey(b);
const unknown = (reason: string): EffectOutcome => ({ kind: "unknown", reason, evidence: null });

export class EffectBridge {
  constructor(readonly options: EffectBridgeOptions) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    )
      throw executionError("INVALID_INPUT", "Effect timeout must be positive");
  }
  prepare(input: PrepareEffect): EffectDefinition {
    const { assembly, command } = input;
    assertJson(command);
    const parent = assembly.instances.find(
      (instance) => instance.instanceId === input.parentInstanceId,
    );
    const adapter = assembly.instances.find(
      (instance) => instance.instanceId === command.adapterInstanceId,
    );
    const binding = assembly.bindings.find(
      (item) =>
        item.parentInstanceId === input.parentInstanceId &&
        item.childInstanceId === command.adapterInstanceId,
    );
    if (!parent || !adapter || !binding || parent.scopeId !== adapter.scopeId)
      throw executionError("CAPABILITY_DENIED", "Effect target is not a connected child in scope");
    const parentImpl = this.options.registry.get(parent.implementation)
      .value as unknown as ImplementationDefinition;
    const adapterImpl = this.options.registry.get(adapter.implementation)
      .value as unknown as ImplementationDefinition;
    if (adapterImpl.abi !== "effect-adapter.v1")
      throw executionError("UNKNOWN_ABI", "Connected child is not an effect adapter");
    const slot = parentImpl.slots.find((item) => item.name === binding.slot);
    if (
      !slot ||
      !same(slot.accepts, command.operation.contract) ||
      !adapterImpl.contracts.some((ref) => same(ref, slot.accepts))
    )
      throw executionError("CONTRACT_MISMATCH", "Effect child does not export the slot contract");
    if (!parentImpl.contracts.some((ref) => same(ref, input.operation.contract)))
      throw executionError("CONTRACT_MISMATCH", "Parent does not export its operation contract");
    const parentContract = this.options.registry.get(input.operation.contract)
      .value as unknown as ContractDefinition;
    if (
      !parentContract.operations[input.operation.operation] ||
      !parentContract.allowedEffects.some((ref) => same(ref, command.operation.contract))
    )
      throw executionError("CAPABILITY_DENIED", "Parent contract does not permit this effect");
    if (
      [...parentImpl.requiredCapabilities, ...adapterImpl.requiredCapabilities].some(
        (grant) => !input.grants.includes(grant),
      )
    )
      throw executionError("CAPABILITY_DENIED", "Effect capability is absent");
    if (!command.commandId || !Number.isFinite(command.maxUnits) || command.maxUnits < 0)
      throw executionError("INVALID_INPUT", "Invalid effect command");
    this.options.registry.validate(adapterImpl.configurationType, adapter.configuration);
    const contract = this.options.registry.get(command.operation.contract)
      .value as unknown as ContractDefinition;
    const operation = contract.operations[command.operation.operation];
    if (!operation) throw executionError("INVALID_INPUT", "Effect operation does not exist");
    this.options.registry.validate(operation.input, command.input);
    const accountRef = this.options.account(adapter);
    if (!accountRef)
      throw executionError("CAPABILITY_DENIED", "Effect account binding is unavailable");
    const policy = structuredClone(this.options.policy(adapter, command.operation));
    if (
      !["read-only", "idempotency-key", "reconcile", "non-retryable"].includes(policy.strategy) ||
      !Number.isSafeInteger(policy.maxAttempts) ||
      policy.maxAttempts < 1 ||
      (policy.idempotencyValidUntil !== null &&
        !Number.isFinite(Date.parse(policy.idempotencyValidUntil)))
    )
      throw executionError("INVALID_INPUT", "Invalid retry policy");
    const effectId = digest([input.invocationId, command.commandId]);
    return freezeJson(
      structuredClone({
        effectId,
        invocationId: input.invocationId,
        adapterInstanceId: adapter.instanceId,
        adapter: adapter.implementation,
        adapterConfiguration: adapter.configuration,
        accountRef,
        operation: command.operation,
        input: command.input,
        inputDigest: digest(command.input),
        remoteKey: digest([effectId, adapter.implementation, accountRef]),
        policy,
      }),
    );
  }
  async execute(
    effect: EffectDefinition,
    attemptId: string,
    runnerEpoch: string,
  ): Promise<EffectOutcome> {
    return this.#call(effect, (adapter, pinned) =>
      adapter.execute({ effect: pinned, attemptId, runnerEpoch }),
    );
  }
  async reconcile(effect: EffectDefinition, attemptId: string): Promise<EffectOutcome> {
    return this.#call(effect, (adapter, pinned) =>
      adapter.reconcile({ effect: pinned, attemptId }),
    );
  }
  async #call(
    effectInput: EffectDefinition,
    call: (adapter: EffectAdapter, pinned: EffectDefinition) => Promise<EffectOutcome>,
  ): Promise<EffectOutcome> {
    assertJson(effectInput);
    const effect = freezeJson(structuredClone(effectInput));
    if (effect.inputDigest !== digest(effect.input))
      throw executionError("INVALID_INPUT", "Pinned effect input digest does not match");
    const implementation = this.options.registry.get(effect.adapter)
      .value as unknown as ImplementationDefinition;
    if (
      implementation.abi !== "effect-adapter.v1" ||
      !implementation.contracts.some((ref) => same(ref, effect.operation.contract))
    )
      throw executionError("CONTRACT_MISMATCH", "Pinned effect adapter no longer matches");
    this.options.registry.validate(implementation.configurationType, effect.adapterConfiguration);
    const contract = this.options.registry.get(effect.operation.contract)
      .value as unknown as ContractDefinition;
    const operation = contract.operations[effect.operation.operation];
    if (!operation) throw executionError("INVALID_INPUT", "Pinned operation is unavailable");
    this.options.registry.validate(operation.input, effect.input);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        call(this.options.adapter(effect.adapter, effect.adapterInstanceId), effect),
        new Promise<EffectOutcome>((resolve) => {
          timer = setTimeout(
            () => resolve(unknown("Effect deadline elapsed without authoritative receipt")),
            this.options.timeoutMs ?? 10000,
          );
        }),
      ]);
      if (
        outcome &&
        outcome.kind !== "unknown" &&
        outcome.actualUnits !== null &&
        (!Number.isSafeInteger(outcome.actualUnits) || outcome.actualUnits < 0)
      ) {
        const evidence = {
          invalidUsage: {
            actualUnits: Number.isFinite(outcome.actualUnits)
              ? outcome.actualUnits
              : String(outcome.actualUnits),
            reportedEvidence: outcome.evidence,
          },
        };
        assertJson(evidence);
        return { kind: "unknown", reason: "INVALID_USAGE", evidence };
      }
      assertJson(outcome);
      if (!outcome || !["completed", "failed_known", "unknown"].includes(outcome.kind))
        return unknown("Invalid adapter outcome");
      if (outcome.kind === "unknown") {
        if (
          typeof outcome.reason !== "string" ||
          canonicalJson(Object.keys(outcome).sort()) !==
            canonicalJson(["evidence", "kind", "reason"])
        )
          return unknown("Invalid adapter outcome");
      } else {
        if (
          outcome.actualUnits !== null &&
          (!Number.isSafeInteger(outcome.actualUnits) || outcome.actualUnits < 0)
        )
          return unknown("Invalid usage receipt");
        if (outcome.kind === "completed") {
          if (
            canonicalJson(Object.keys(outcome).sort()) !==
            canonicalJson(["actualUnits", "evidence", "kind", "value"])
          )
            return unknown("Invalid adapter completion");
          this.options.registry.validate(operation.output, outcome.value);
        } else if (
          !outcome.error ||
          typeof outcome.error.code !== "string" ||
          typeof outcome.error.message !== "string" ||
          typeof outcome.error.retryable !== "boolean" ||
          canonicalJson(Object.keys(outcome).sort()) !==
            canonicalJson(["actualUnits", "error", "evidence", "kind"])
        )
          return unknown("Invalid failure receipt");
      }
      return structuredClone(outcome);
    } catch {
      return unknown("Transport or adapter failed without authoritative receipt");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
