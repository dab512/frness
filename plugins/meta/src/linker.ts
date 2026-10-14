import type {
  Assembly,
  Binding,
  DefinitionRef,
  ImplementationDefinition,
  SlotDefinition,
} from "../../../packages/abi/src/index.js";
import { freezeJson } from "../../../packages/abi/src/json.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import type { DefinitionRegistry } from "./registry.js";

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export class AssemblyLinker {
  constructor(
    private readonly registry: DefinitionRegistry,
    private readonly assemblyType: DefinitionRef,
    private readonly grants: readonly string[] = [],
  ) {}

  validate(assembly: Assembly): Assembly {
    this.registry.validate(this.assemblyType, assembly);
    if (assembly.instances.length > 10000) fail("INVALID_INPUT", "Assembly size limit exceeded");
    const instances = new Map(
      assembly.instances.map((instance) => [instance.instanceId, instance]),
    );
    if (instances.size !== assembly.instances.length)
      fail("DEFINITION_CONFLICT", "Duplicate instance ID");
    if (!instances.has(assembly.rootInstanceId)) fail("INVALID_INPUT", "Missing root instance");
    const implementations = new Map<string, ImplementationDefinition>();
    for (const instance of assembly.instances) {
      const definition = this.registry.get(instance.implementation);
      if (
        definition.metaType.packageId !== "std.meta" ||
        definition.metaType.name !== "Implementation"
      )
        fail("CONTRACT_MISMATCH", "Instance does not reference an implementation");
      const implementation = definition.value as unknown as ImplementationDefinition;
      this.registry.validate(implementation.configurationType, instance.configuration);
      this.registry.get(implementation.stateType);
      if (implementation.requiredCapabilities.some((name) => !this.grants.includes(name)))
        fail("CAPABILITY_DENIED", "Required capability is absent");
      const slots = new Set<string>();
      for (const slot of implementation.slots) {
        if (slots.has(slot.name)) fail("DEFINITION_CONFLICT", "Duplicate slot name");
        slots.add(slot.name);
        if (
          slot.min > slot.max ||
          (slot.collection === "single" && (slot.max !== 1 || slot.min > 1))
        )
          fail("SLOT_CARDINALITY", "Invalid slot cardinality");
      }
      implementations.set(instance.instanceId, implementation);
    }
    const owners = new Map<string, Binding>();
    const children = new Map<string, string[]>();
    const bySlot = new Map<string, Binding[]>();
    for (const binding of assembly.bindings) {
      const parent = implementations.get(binding.parentInstanceId);
      const child = implementations.get(binding.childInstanceId);
      if (!parent || !child) fail("INVALID_INPUT", "Binding references missing instance");
      const slot = parent.slots.find((entry) => entry.name === binding.slot);
      if (!slot) fail("UNKNOWN_SLOT", binding.slot);
      if (
        !child.contracts.some((contract) => definitionKey(contract) === definitionKey(slot.accepts))
      )
        fail("CONTRACT_MISMATCH", "Child exports a different exact contract");
      if (owners.has(binding.childInstanceId))
        fail("MULTIPLE_OWNERS", "Instance has more than one owning binding");
      owners.set(binding.childInstanceId, binding);
      const list = children.get(binding.parentInstanceId) ?? [];
      list.push(binding.childInstanceId);
      children.set(binding.parentInstanceId, list);
      const key = JSON.stringify([binding.parentInstanceId, binding.slot]);
      const selected = bySlot.get(key) ?? [];
      selected.push(binding);
      bySlot.set(key, selected);
    }
    const color = new Map<string, "gray" | "black">();
    for (const id of instances.keys()) {
      const stack = [{ id, exiting: false }];
      while (stack.length) {
        const current = stack.pop();
        if (!current) break;
        if (current.exiting) {
          color.set(current.id, "black");
          continue;
        }
        if (color.get(current.id) === "gray")
          fail("OWNERSHIP_CYCLE", "Owning bindings form a cycle");
        if (color.get(current.id) === "black") continue;
        color.set(current.id, "gray");
        stack.push({ id: current.id, exiting: true });
        for (const child of children.get(current.id) ?? [])
          stack.push({ id: child, exiting: false });
      }
    }
    if (owners.has(assembly.rootInstanceId)) fail("MULTIPLE_OWNERS", "Root cannot have an owner");
    for (const [id, implementation] of implementations) {
      for (const slot of implementation.slots)
        this.checkSlot(slot, bySlot.get(JSON.stringify([id, slot.name])) ?? []);
    }
    const reached = new Set<string>();
    const queue = [{ id: assembly.rootInstanceId, depth: 0 }];
    while (queue.length) {
      const current = queue.pop();
      if (!current) break;
      if (current.depth > 32) fail("INVALID_INPUT", "Assembly depth limit exceeded");
      reached.add(current.id);
      for (const child of children.get(current.id) ?? [])
        queue.push({ id: child, depth: current.depth + 1 });
    }
    if (reached.size !== instances.size)
      fail("UNREACHABLE_INSTANCE", "Every instance must be reachable from root");
    return freezeJson(structuredClone(assembly));
  }

  private checkSlot(slot: SlotDefinition, bindings: readonly Binding[]): void {
    if (bindings.length < slot.min || bindings.length > slot.max)
      fail("SLOT_CARDINALITY", slot.name);
    if (slot.collection === "single") {
      if (bindings.some((binding) => binding.order !== undefined || binding.key !== undefined))
        fail("INVALID_INPUT", "Single slot cannot have key or order");
    } else if (slot.collection === "ordered") {
      const orders = bindings.map((binding) => binding.order).sort((a, b) => (a ?? -1) - (b ?? -1));
      if (
        bindings.some((binding) => binding.key !== undefined) ||
        orders.some((order, index) => order !== index)
      )
        fail("DUPLICATE_SLOT_ORDER", "Ordered slot requires contiguous unique positions");
    } else {
      const keys = bindings.map((binding) => binding.key);
      if (
        bindings.some((binding) => binding.order !== undefined) ||
        keys.some((key) => !key) ||
        new Set(keys).size !== keys.length
      )
        fail("DUPLICATE_SLOT_KEY", "Keyed slot requires unique nonempty keys");
    }
  }
}
