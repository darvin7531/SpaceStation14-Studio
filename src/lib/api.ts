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
export interface CSharpField {
  name: string;
  member: string;
  field_type: string;
  line: number;
  required: boolean;
  explicit_name: boolean;
}

export interface CSharpDefinition {
  kind: 'component' | 'prototype';
  name: string;
  class_name: string;
  qualified_name: string;
  file: string;
  line: number;
  partial: boolean;
  base_types: string;
  fields: CSharpField[];
  parse_uncertain: boolean;
}

export interface CSharpPage {
  total: number;
  files_scanned: number;
  files_parsed: number;
  bytes_scanned: number;
  complete: boolean;
  warnings: string[];
  items: CSharpDefinition[];
}

export interface CSharpPart {
  qualified_name: string;
  file: string;
  line: number;
  fields: CSharpField[];
  parse_uncertain: boolean;
}

export interface CSharpInheritedCandidate {
  base_type: string;
  qualified_name: string;
  file: string;
  line: number;
  fields: CSharpField[];
  parse_uncertain: boolean;
}

export interface ComponentSchema {
  type_name: string;
  status: 'unique' | 'ambiguous' | 'partial' | 'uncertain' | 'not_indexed';
  declarations: CSharpDefinition[];
  parts: CSharpPart[];
  inherited_candidates: CSharpInheritedCandidate[];
}

export interface ComponentSchemaBatch {
  index_complete: boolean;
  files_scanned: number;
  warnings: string[];
  components: ComponentSchema[];
}

export interface ProjectRefresh {
  overview: ProjectOverview;
  added_resources: number;
  removed_resources: number;
}
export interface ResourceEntry {
  path: string;
  kind: Exclude<ResourceKind, 'all'>;
}
export interface ResourcePage {
  total: number;
  items: ResourceEntry[];
}
export interface ResourceBrowserEntry {
  path: string;
  name: string;
  kind: ResourceEntry['kind'] | 'folder';
  descendant_resources: number;
}
export interface ResourceBrowserPage {
  directory: string;
  parent: string | null;
  total: number;
  items: ResourceBrowserEntry[];
}
export interface UiSourceEntry {
  path: string;
  kind: 'xaml' | 'code_behind' | 'code';
  paired_with: string | null;
}
export interface UiSourcePage {
  total: number;
  items: UiSourceEntry[];
  files_scanned: number;
  complete: boolean;
  warnings: string[];
}
export interface ContentSearchHit {
  path: string;
  kind: Exclude<ResourceKind, 'all'>;
  line: number;
  preview: string;
}
export interface ContentSearchResults {
  items: ContentSearchHit[];
  files_scanned: number;
  bytes_scanned: number;
  complete: boolean;
  warnings: string[];
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
  variant_index: number | null;
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

export interface EntityLocalizationSource {
  localization_id: string;
  name: string;
  description: string;
  suffix: string;
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
      key: string; kind: Exclude<ComponentScalarKind, 'complex'>; value: string }
  | { operation: 'add_field'; index: number; expected_type: string;
      key: string; kind: Exclude<ComponentScalarKind, 'complex'>; value: string }
  | { operation: 'remove_field'; index: number; expected_type: string;
      key: string; expected_kind: Exclude<ComponentScalarKind, 'complex'>; expected_value: string };

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

export interface RsiSheetInfo {
  name: string;
  bytes: number;
  previewable: boolean;
}

export interface RsiSheetList {
  sheets: RsiSheetInfo[];
  warnings: string[];
}

export interface RsiSheetImage {
  data_url: string;
  bytes: number;
  width: number;
  height: number;
  revision: string;
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

export interface YamlSyntaxReport {
  valid: boolean;
  line: number | null;
  column: number | null;
  message: string | null;
}

export interface FluentDiagnostic {
  code: string;
  message: string;
  details: string;
  line: number;
  column: number;
  end_line: number;
  end_column: number;
}

export interface FluentAnalysis {
  entry_count: number;
  diagnostic_count: number;
  truncated: boolean;
  diagnostics: FluentDiagnostic[];
}

export interface FluentLocaleIssue {
  code: string;
  line: number;
  symbol: string;
  message: string;
  related_file: string | null;
  related_line: number | null;
}

export interface FluentLocaleAnalysis {
  locale: string;
  file_count: number;
  declaration_count: number;
  reference_count: number;
  complete: boolean;
  warnings: string[];
  issue_count: number;
  truncated: boolean;
  issues: FluentLocaleIssue[];
}

export interface FluentInspection {
  syntax: FluentAnalysis;
  locale: FluentLocaleAnalysis;
}

export interface RsiArchive {
  id: string;
  state: string;
}

export interface RsiArchiveList {
  archives: RsiArchive[];
  warnings: string[];
}

export interface RsiRestoreRequest {
  path: string;
  expected_revision: string;
  archive_id: string;
}

export interface RestoredRsiState {
  name: string;
  content: string;
  revision: string;
  archive_path: string;
  warning: string | null;
}

export interface RsiRenameRequest {
  path: string;
  expected_revision: string;
  expected_png_revision: string;
  old_name: string;
  new_name: string;
}

export interface RenamedRsiState {
  name: string;
  old_name: string;
  content: string;
  revision: string;
  archive_path: string;
  warning: string | null;
}

export interface RsiDeleteRequest {
  path: string;
  expected_revision: string;
  name: string;
}

export interface DeletedRsiState {
  name: string;
  content: string;
  revision: string;
  archive_path: string;
  warning: string | null;
}

export interface RsiCreditsUpdate {
  path: string;
  expected_revision: string;
  license: string;
  copyright: string;
}

export interface RsiTimingUpdate {
  path: string;
  expected_revision: string;
  name: string;
  delays: number[][];
}

export interface RsiImportRequest {
  path: string;
  expected_revision: string;
  name: string;
  directions: number;
  frames_per_direction: number;
  delay_seconds: number;
  data_url: string;
  expected_png_revision?: string;
  delays?: number[][];
}

export interface ImportedRsiState {
  name: string;
  content: string;
  revision: string;
  warning: string | null;
  archive_path?: string | null;
}

export interface NewRsiDraft {
  directory: string;
  name: string;
  size_x: number;
  size_y: number;
  license: string;
  copyright: string;
}

export interface NewRsiPreview {
  path: string;
  metadata: string;
  warnings: string[];
}

export interface CreatedRsi {
  path: string;
  warning: string | null;
  overview: ProjectOverview | null;
}

export interface NewFluentDraft {
  file: string;
  starter_key: string;
  starter_value: string;
}

export interface NewFluentPreview {
  file: string;
  content: string;
  warnings: string[];
}

export interface CreatedFluent {
  file: string;
  warning: string | null;
  overview: ProjectOverview | null;
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

export interface OpenRevision {
  path: string;
  expected_revision: string;
}
export interface ResourceDrift {
  path: string;
  status: 'changed' | 'unavailable';
  error_code: string | null;
}
export interface ResourceDriftReport {
  checked: number;
  skipped: number;
  items: ResourceDrift[];
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
  probeOpenRevisions(opened: OpenRevision[]): Promise<ResourceDriftReport> {
    return invoke('probe_open_revisions', { opened });
  },
  refreshProject(): Promise<ProjectRefresh> {
    return invoke('refresh_project');
  },
  searchResources(query: string, kind: ResourceKind, offset: number, limit = 100): Promise<ResourcePage> {
    return invoke('search_resources', { query, kind, offset, limit });
  },
  browseResourceFolder(directory: string, offset = 0, limit = 100): Promise<ResourceBrowserPage> {
    return invoke('browse_resource_folder', { directory, offset, limit });
  },
  searchUiSources(query: string, offset = 0, limit = 80): Promise<UiSourcePage> {
    return invoke('search_ui_sources', { query, offset, limit });
  },
  readUiSource(path: string): Promise<ResourceDocument> {
    return invoke('read_ui_source', { path });
  },
  searchResourceContent(query: string, kind: ResourceKind): Promise<ContentSearchResults> {
    return invoke('search_resource_content', { query, kind });
  },
  searchCSharpDefinitions(query: string, kind: 'all' | 'component' | 'prototype', offset: number, limit = 50): Promise<CSharpPage> {
    return invoke('search_csharp_definitions', { query, kind, offset, limit });
  },
  readCSharpSource(path: string): Promise<ResourceDocument> {
    return invoke('read_csharp_source', { path });
  },
  inspectComponentSchemas(names: string[]): Promise<ComponentSchemaBatch> {
    return invoke('inspect_component_schemas', { names });
  },
  searchPrototypes(query: string, kind: string, offset: number, limit = 100): Promise<PrototypePage> {
    return invoke('search_prototypes', { query, kind: kind || null, offset, limit });
  },
  inspectEntityLocalization(locator: PrototypeFieldLocator, source: string): Promise<EntityLocalizationSource> {
    return invoke('inspect_entity_localization', { locator, source });
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
  analyzeYamlResource(path: string, content: string): Promise<YamlSyntaxReport> {
    return invoke('analyze_yaml_resource', { path, content });
  },
  saveYamlResource(path: string, expectedRevision: string, content: string): Promise<SaveResult> {
    return invoke('save_yaml_resource', { path, expectedRevision, content });
  },
  saveFtlResource(path: string, expectedRevision: string, content: string): Promise<SaveResult> {
    return invoke('save_ftl_resource', { path, expectedRevision, content });
  },
  analyzeFluentResource(path: string, content: string): Promise<FluentInspection> {
    return invoke('analyze_fluent_resource', { path, content });
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
  previewNewRsi(draft: NewRsiDraft): Promise<NewRsiPreview> {
    return invoke('preview_new_rsi', { draft });
  },
  createNewRsi(draft: NewRsiDraft): Promise<CreatedRsi> {
    return invoke('create_new_rsi', { draft });
  },
  previewNewFluent(draft: NewFluentDraft): Promise<NewFluentPreview> {
    return invoke('preview_new_fluent', { draft });
  },
  createNewFluent(draft: NewFluentDraft): Promise<CreatedFluent> {
    return invoke('create_new_fluent', { draft });
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
  listRsiSheets(path: string): Promise<RsiSheetList> {
    return invoke('list_rsi_sheets', { path });
  },
  readRsiSheet(path: string, name: string): Promise<RsiSheetImage> {
    return invoke('read_rsi_sheet', { path, name });
  },
  importRsiState(request: RsiImportRequest): Promise<ImportedRsiState> {
    return invoke('import_rsi_state', { request });
  },
  replaceRsiState(request: RsiImportRequest): Promise<ImportedRsiState> {
    return invoke('replace_rsi_state', { request });
  },
  updateRsiCredits(request: RsiCreditsUpdate): Promise<ImportedRsiState> {
    return invoke('update_rsi_credits', { request });
  },
  updateRsiTiming(request: RsiTimingUpdate): Promise<ImportedRsiState> {
    return invoke('update_rsi_timing', { request });
  },
  renameRsiState(request: RsiRenameRequest): Promise<RenamedRsiState> {
    return invoke('rename_rsi_state', { request });
  },
  deleteRsiState(request: RsiDeleteRequest): Promise<DeletedRsiState> {
    return invoke('delete_rsi_state', { request });
  },
  listRsiArchives(path: string): Promise<RsiArchiveList> {
    return invoke('list_rsi_archives', { path });
  },
  restoreRsiState(request: RsiRestoreRequest): Promise<RestoredRsiState> {
    return invoke('restore_rsi_state', { request });
  },
  readResource(path: string): Promise<ResourceDocument> {
    return invoke('read_resource', { path });
  },
};
