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

export interface PrototypePage {
  total: number;
  items: PrototypeDeclaration[];
  diagnostic_count: number;
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

export interface ResourceDocument {
  path: string;
  content: string;
  bytes: number;
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
  listPrototypeDiagnostics(offset = 0, limit = 100): Promise<PrototypeDiagnosticPage> {
    return invoke('list_prototype_diagnostics', { offset, limit });
  },
  readResource(path: string): Promise<ResourceDocument> {
    return invoke('read_resource', { path });
  },
};
