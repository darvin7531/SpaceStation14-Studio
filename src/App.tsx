/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CSSProperties, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { useProjectStore } from './store/projectStore';
import { scanProject, selectProject } from './services/scanner';
import Sidebar from './components/Sidebar';
import Editor from './components/Editor';
import Inspector from './components/Inspector';
import RsiEditor from './components/RsiEditor';
import IssueCard from './components/IssueCard';
import { UpdateState } from './types';
import { AlertTriangle, CheckCircle2, ChevronUp, Download, FolderOpen, Minus, RefreshCw, Square, X } from 'lucide-react';

export default function App() {
  const { 
    setProject,
    setSearchQuery,
    setSelectedPrototypeId,
    setSelectedPrototype,
    setIsScanning,
    setScanProgress,
    isScanning,
    scanProgress,
    counts,
    validationIssues,
    selectedRsi,
  } = useProjectStore();
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusLog, setStatusLog] = useState<string[]>(['Ready. Open an SS14 source folder to begin.']);
  const [statusHeight, setStatusHeight] = useState(176);
  const [isBooting, setIsBooting] = useState(true);
  const [updateState, setUpdateState] = useState<UpdateState>({
    status: 'idle',
    message: 'Ready to check for updates.',
    version: '0.0.0',
    progress: null,
    downloadedVersion: null,
  });
  const footerResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const state = footerResizeRef.current;
      if (!state) return;
      const nextHeight = Math.max(120, Math.min(520, state.startHeight + (state.startY - event.clientY)));
      setStatusHeight(nextHeight);
      setStatusOpen(true);
    };

    const onPointerUp = () => {
      footerResizeRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  const handleFooterResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    footerResizeRef.current = { startY: event.clientY, startHeight: statusHeight };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    setStatusOpen(true);
  };

  useEffect(() => {
    return window.prototypeStudio.onScanProgress((progress) => {
      const message = `${progress.stage}: ${progress.message}`;
      setScanProgress(message);
      setStatusLog((items) => [`${new Date().toLocaleTimeString()}  ${message}`, ...items].slice(0, 80));
    });
  }, [setScanProgress]);

  useEffect(() => {
    let cancelled = false;
    void window.prototypeStudio.getUpdateState().then((state) => {
      if (!cancelled) setUpdateState(state);
    });
    const unsubscribe = window.prototypeStudio.onUpdateStatus((state) => {
      setUpdateState(state);
      setStatusLog((items) => [`${new Date().toLocaleTimeString()}  update: ${state.message}`, ...items].slice(0, 80));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const restored = await window.prototypeStudio.restoreLastProject();
        if (!restored || cancelled) return;

        setProject(restored);
        if (restored.searchQuery) setSearchQuery(restored.searchQuery);
        if (restored.selectedPrototypeId) {
          setSelectedPrototypeId(restored.selectedPrototypeId);
          setSelectedPrototype(await window.prototypeStudio.getPrototype(restored.selectedPrototypeId));
        }

        setStatusLog((items) => [
          `${new Date().toLocaleTimeString()}  restored cached workspace: ${restored.counts.prototypes} prototypes`,
          ...items,
        ].slice(0, 80));

        setIsScanning(true);
        setScanProgress(`Checking ${restored.projectRoot} for changes`);
        const refreshed = await scanProject(restored.projectRoot);
        if (cancelled) return;
        setProject(refreshed);
        if (restored.searchQuery) setSearchQuery(restored.searchQuery);
        if (restored.selectedPrototypeId) {
          setSelectedPrototypeId(restored.selectedPrototypeId);
          setSelectedPrototype(await window.prototypeStudio.getPrototype(restored.selectedPrototypeId));
        }
        setStatusLog((items) => [
          `${new Date().toLocaleTimeString()}  ${refreshed.cache?.hit ? 'workspace verified from cache' : 'workspace refreshed'}: ${refreshed.counts.prototypes} prototypes`,
          ...items,
        ].slice(0, 80));
      } catch (error) {
        console.warn('Workspace restore failed', error);
      } finally {
        if (!cancelled) {
          setIsScanning(false);
          setScanProgress('');
          setIsBooting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setIsScanning, setProject, setScanProgress, setSearchQuery, setSelectedPrototype, setSelectedPrototypeId]);

  const handleOpenProject = async () => {
    try {
      const projectRoot = await selectProject();
      if (!projectRoot) return;

      setIsScanning(true);
      setScanProgress(`Scanning ${projectRoot}`);
      setStatusLog((items) => [`${new Date().toLocaleTimeString()}  scan started: ${projectRoot}`, ...items].slice(0, 80));
      const result = await scanProject(projectRoot);
      setProject(result);
      setStatusLog((items) => [
        `${new Date().toLocaleTimeString()}  ${result.cache?.hit ? 'cache loaded' : 'scan complete'}: ${result.counts.prototypes} prototypes, ${result.counts.components} components, ${result.counts.rsis} RSI`,
        ...items,
      ].slice(0, 80));
    } catch (err) {
      console.error(err);
      setStatusLog((items) => [`${new Date().toLocaleTimeString()}  error: ${err instanceof Error ? err.message : 'Failed to open project.'}`, ...items].slice(0, 80));
      alert(err instanceof Error ? err.message : 'Failed to open project.');
    } finally {
      setIsScanning(false);
      setScanProgress('');
    }
  };

  const hasProject = counts.prototypes > 0 || counts.rsis > 0 || counts.components > 0;
  const isCheckingUpdates = updateState.status === 'checking' || updateState.status === 'available' || updateState.status === 'downloading';

  const handleCheckUpdates = async () => {
    try {
      const next = await window.prototypeStudio.checkForUpdates();
      setUpdateState(next);
    } catch (error) {
      console.error(error);
    }
  };

  const handleInstallUpdate = async () => {
    try {
      await window.prototypeStudio.installUpdate();
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-neutral-900 text-neutral-200 font-sans overflow-hidden">
      <div
        className="relative z-[70] h-9 border-b border-neutral-800 flex items-center justify-between bg-neutral-950 shrink-0 select-none"
        style={{ WebkitAppRegion: 'drag' } as CSSProperties}
      >
        <div className="px-3 text-xs font-semibold tracking-wide text-neutral-300">SS14 Studio</div>
        <div className="flex h-full" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
          <button className="titlebar-button" onClick={() => window.prototypeStudio.minimizeWindow()} title="Minimize">
            <Minus size={14} />
          </button>
          <button className="titlebar-button" onClick={() => window.prototypeStudio.toggleMaximizeWindow()} title="Maximize">
            <Square size={12} />
          </button>
          <button className="titlebar-button titlebar-close" onClick={() => window.prototypeStudio.closeWindow()} title="Close">
            <X size={15} />
          </button>
        </div>
      </div>

      <header className="h-14 border-b border-neutral-800 flex items-center px-4 justify-between bg-neutral-950 shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="font-semibold text-neutral-100 tracking-tight">SS14 Studio</h1>
          <button 
            onClick={handleOpenProject}
            disabled={isScanning}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium transition-colors disabled:opacity-50"
          >
            <FolderOpen size={16} />
            {isScanning ? 'Scanning...' : 'Open Project'}
          </button>
          <button
            onClick={updateState.status === 'downloaded' ? handleInstallUpdate : handleCheckUpdates}
            disabled={isCheckingUpdates || updateState.status === 'installing'}
            className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800 disabled:opacity-50"
            title={updateState.message}
          >
            {updateState.status === 'downloaded' ? (
              <Download size={16} />
            ) : (
              <RefreshCw size={16} className={isCheckingUpdates ? 'animate-spin' : ''} />
            )}
            {updateState.status === 'downloaded'
              ? 'Restart to Update'
              : updateState.status === 'downloading'
                ? `Downloading ${Math.round(updateState.progress?.percent ?? 0)}%`
                : updateState.status === 'installing'
                  ? 'Installing...'
                  : 'Check Updates'}
          </button>
        </div>
        <div className="max-w-md text-right text-xs text-neutral-400">
          <div className="truncate">{isScanning ? scanProgress : updateState.message}</div>
          {updateState.status === 'downloading' && (
            <div className="mt-1 text-[11px] text-neutral-500">
              {Math.round(updateState.progress?.percent ?? 0)}% downloaded
            </div>
          )}
        </div>
      </header>
      {(isScanning || isCheckingUpdates) && <div className={`studio-scan-strip shrink-0 ${updateState.status === 'downloading' ? 'studio-scan-strip--emerald' : ''}`} />}

      {/* Main Content */}
      {hasProject ? (
        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          <Sidebar />
          {selectedRsi ? <RsiEditor /> : <Editor />}
          <Inspector />
          {isScanning && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-neutral-950/28 backdrop-blur-[2px]">
              <LoadingPanel
                eyebrow="Project Scan"
                title="Updating workspace index"
                message={scanProgress || 'Scanning project files, prototypes, components and RSI assets.'}
                tone="blue"
              />
            </div>
          )}
        </div>
      ) : isBooting ? (
        <div className="flex-1 studio-boot-shell">
          <LoadingPanel
            eyebrow="SS14 Studio"
            title="Restoring previous workspace"
            message="Loading cached project state and checking the source tree for changes."
            tone="blue"
            fullScreen
          />
        </div>
      ) : isScanning ? (
        <div className="flex-1 studio-boot-shell">
          <LoadingPanel
            eyebrow="Project Scan"
            title="Opening SS14 project"
            message={scanProgress || 'Scanning project files, prototypes, components and RSI assets.'}
            tone="emerald"
            fullScreen
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center flex-col gap-4 text-neutral-500">
          <FolderOpen size={48} className="opacity-20" />
          <p>Open an SS14 source project folder to scan prototypes, components and RSI sprites.</p>
        </div>
      )}

      <footer
        className="border-t border-neutral-800 bg-neutral-950 shrink-0"
        style={{ height: statusOpen ? statusHeight : 32 }}
      >
        {statusOpen && (
          <div
            className="h-1 cursor-ns-resize bg-neutral-950 hover:bg-blue-500/50"
            onPointerDown={handleFooterResizeStart}
            title="Resize panel"
          />
        )}
        <button
          onClick={() => setStatusOpen(!statusOpen)}
          className="h-8 w-full px-3 flex items-center justify-between text-xs text-neutral-400 hover:bg-neutral-900"
        >
          <span className="flex items-center gap-2 truncate">
            {validationIssues.length > 0 ? <AlertTriangle size={14} className="text-yellow-500" /> : <CheckCircle2 size={14} className="text-green-500" />}
            <span className="truncate">{isScanning ? scanProgress : updateState.status === 'downloading' || updateState.status === 'downloaded' || updateState.status === 'error' ? updateState.message : statusLog[0]}</span>
          </span>
          <span className="flex items-center gap-4">
            <span className={updateState.status === 'error' ? 'text-red-400' : updateState.status === 'downloaded' ? 'text-emerald-400' : 'text-neutral-500'}>
              update: {formatUpdateLabel(updateState)}
            </span>
            <span>{counts.prototypes} prototypes</span>
            <span>{counts.components} components</span>
            <span>{counts.prototypeKinds} schemas</span>
            <span>{counts.rsis} RSI</span>
            <span>{validationIssues.length} issues</span>
            <ChevronUp size={14} className={statusOpen ? 'rotate-180' : ''} />
          </span>
        </button>
        {statusOpen && (
          <div className="grid grid-cols-[1fr_420px] h-[calc(100%-2.25rem)] border-t border-neutral-900 text-xs">
            <div className="overflow-auto custom-scrollbar p-3 font-mono text-neutral-400">
              {statusLog.map((item, index) => <div key={index}>{item}</div>)}
            </div>
            <div className="overflow-auto custom-scrollbar border-l border-neutral-900 p-3">
              <div className="text-neutral-300 font-semibold mb-2">Issues</div>
              {validationIssues.length === 0 ? (
                <div className="text-green-500">No indexed issues.</div>
              ) : validationIssues.slice(0, 80).map((issue, index) => (
                <div key={index} className="mb-2">
                  <IssueCard issue={issue} compact />
                </div>
              ))}
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}

function formatUpdateLabel(state: UpdateState) {
  switch (state.status) {
    case 'checking':
      return 'checking';
    case 'available':
      return `found ${state.downloadedVersion ?? ''}`.trim();
    case 'downloading':
      return `${Math.round(state.progress?.percent ?? 0)}%`;
    case 'downloaded':
      return 'ready';
    case 'installing':
      return 'installing';
    case 'error':
      return 'error';
    case 'unavailable':
      return 'latest';
    case 'disabled':
      return 'local build';
    default:
      return 'idle';
  }
}

function LoadingPanel({
  eyebrow,
  title,
  message,
  tone = 'blue',
  fullScreen = false,
}: {
  eyebrow: string;
  title: string;
  message: string;
  tone?: 'blue' | 'emerald';
  fullScreen?: boolean;
}) {
  return (
    <div className={fullScreen ? 'studio-loading-stage' : 'studio-loading-stage studio-loading-stage--floating'}>
      <div className={`studio-loading-card ${tone === 'emerald' ? 'studio-loading-card--emerald' : ''}`}>
        <div className="studio-loading-grid" />
        <div className="studio-loading-content">
          <div className="studio-loading-badge">{eyebrow}</div>
          <div className="studio-loading-core">
            <div className="studio-loading-orbit">
              <span />
              <span />
              <span />
            </div>
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-neutral-100">{title}</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-neutral-400">{message}</p>
            </div>
          </div>
          <div className="studio-loading-pulse">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    </div>
  );
}
