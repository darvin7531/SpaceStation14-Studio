import type {
  CSharpField, ComponentScalarKind, ComponentSchema,
  PrototypeComponentEntry,
} from './api';

export type EditableScalarKind = Exclude<ComponentScalarKind, 'complex'>;

export interface SuggestedComponentField {
  field: CSharpField;
  kind: EditableScalarKind | null;
  defaultValue: string;
}

/**
 * Conservative mapping for direct C# primitive fields only. Unsupported,
 * nullable, generic, enum and custom types remain view-only; this must not
 * claim to reproduce RobustToolbox serialization semantics.
 */
export function scalarKindForCSharp(type: string): EditableScalarKind | null {
  switch (type.trim()) {
    case 'string': return 'string';
    case 'bool': return 'bool';
    case 'sbyte':
    case 'byte':
    case 'short':
    case 'ushort':
    case 'int':
    case 'uint':
    case 'long':
    case 'ulong': return 'int';
    case 'float':
    case 'double': return 'float';
    default: return null;
  }
}

export function suggestedFields(
  entry: PrototypeComponentEntry,
  schema: ComponentSchema | undefined,
  indexComplete: boolean,
): SuggestedComponentField[] {
  if (!indexComplete || schema?.status !== 'unique' || schema.declarations.length !== 1) {
    return [];
  }
  const present = new Set(entry.fields.map((field) => field.key));
  const seen = new Set<string>();
  return schema.declarations[0].fields
    .filter((field) => {
      if (present.has(field.name) || seen.has(field.name)) return false;
      seen.add(field.name);
      return true;
    })
    .map((field) => {
      const kind = scalarKindForCSharp(field.field_type);
      const legalKey = /^[a-zA-Z0-9_.-]{1,128}$/.test(field.name) && field.name !== 'type';
      const safeKind = legalKey ? kind : null;
      return {
        field,
        kind: safeKind,
        defaultValue: safeKind === 'bool' ? 'false'
          : safeKind === 'int' ? '0'
            : safeKind === 'float' ? '0.0' : '',
      };
    });
}
