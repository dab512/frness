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
  readonly registry: DefinitionReader;
  readonly implementation: DefinitionRef;
  child(slot: string): unknown;
  capability(name: string): unknown;
  exported(implementation: DefinitionRef): unknown;
}
export interface NativeFactory {
  create(context: FactoryContext): Promise<NativeService>;
}
