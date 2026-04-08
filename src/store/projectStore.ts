import { create } from 'zustand';
import { ProjectSummary, PrototypeDetail, ValidationIssue } from '../types';

interface ProjectState {
  projectRoot: string | null;
  counts: ProjectSummary['counts'];
  validationIssues: ValidationIssue[];
  selectedPrototypeId: string | null;
  selectedPrototype: PrototypeDetail | null;
  searchQuery: string;
  filterType: string;
  isScanning: boolean;
  scanProgress: string;

  setProject: (result: ProjectSummary) => void;
  setValidationIssues: (issues: ValidationIssue[]) => void;
  setSelectedPrototypeId: (id: string | null) => void;
  setSelectedPrototype: (detail: PrototypeDetail | null) => void;
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
  }),
  setValidationIssues: (issues) => set({ validationIssues: issues }),
  setSelectedPrototypeId: (id) => set({ selectedPrototypeId: id }),
  setSelectedPrototype: (detail) => set({ selectedPrototype: detail }),
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
