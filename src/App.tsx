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
import SettingsModal from './components/SettingsModal';
import { useI18n } from './i18n';
import { UpdateState } from './types';
import { AlertTriangle, CheckCircle2, ChevronUp, FolderOpen, Minus, Settings, Square, X } from 'lucide-react';

export default function App() {
  const { t } = useI18n();
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statusLog, setStatusLog] = useState<string[]>([t('app.status.ready')]);
  const [statusHeight, setStatusHeight] = useState(176);
  const [isBooting, setIsBooting] = useState(true);
  const [updateState, setUpdateState] = useState<UpdateState>({
    status: 'idle',
    message: '',
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
    setStatusLog((items) => items.length === 0 ? [t('app.status.ready')] : items);
    setUpdateState((current) => current.message ? current : { ...current, message: t('app.checkUpdates') });
    document.title = t('app.title');
  }, [t]);

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
          `${new Date().toLocaleTimeString()}  ${t('app.status.restoredWorkspace', { count: restored.counts.prototypes })}`,
          ...items,
        ].slice(0, 80));

        setIsScanning(true);
        setScanProgress(`${t('loading.eyebrow.scan')}: ${restored.projectRoot}`);
        const refreshed = await scanProject(restored.projectRoot);
        if (cancelled) return;
        setProject(refreshed);
        if (restored.searchQuery) setSearchQuery(restored.searchQuery);
        if (restored.selectedPrototypeId) {
          setSelectedPrototypeId(restored.selectedPrototypeId);
          setSelectedPrototype(await window.prototypeStudio.getPrototype(restored.selectedPrototypeId));
        }
        setStatusLog((items) => [
          `${new Date().toLocaleTimeString()}  ${refreshed.cache?.hit ? t('app.status.workspaceVerified', { count: refreshed.counts.prototypes }) : t('app.status.workspaceRefreshed', { count: refreshed.counts.prototypes })}`,
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
      setScanProgress(`${t('loading.eyebrow.scan')}: ${projectRoot}`);
      setStatusLog((items) => [`${new Date().toLocaleTimeString()}  ${t('app.status.scanStarted', { path: projectRoot })}`, ...items].slice(0, 80));
      const result = await scanProject(projectRoot);
      setProject(result);
      setStatusLog((items) => [
        `${new Date().toLocaleTimeString()}  ${t('app.status.scanComplete', {
          mode: result.cache?.hit ? t('app.status.scanMode.cache') : t('app.status.scanMode.complete'),
          prototypes: result.counts.prototypes,
          components: result.counts.components,
          rsis: result.counts.rsis,
        })}`,
        ...items,
      ].slice(0, 80));
    } catch (err) {
      console.error(err);
      setStatusLog((items) => [`${new Date().toLocaleTimeString()}  ${t('app.status.error', { message: err instanceof Error ? err.message : t('sidebar.refreshFailed') })}`, ...items].slice(0, 80));
      alert(err instanceof Error ? err.message : t('sidebar.refreshFailed'));
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
        <div className="px-3 text-xs font-semibold tracking-wide text-neutral-300">{t('app.title')}</div>
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
          <h1 className="font-semibold text-neutral-100 tracking-tight">{t('app.title')}</h1>
          <button 
            onClick={handleOpenProject}
            disabled={isScanning}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium transition-colors disabled:opacity-50"
          >
            <FolderOpen size={16} />
            {isScanning ? t('app.scanning') : t('app.openProject')}
          </button>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSettingsOpen(true)}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-200 transition-colors hover:bg-neutral-800"
            title={t('settings.open')}
          >
            <Settings size={16} />
          </button>
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
                eyebrow={t('loading.eyebrow.scan')}
                title={t('app.projectScanOverlayTitle')}
                message={scanProgress || t('app.projectScanMessage')}
                tone="blue"
              />
            </div>
          )}
        </div>
      ) : isBooting ? (
        <div className="flex-1 studio-boot-shell">
          <LoadingPanel
            eyebrow={t('loading.eyebrow.app')}
            title={t('app.bootTitle')}
            message={t('app.bootMessage')}
            tone="blue"
            fullScreen
          />
        </div>
      ) : isScanning ? (
        <div className="flex-1 studio-boot-shell">
          <LoadingPanel
            eyebrow={t('loading.eyebrow.scan')}
            title={t('app.projectScanTitle')}
            message={scanProgress || t('app.projectScanMessage')}
            tone="emerald"
            fullScreen
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center flex-col gap-4 text-neutral-500">
          <FolderOpen size={48} className="opacity-20" />
          <p>{t('app.emptyState')}</p>
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
              update: {formatUpdateLabel(updateState, t)}
            </span>
            <span>{t('app.count.prototypes', { count: counts.prototypes })}</span>
            <span>{t('app.count.components', { count: counts.components })}</span>
            <span>{t('app.count.schemas', { count: counts.prototypeKinds })}</span>
            <span>{t('app.count.rsis', { count: counts.rsis })}</span>
            <span>{t('app.count.issues', { count: validationIssues.length })}</span>
            <ChevronUp size={14} className={statusOpen ? 'rotate-180' : ''} />
          </span>
        </button>
        {statusOpen && (
          <div className="grid grid-cols-[1fr_420px] h-[calc(100%-2.25rem)] border-t border-neutral-900 text-xs">
            <div className="overflow-auto custom-scrollbar p-3 font-mono text-neutral-400">
              {statusLog.map((item, index) => <div key={index}>{item}</div>)}
            </div>
            <div className="overflow-auto custom-scrollbar border-l border-neutral-900 p-3">
              <div className="text-neutral-300 font-semibold mb-2">{t('app.status.issues')}</div>
              {validationIssues.length === 0 ? (
                <div className="text-green-500">{t('app.status.issueNone')}</div>
              ) : validationIssues.slice(0, 80).map((issue, index) => (
                <div key={index} className="mb-2">
                  <IssueCard issue={issue} compact />
                </div>
              ))}
            </div>
          </div>
        )}
      </footer>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        updateState={updateState}
        onCheckUpdates={handleCheckUpdates}
        onInstallUpdate={handleInstallUpdate}
      />
    </div>
  );
}

function formatUpdateLabel(state: UpdateState, t: (key: string, params?: Record<string, string | number | null | undefined>) => string) {
  switch (state.status) {
    case 'checking':
      return t('app.updateLabel.checking');
    case 'available':
      return t('app.updateLabel.found', { version: state.downloadedVersion ?? '' }).trim();
    case 'downloading':
      return `${Math.round(state.progress?.percent ?? 0)}%`;
    case 'downloaded':
      return t('app.updateLabel.ready');
    case 'installing':
      return t('app.updateLabel.installing');
    case 'error':
      return t('app.updateLabel.error');
    case 'unavailable':
      return t('app.updateLabel.latest');
    case 'disabled':
      return t('app.updateLabel.local');
    default:
      return t('app.updateLabel.idle');
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
