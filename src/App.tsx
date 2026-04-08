/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CSSProperties, useEffect, useState } from 'react';
import { useProjectStore } from './store/projectStore';
import { scanProject, selectProject } from './services/scanner';
import Sidebar from './components/Sidebar';
import Editor from './components/Editor';
import Inspector from './components/Inspector';
import { AlertTriangle, CheckCircle2, ChevronUp, FolderOpen, Minus, Square, X } from 'lucide-react';

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
  } = useProjectStore();
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusLog, setStatusLog] = useState<string[]>(['Ready. Open an SS14 source folder to begin.']);

  useEffect(() => {
    return window.prototypeStudio.onScanProgress((progress) => {
      const message = `${progress.stage}: ${progress.message}`;
      setScanProgress(message);
      setStatusLog((items) => [`${new Date().toLocaleTimeString()}  ${message}`, ...items].slice(0, 80));
    });
  }, [setScanProgress]);

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

  const hasProject = counts.prototypes > 0;

  return (
    <div className="flex flex-col h-screen bg-neutral-900 text-neutral-200 font-sans overflow-hidden">
      <div
        className="h-9 border-b border-neutral-800 flex items-center justify-between bg-neutral-950 shrink-0 select-none"
        style={{ WebkitAppRegion: 'drag' } as CSSProperties}
      >
        <div className="px-3 text-xs font-semibold tracking-wide text-neutral-300">Prototype Studio</div>
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
          <h1 className="font-semibold text-neutral-100 tracking-tight">SS14 Prototype Editor</h1>
          <button 
            onClick={handleOpenProject}
            disabled={isScanning}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium transition-colors disabled:opacity-50"
          >
            <FolderOpen size={16} />
            {isScanning ? 'Scanning...' : 'Open Project'}
          </button>
        </div>
        {isScanning && (
          <div className="text-xs text-neutral-400 max-w-md truncate">
            {scanProgress}
          </div>
        )}
      </header>

      {/* Main Content */}
      {hasProject ? (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <Sidebar />
          <Editor />
          <Inspector />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center flex-col gap-4 text-neutral-500">
          <FolderOpen size={48} className="opacity-20" />
          <p>Open an SS14 source project folder to scan prototypes, components and RSI sprites.</p>
        </div>
      )}

      <footer className={`border-t border-neutral-800 bg-neutral-950 shrink-0 ${statusOpen ? 'h-44' : 'h-8'}`}>
        <button
          onClick={() => setStatusOpen(!statusOpen)}
          className="h-8 w-full px-3 flex items-center justify-between text-xs text-neutral-400 hover:bg-neutral-900"
        >
          <span className="flex items-center gap-2 truncate">
            {validationIssues.length > 0 ? <AlertTriangle size={14} className="text-yellow-500" /> : <CheckCircle2 size={14} className="text-green-500" />}
            <span className="truncate">{isScanning ? scanProgress : statusLog[0]}</span>
          </span>
          <span className="flex items-center gap-4">
            <span>{counts.prototypes} prototypes</span>
            <span>{counts.components} components</span>
            <span>{counts.prototypeKinds} schemas</span>
            <span>{counts.rsis} RSI</span>
            <span>{validationIssues.length} issues</span>
            <ChevronUp size={14} className={statusOpen ? 'rotate-180' : ''} />
          </span>
        </button>
        {statusOpen && (
          <div className="grid grid-cols-[1fr_420px] h-[calc(100%-2rem)] border-t border-neutral-900 text-xs">
            <div className="overflow-auto custom-scrollbar p-3 font-mono text-neutral-400">
              {statusLog.map((item, index) => <div key={index}>{item}</div>)}
            </div>
            <div className="overflow-auto custom-scrollbar border-l border-neutral-900 p-3">
              <div className="text-neutral-300 font-semibold mb-2">Issues</div>
              {validationIssues.length === 0 ? (
                <div className="text-green-500">No indexed issues.</div>
              ) : validationIssues.slice(0, 80).map((issue, index) => (
                <div key={index} className="mb-2 rounded bg-neutral-900 p-2 text-neutral-300">
                  <span className={issue.level === 'error' ? 'text-red-400' : 'text-yellow-400'}>{issue.level}</span>
                  <span className="text-neutral-500"> / {issue.field}</span>
                  <div>{issue.message}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}
