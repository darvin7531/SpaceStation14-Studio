import { create } from 'zustand';
import { ProjectSummary, PrototypeDetail, RsiAssetDetail, ValidationIssue } from '../types';

interface ProjectState {
  projectRoot: string | null;
  counts: ProjectSummary['counts'];
  validationIssues: ValidationIssue[];
  selectedPrototypeId: string | null;
  selectedPrototype: PrototypeDetail | null;
  selectedRsiPath: string | null;
  selectedRsi: RsiAssetDetail | null;
  selectedEditorTab: 'form' | 'raw' | 'resolved';
  editorJumpQuery: string | null;
  highlightedRsiState: string | null;
  searchQuery: string;
  filterType: string;
  isScanning: boolean;
  scanProgress: string;

  setProject: (result: ProjectSummary) => void;
  setValidationIssues: (issues: ValidationIssue[]) => void;
  setSelectedPrototypeId: (id: string | null) => void;
  setSelectedPrototype: (detail: PrototypeDetail | null) => void;
  setSelectedRsiPath: (path: string | null) => void;
  setSelectedRsi: (detail: RsiAssetDetail | null) => void;
  setSelectedEditorTab: (tab: 'form' | 'raw' | 'resolved') => void;
  setEditorJumpQuery: (query: string | null) => void;
  setHighlightedRsiState: (state: string | null) => void;
  setSearchQuery: (query: string) => void;
  setFilterType: (type: string) => void;
  setIsScanning: (isScanning: boolean) => void;
  setScanProgress: (progress: string) => void;
  updateSelectedPrototype: (updated: Partial<PrototypeDetail['prototype']>) => void;
}

const emptyCounts = {
  prototypes: 0,
  rsis: 0,
  components: 0,
  prototypeKinds: 0,
  issues: 0,
};

export const useProjectStore = create<ProjectState>((set) => ({
  projectRoot: null,
  counts: emptyCounts,
  validationIssues: [],
  selectedPrototypeId: null,
  selectedPrototype: null,
  selectedRsiPath: null,
  selectedRsi: null,
  selectedEditorTab: 'form',
  editorJumpQuery: null,
  highlightedRsiState: null,
  searchQuery: '',
  filterType: 'all',
  isScanning: false,
  scanProgress: '',

  setProject: (result) => set({
    projectRoot: result.projectRoot,
    counts: result.counts,
    validationIssues: result.issues,
    selectedPrototypeId: null,
    selectedPrototype: null,
    selectedRsiPath: null,
    selectedRsi: null,
    selectedEditorTab: 'form',
    editorJumpQuery: null,
    highlightedRsiState: null,
  }),
  setValidationIssues: (issues) => set({ validationIssues: issues }),
  setSelectedPrototypeId: (id) => set({ selectedPrototypeId: id }),
  setSelectedPrototype: (detail) => set({ selectedPrototype: detail }),
  setSelectedRsiPath: (path) => set({ selectedRsiPath: path }),
  setSelectedRsi: (detail) => set({ selectedRsi: detail }),
  setSelectedEditorTab: (tab) => set({ selectedEditorTab: tab }),
  setEditorJumpQuery: (query) => set({ editorJumpQuery: query }),
  setHighlightedRsiState: (state) => set({ highlightedRsiState: state }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setFilterType: (type) => set({ filterType: type }),
  setIsScanning: (isScanning) => set({ isScanning }),
  setScanProgress: (progress) => set({ scanProgress: progress }),
  updateSelectedPrototype: (updated) => set((state) => (
    state.selectedPrototype
      ? { selectedPrototype: { ...state.selectedPrototype, prototype: { ...state.selectedPrototype.prototype, ...updated } } }
      : {}
  )),
}));
