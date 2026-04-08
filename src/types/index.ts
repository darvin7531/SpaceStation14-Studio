export interface SS14Prototype {
  _key: string;
  id: string | number;
  type: string | number;
  name?: string | number;
  description?: string;
  suffix?: string;
  parent?: string | number | Array<string | number>;
  abstract?: boolean;
  components?: any[];
  _filePath: string;
  _line: number;
  _document?: any;
  _rawYaml: string;
}

export interface PrototypeListItem {
  _key: string;
  id: string | number;
  type: string | number;
  name?: string | number;
  parent?: string | number | Array<string | number>;
  abstract?: boolean;
  _filePath: string;
  _line: number;
}

export interface RSIState {
  name: string;
  directions?: number;
  delays?: number[][];
  flags?: Record<string, any>;
}

export interface RSIMeta {
  version: number;
  license: string;
  copyright: string;
  size: { x: number; y: number };
  states: RSIState[];
}

export interface RSI {
  path: string;
  meta: RSIMeta;
  images: Record<string, string>;
  dirPath: string;
}

export interface RsiSummary {
  path: string;
  stateCount: number;
  size?: { x: number; y: number };
  states: string[];
  previewState?: string | null;
  previewDataUrl?: string | null;
}

export interface RsiAssetState {
  name: string;
  directions?: number;
  delays?: number[][];
  flags?: Record<string, any>;
  previewDataUrl?: string | null;
}

export interface RsiAssetDetail {
  path: string;
  dirPath: string;
  meta: RSIMeta;
  states: RsiAssetState[];
  issues: ValidationIssue[];
}

export interface CreateRsiDraft {
  directory: string;
  name: string;
  sizeX: number;
  sizeY: number;
  license: string;
  copyright: string;
}

export interface ValidationIssue {
  level: 'error' | 'warning' | 'info';
  message: string;
  prototypeId?: string;
  field?: string;
  prototypeKey?: string;
  rsiPath?: string;
  stateName?: string;
}

export interface ComponentSchema {
  name: string;
  className: string;
  path: string;
  line: number;
  description?: string;
  fields: Array<{ name: string; member: string; type: string; line: number; required?: boolean; description?: string }>;
}

export interface PrototypeKindSchema {
  type: string;
  className: string;
  path: string;
  line: number;
  description?: string;
  fields: Array<{ name: string; member: string; type: string; line: number; required?: boolean; description?: string }>;
}

export interface ProjectSummary {
  projectRoot: string;
  counts: {
    prototypes: number;
    rsis: number;
    components: number;
    prototypeKinds: number;
    issues: number;
  };
  issues: ValidationIssue[];
  cache?: {
    hit: boolean;
    restored?: boolean;
    unchecked?: boolean;
    key: string;
    fileCount: number;
  };
}

export interface RestoredProjectSummary extends ProjectSummary {
  selectedPrototypeId?: string | null;
  searchQuery?: string;
}

export type ProjectScanResult = ProjectSummary;

export interface PrototypeListResult {
  total: number;
  items: PrototypeListItem[];
}

export interface PrototypeDetail {
  prototype: SS14Prototype;
  resolved: any;
  issues: ValidationIssue[];
  rsi: RsiSummary | null;
  kind: PrototypeKindSchema | null;
}

export interface CompletionSuggestion {
  label: string;
  kind: 'component' | 'field';
  insertText: string;
  detail: string;
  documentation: string;
}

export interface CreatePrototypeOptions {
  types: string[];
  files: string[];
  defaultFile: string;
}

export interface PrototypeDraft {
  mode: 'append' | 'new';
  type: string;
  id: string;
  name?: string;
  description?: string;
  suffix?: string;
  parent?: string;
  abstract?: boolean;
  filePath: string;
  includeSprite?: boolean;
  sprite?: string;
  spriteState?: string;
  includeItem?: boolean;
  includePhysics?: boolean;
  includeAppearance?: boolean;
}

export interface DraftValidation {
  ok: boolean;
  issues: Array<{ level: 'error' | 'warning' | 'info'; field: string; message: string }>;
  yaml: string;
  filePath: string;
}

export interface ResourceTreeNode {
  name: string;
  path: string;
  kind: 'folder' | 'file' | 'prototype' | 'rsi';
  children?: ResourceTreeNode[];
  prototypeKey?: string;
  prototypeType?: string | number;
  prototypeCount?: number;
  rsiCount?: number;
  stateCount?: number;
}

export interface ScanProgress {
  stage: string;
  message: string;
  processed: number;
}

export interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface UpdateState {
  status: 'idle' | 'disabled' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'unavailable' | 'error';
  message: string;
  version: string;
  progress?: UpdateProgress | null;
  downloadedVersion?: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  author: string;
  license: string;
  repositoryUrl: string;
}

declare global {
  interface Window {
    prototypeStudio: {
      selectProject: () => Promise<string | null>;
      restoreLastProject: () => Promise<RestoredProjectSummary | null>;
      scanProject: (projectRoot: string) => Promise<ProjectScanResult>;
      listPrototypes: (request: { query?: string; offset?: number; limit?: number }) => Promise<PrototypeListResult>;
      getPrototype: (key: string) => Promise<PrototypeDetail | null>;
      autocomplete: (request: { query?: string; limit?: number; context?: 'any' | 'componentEntryStart' | 'componentType' | 'componentField'; componentType?: string }) => Promise<CompletionSuggestion[]>;
      componentInfo: (name: string) => Promise<ComponentSchema | null>;
      resourceTree: () => Promise<ResourceTreeNode>;
      pickProjectFolder: (request: { scope: 'prototypes' | 'textures'; currentPath?: string }) => Promise<string | null>;
      getRsiAsset: (path: string) => Promise<RsiAssetDetail | null>;
      saveRsiAsset: (request: { path: string; meta: RSIMeta }) => Promise<RsiAssetDetail | null>;
      importRsiImages: (request: { path: string; files: Array<{ name: string; dataUrl: string }> }) => Promise<RsiAssetDetail | null>;
      createRsiAsset: (draft: CreateRsiDraft) => Promise<RsiAssetDetail | null>;
      validatePrototypeYaml: (request: { key: string; text: string }) => Promise<PrototypeDetail | null>;
      createOptions: () => Promise<CreatePrototypeOptions>;
      validateDraft: (draft: PrototypeDraft) => Promise<DraftValidation>;
      createFromDraft: (draft: PrototypeDraft) => Promise<{ key: string; filePath: string; yaml: string }>;
      onScanProgress: (callback: (progress: ScanProgress) => void) => () => void;
      readPrototype: (request: { projectRoot: string; filePath: string; line: number }) => Promise<{ filePath: string; line: number; text: string }>;
      savePrototype: (request: { projectRoot: string; filePath: string; line: number; text: string }) => Promise<{ filePath: string; line: number; text: string }>;
      createPrototype: (request: { projectRoot: string; type: string; id: string; parent?: string; name?: string; filePath?: string }) => Promise<{ filePath: string; line: number; text: string }>;
      getUpdateState: () => Promise<UpdateState>;
      checkForUpdates: () => Promise<UpdateState>;
      installUpdate: () => Promise<boolean>;
      onUpdateStatus: (callback: (status: UpdateState) => void) => () => void;
      getAppInfo: () => Promise<AppInfo>;
      openExternal: (url: string) => Promise<boolean>;
      saveWorkspaceUiState: (patch: { selectedPrototypeId?: string | null; searchQuery?: string; lastProjectRoot?: string }) => Promise<void>;
      minimizeWindow: () => Promise<void>;
      toggleMaximizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
    };
  }
}
