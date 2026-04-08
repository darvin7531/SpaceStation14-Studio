import { useProjectStore } from '../store/projectStore';
import { Search, Box, Plus, Folder, FileText, ImageIcon, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { scanProject } from '../services/scanner';
import { PrototypeListItem, ResourceTreeNode } from '../types';
import { cn } from '../lib/utils';
import CreatePrototypeModal from './CreatePrototypeModal';
import CreateRsiModal from './CreateRsiModal';

const PAGE_SIZE = 250;
type SidebarMode = 'search' | 'resources';

export default function Sidebar() {
  const {
    projectRoot,
    searchQuery,
    setSearchQuery,
    selectedPrototypeId,
    setSelectedPrototypeId,
    setSelectedPrototype,
    selectedRsiPath,
    setSelectedRsiPath,
    setSelectedRsi,
    setProject,
    setIsScanning,
    setScanProgress,
    counts,
  } = useProjectStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [createRsiOpen, setCreateRsiOpen] = useState(false);
  const [items, setItems] = useState<PrototypeListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<SidebarMode>('search');
  const [resourceTree, setResourceTree] = useState<ResourceTreeNode | null>(null);
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => new Set(['Resources']));

  useEffect(() => {
    if (!projectRoot) return;
    if (mode !== 'search') return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setIsLoading(true);
      try {
        const result = await window.prototypeStudio.listPrototypes({ query: searchQuery, offset, limit: PAGE_SIZE });
        if (!cancelled) {
          setItems(result.items);
          setTotal(result.total);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [mode, projectRoot, searchQuery, offset]);

  useEffect(() => {
    if (!projectRoot || mode !== 'resources') return;
    let cancelled = false;
    window.prototypeStudio.resourceTree()
      .then((tree) => {
        if (!cancelled) setResourceTree(tree);
      })
      .catch((error) => console.error("Failed to load resource tree", error));
    return () => {
      cancelled = true;
    };
  }, [counts.prototypes, counts.rsis, mode, projectRoot]);

  useEffect(() => {
    if (!projectRoot) return;
    const handle = setTimeout(() => {
      void window.prototypeStudio.saveWorkspaceUiState({ searchQuery, lastProjectRoot: projectRoot });
    }, 300);
    return () => clearTimeout(handle);
  }, [projectRoot, searchQuery]);

  const handleSelect = async (key: string) => {
    setSelectedRsiPath(null);
    setSelectedRsi(null);
    setSelectedPrototypeId(key);
    if (projectRoot) {
      void window.prototypeStudio.saveWorkspaceUiState({ selectedPrototypeId: key, lastProjectRoot: projectRoot });
    }
    setSelectedPrototype(null);
    const detail = await window.prototypeStudio.getPrototype(key);
    setSelectedPrototype(detail);
  };

  const handleSelectRsi = async (rsiPath: string) => {
    setSelectedPrototypeId(null);
    setSelectedPrototype(null);
    setSelectedRsiPath(rsiPath);
    const detail = await window.prototypeStudio.getRsiAsset(rsiPath);
    setSelectedRsi(detail);
  };

  const togglePath = (path: string) => {
    setOpenPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleCreated = async (key: string) => {
    if (!projectRoot) return;
    setIsScanning(true);
    setScanProgress(`Refreshing after creating ${key}`);
    try {
      const result = await scanProject(projectRoot);
      setProject(result);
      setSelectedPrototypeId(key);
      setSelectedPrototype(await window.prototypeStudio.getPrototype(key));
      setOffset(0);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to refresh project.');
    } finally {
      setIsScanning(false);
      setScanProgress('');
    }
  };

  const handleCreatedRsi = async (rsiPath: string) => {
    if (!projectRoot) return;
    setIsScanning(true);
    setScanProgress(`Refreshing after creating ${rsiPath}`);
    try {
      const result = await scanProject(projectRoot);
      setProject(result);
      setSelectedPrototypeId(null);
      setSelectedPrototype(null);
      setSelectedRsiPath(rsiPath);
      setSelectedRsi(await window.prototypeStudio.getRsiAsset(rsiPath));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to refresh project.');
    } finally {
      setIsScanning(false);
      setScanProgress('');
    }
  };

  return (
    <div className="w-72 border-r border-neutral-800 bg-neutral-900/50 flex flex-col h-full shrink-0">
      <div className="p-3 border-b border-neutral-800 flex flex-col gap-2">
        <div className="grid grid-cols-2 rounded-md border border-neutral-800 bg-neutral-950 p-0.5 text-xs">
          <button
            onClick={() => setMode('search')}
            className={cn("rounded px-2 py-1.5", mode === 'search' ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300")}
          >
            Search
          </button>
          <button
            onClick={() => setMode('resources')}
            className={cn("rounded px-2 py-1.5", mode === 'resources' ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300")}
          >
            Resources
          </button>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-neutral-500" />
          <input
            type="text"
            placeholder="Search prototypes..."
            disabled={mode !== 'search'}
            value={searchQuery}
            onChange={(event) => {
              setOffset(0);
              setSearchQuery(event.target.value);
            }}
            className="w-full bg-neutral-950 border border-neutral-800 rounded-md py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-45"
          />
        </div>
        <button onClick={() => setCreateOpen(true)} className="flex items-center justify-center gap-2 rounded-md border border-neutral-800 bg-neutral-950/60 px-2 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900">
          <Plus size={13} className="text-blue-400" />
          Create prototype
        </button>
        {mode === 'resources' && (
          <button onClick={() => setCreateRsiOpen(true)} className="flex items-center justify-center gap-2 rounded-md border border-neutral-800 bg-neutral-950/60 px-2 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900">
            <ImageIcon size={13} className="text-emerald-400" />
            Create RSI
          </button>
        )}
        {mode === 'search' && <div className="flex items-center justify-between text-[11px] text-neutral-500">
          <span>{isLoading ? 'Loading...' : `${offset + 1}-${Math.min(offset + PAGE_SIZE, total)} / ${total}`}</span>
          <div className="flex gap-1">
            <button className="px-2 py-0.5 rounded bg-neutral-800 disabled:opacity-40" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Prev</button>
            <button className="px-2 py-0.5 rounded bg-neutral-800 disabled:opacity-40" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
          </div>
        </div>}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5 custom-scrollbar">
        {mode === 'search' && <>
          {items.map(proto => (
            <button
              key={proto._key}
              onClick={() => handleSelect(proto._key)}
              className={cn(
                "w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 transition-colors",
                selectedPrototypeId === proto._key ? "bg-blue-600/20 text-blue-400" : "hover:bg-neutral-800 text-neutral-300"
              )}
            >
              <Box size={14} className={proto.abstract ? "text-neutral-500" : "text-blue-500"} />
              <div className="truncate flex-1">
                <span className={proto.abstract ? "italic opacity-70" : ""}>{text(proto.id)}</span>
                <span className="text-xs text-neutral-500 ml-2 truncate">{text(proto.type)}</span>
                {proto.name && <span className="text-xs text-neutral-500 ml-2 truncate">{text(proto.name)}</span>}
              </div>
            </button>
          ))}
          {items.length === 0 && <div className="text-center text-neutral-500 text-sm py-4">No prototypes found.</div>}
        </>}

        {mode === 'resources' && (
          resourceTree
            ? <ResourceNode node={resourceTree} depth={0} openPaths={openPaths} selectedPrototypeId={selectedPrototypeId} selectedRsiPath={selectedRsiPath} onToggle={togglePath} onSelect={handleSelect} onSelectRsi={handleSelectRsi} />
            : <div className="text-center text-neutral-500 text-sm py-4">Loading Resources...</div>
        )}
      </div>
      <CreatePrototypeModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={handleCreated} />
      <CreateRsiModal open={createRsiOpen} onClose={() => setCreateRsiOpen(false)} onCreated={handleCreatedRsi} />
    </div>
  );
}

function ResourceNode({
  node,
  depth,
  openPaths,
  selectedPrototypeId,
  selectedRsiPath,
  onToggle,
  onSelect,
  onSelectRsi,
}: {
  node: ResourceTreeNode;
  depth: number;
  openPaths: Set<string>;
  selectedPrototypeId: string | null;
  selectedRsiPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (key: string) => void;
  onSelectRsi: (path: string) => void;
}) {
  const children = node.children ?? [];
  const expandable = children.length > 0;
  const open = openPaths.has(node.path);
  const selected = node.prototypeKey === selectedPrototypeId || (node.kind === 'rsi' && node.path === selectedRsiPath);
  const left = depth * 12;

  const icon = node.kind === 'folder'
    ? <Folder size={14} className={open ? "text-amber-400" : "text-amber-500/80"} />
    : node.kind === 'rsi'
      ? <ImageIcon size={14} className="text-emerald-400" />
      : node.kind === 'file'
        ? <FileText size={14} className="text-neutral-400" />
        : <Box size={14} className="text-blue-500" />;

  const label = node.kind === 'prototype'
    ? `${text(node.name)}  ${text(node.prototypeType)}`
    : node.name;

  const meta = node.kind === 'rsi'
    ? `${node.stateCount ?? 0} states`
    : node.kind === 'folder' || node.kind === 'file'
      ? `${node.prototypeCount ?? 0} proto${node.rsiCount ? ` / ${node.rsiCount} rsi` : ''}`
      : '';

  const handleClick = () => {
    if (node.kind === 'prototype' && node.prototypeKey) void onSelect(node.prototypeKey);
    else if (node.kind === 'rsi') void onSelectRsi(node.path);
    else if (expandable) onToggle(node.path);
  };

  return (
    <div>
      <button
        onClick={handleClick}
        title={node.path}
        className={cn(
          "w-full min-w-0 rounded px-1.5 py-1 text-left text-xs flex items-center gap-1.5 transition-colors",
          selected ? "bg-blue-600/20 text-blue-300" : "text-neutral-300 hover:bg-neutral-800"
        )}
        style={{ paddingLeft: `${6 + left}px` }}
      >
        <ChevronRight size={13} className={cn("shrink-0 text-neutral-600 transition-transform", expandable && open ? "rotate-90 text-neutral-400" : "", !expandable && "opacity-0")} />
        <span className="shrink-0">{icon}</span>
        <span className={cn("min-w-0 flex-1 truncate", node.kind === 'prototype' && "text-neutral-200")}>{label}</span>
        {meta && <span className="shrink-0 text-[10px] text-neutral-600">{meta}</span>}
      </button>
      {expandable && open && (
        <div>
          {children.map((child) => (
            <div key={`${child.kind}:${child.path}:${child.prototypeKey ?? child.name}`}>
              <ResourceNode
                node={child}
                depth={depth + 1}
                openPaths={openPaths}
                selectedPrototypeId={selectedPrototypeId}
                selectedRsiPath={selectedRsiPath}
                onToggle={onToggle}
                onSelect={onSelect}
                onSelectRsi={onSelectRsi}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function text(value: unknown) {
  return value == null ? '' : String(value);
}
