import { invoke } from '@tauri-apps/api/core';

export type ResourceKind = 'all' | 'yaml' | 'rsi' | 'ftl';
export interface ProjectOverview {
  project_root: string;
  prototype_files: number;
  rsi_directories: number;
  locale_files: number;
  total_resources: number;
  warnings: string[];
}
export interface ResourceEntry {
  path: string;
  kind: Exclude<ResourceKind, 'all'>;
}
export interface ResourcePage {
  total: number;
  items: ResourceEntry[];
}
export interface PrototypeDeclaration {
  kind: string;
  id: string;
  parents: string[];
  abstract_prototype: boolean;
  file: string;
  line: number;
  document_index: number;
  item_index: number;
  mode: 'normal' | 'configured_partial' | 'tagged_partial' | 'partial_only';
  partial_order: number | null;
  parent_tag: string | null;
  source_count: number;
}

export interface PrototypeFieldLocator {
  file: string;
  kind: string;
  id: string;
  document_index: number;
  item_index: number;
  mode: PrototypeDeclaration['mode'];
}

export interface PrototypeFields {
  name: string;
  description: string;
  parent: string;
  abstract_prototype: boolean;
}

export interface FieldInspection {
  fields: PrototypeFields;
  notice: string;
}

export type ComponentScalarKind = 'string' | 'bool' | 'int' | 'float' | 'complex';

export interface ComponentScalarField {
  key: string;
  kind: ComponentScalarKind;
  value: string;
  editable: boolean;
}

export interface PrototypeComponentEntry {
  index: number;
  type_name: string;
  field_count: number;
  fields: ComponentScalarField[];
}

export interface ComponentInspection {
  components: PrototypeComponentEntry[];
  notice: string;
}

export type ComponentOperation =
  | { operation: 'add'; type_name: string }
  | { operation: 'remove'; index: number; expected_type: string }
  | { operation: 'update_field'; index: number; expected_type: string;
      key: string; kind: Exclude<ComponentScalarKind, 'complex'>; value: string };

export interface FieldPatch {
  content: string;
  changed: boolean;
}

export interface PrototypePage {
  total: number;
  items: PrototypeDeclaration[];
  diagnostic_count: number;
}

export interface PrototypeRelationLink {
  kind: string;
  id: string;
  file: string;
  line: number;
  source_mode: PrototypeDeclaration['mode'];
  status: 'defined' | 'partial_only' | 'ambiguous' | 'not_indexed' | 'tagged';
}

export interface PrototypeRelations {
  kind: string;
  id: string;
  declarations: PrototypeDeclaration[];
  parents: PrototypeRelationLink[];
  children: PrototypeRelationLink[];
  parent_total: number;
  child_total: number;
  index_complete: boolean;
}

export interface PrototypeDiagnostic {
  code: string;
  file: string;
  line: number;
  message: string;
}

export interface PrototypeDiagnosticPage {
  total: number;
  items: PrototypeDiagnostic[];
}

export interface DraftSnapshot {
  schema_version: number;
  project_root: string;
  path: string;
  base_revision: string;
  content: string;
  saved_at_ms: number;
}

export interface DraftSummary {
  path: string;
  saved_at_ms: number;
  source_indexed: boolean;
}

export interface DraftList {
  items: DraftSummary[];
  warnings: string[];
}

export interface DraftWriteResult {
  saved_at_ms: number;
  durability_warning: string | null;
}

export interface NewPrototypeDraft {
  kind: string;
  id: string;
  parent: string;
  name: string;
  description: string;
  abstract_prototype: boolean;
  sprite: string;
  sprite_state: string;
  include_item: boolean;
  include_physics: boolean;
  include_appearance: boolean;
  file: string;
}

export interface NewPrototypePreview {
  file: string;
  kind: string;
  id: string;
  yaml: string;
  warnings: string[];
}

export interface AppendPrototypePreview extends NewPrototypePreview {
  expected_revision: string;
}

export interface CreatedPrototype {
  file: string;
  kind: string;
  id: string;
  yaml: string;
  warning: string | null;
  overview: ProjectOverview | null;
}

export interface SaveResult {
  document: ResourceDocument;
  durability_warning?: string;
}

export interface ResourceDocument {
  path: string;
  content: string;
  bytes: number;
  revision: string;
}

/** The only UI boundary to the filesystem: all operations execute in Rust. */
export const studio = {
  openProject(path: string): Promise<ProjectOverview> {
    return invoke('open_project', { path });
  },
  searchResources(query: string, kind: ResourceKind, offset: number, limit = 100): Promise<ResourcePage> {
    return invoke('search_resources', { query, kind, offset, limit });
  },
  searchPrototypes(query: string, kind: string, offset: number, limit = 100): Promise<PrototypePage> {
    return invoke('search_prototypes', { query, kind: kind || null, offset, limit });
  },
  inspectPrototypeFields(locator: PrototypeFieldLocator, source: string): Promise<FieldInspection> {
    return invoke('inspect_prototype_fields', { locator, source });
  },
  patchPrototypeFields(locator: PrototypeFieldLocator, source: string, fields: PrototypeFields): Promise<FieldPatch> {
    return invoke('patch_prototype_fields', { locator, source, fields });
  },
  inspectPrototypeComponents(locator: PrototypeFieldLocator, source: string): Promise<ComponentInspection> {
    return invoke('inspect_prototype_components', { locator, source });
  },
  patchPrototypeComponents(locator: PrototypeFieldLocator, source: string, operation: ComponentOperation): Promise<FieldPatch> {
    return invoke('patch_prototype_components', { locator, source, operation });
  },
  prototypeRelations(kind: string, id: string): Promise<PrototypeRelations> {
    return invoke('prototype_relations', { kind, id });
  },
  listPrototypeDiagnostics(offset = 0, limit = 100): Promise<PrototypeDiagnosticPage> {
    return invoke('list_prototype_diagnostics', { offset, limit });
  },
  saveYamlResource(path: string, expectedRevision: string, content: string): Promise<SaveResult> {
    return invoke('save_yaml_resource', { path, expectedRevision, content });
  },
  listDrafts(): Promise<DraftList> {
    return invoke('list_drafts');
  },
  readDraft(path: string): Promise<DraftSnapshot | null> {
    return invoke('read_draft', { path });
  },
  persistDraft(path: string, baseRevision: string, content: string): Promise<DraftWriteResult> {
    return invoke('persist_draft', { path, baseRevision, content });
  },
  deleteDraft(path: string): Promise<void> {
    return invoke('delete_draft', { path });
  },
  previewNewPrototype(draft: NewPrototypeDraft): Promise<NewPrototypePreview> {
    return invoke('preview_new_prototype', { draft });
  },
  createNewPrototype(draft: NewPrototypeDraft): Promise<CreatedPrototype> {
    return invoke('create_new_prototype', { draft });
  },
  previewAppendPrototype(draft: NewPrototypeDraft): Promise<AppendPrototypePreview> {
    return invoke('preview_append_prototype', { draft });
  },
  appendPrototype(draft: NewPrototypeDraft, expectedRevision: string): Promise<CreatedPrototype> {
    return invoke('append_prototype', { draft, expectedRevision });
  },
  readResource(path: string): Promise<ResourceDocument> {
    return invoke('read_resource', { path });
  },
};
