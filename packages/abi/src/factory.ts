import type { ComponentInstance, DefinitionRecord, DefinitionRef, TypeRef } from "./index.js";

export interface DefinitionReader {
  get(ref: DefinitionRef): DefinitionRecord & { readonly ref: DefinitionRef };
  definitions(): readonly (DefinitionRecord & { readonly ref: DefinitionRef })[];
  validate(type: TypeRef, value: unknown): void;
}
export interface NativeService {
  readonly value: unknown;
  dispose(): void | Promise<void>;
}
export interface FactoryContext {
  readonly instance: ComponentInstance;
  readonly assemblyRevision: string;
  readonly registry: DefinitionReader;
  readonly implementation: DefinitionRef;
  child(slot: string): unknown;
  children(slot: string): readonly unknown[];
  capability(name: string): unknown;
  exported(implementation: DefinitionRef, instanceId?: string): unknown;
}
export interface NativeFactory {
  create(context: FactoryContext): Promise<NativeService>;
}

/** Optional native export decorator; the resulting value still satisfies its declared ABI. */
export interface CapabilityBoundExport {
  bindCapabilities(context: {
    readonly registry: DefinitionReader;
    capability(name: string): unknown;
  }): unknown;
}
