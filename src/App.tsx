/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from './store/projectStore';
import { scanProject, selectProject } from './services/scanner';
import Sidebar from './components/Sidebar';
import Editor from './components/Editor';
import Inspector from './components/Inspector';
import RsiEditor from './components/RsiEditor';
import LocaleEditor from './components/LocaleEditor';
import TabBar from './components/TabBar';
import IssueCard from './components/IssueCard';
import SettingsModal from './components/SettingsModal';
import CreatePrototypeModal from './components/CreatePrototypeModal';
import CreateRsiModal from './components/CreateRsiModal';
import CreateLocaleModal from './components/CreateLocaleModal';
import { useI18n } from './i18n';
import { EditorResourceTab, UpdateState } from './types';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, FolderOpen, ImageIcon, Info, Languages, Menu, Minus, Plus, RefreshCw, Settings, Square, X } from 'lucide-react';

export default function App() {
  const { t } = useI18n();
  const setProject = useProjectStore((state) => state.setProject);
  const setSearchQuery = useProjectStore((state) => state.setSearchQuery);
  const setIsScanning = useProjectStore((state) => state.setIsScanning);
  const setScanProgress = useProjectStore((state) => state.setScanProgress);
  const isScanning = useProjectStore((state) => state.isScanning);
  const scanProgress = useProjectStore((state) => state.scanProgress);
  const counts = useProjectStore((state) => state.counts);
  const validationIssues = useProjectStore((state) => state.validationIssues);
  const projectRoot = useProjectStore((state) => state.projectRoot);
  const tabOrder = useProjectStore((state) => state.tabOrder);
  const tabsById = useProjectStore((state) => state.tabsById);
  const activeTabId = useProjectStore((state) => state.activeTabId);
  const openPrototypeTab = useProjectStore((state) => state.openPrototypeTab);
  const openRsiTab = useProjectStore((state) => state.openRsiTab);
  const openLocaleTab = useProjectStore((state) => state.openLocaleTab);
  const activateTab = useProjectStore((state) => state.activateTab);
  const closeTab = useProjectStore((state) => state.closeTab);
  const reorderTab = useProjectStore((state) => state.reorderTab);
  const updateActivePrototypeSaved = useProjectStore((state) => state.updateActivePrototypeSaved);
  const updateActiveRsiDetail = useProjectStore((state) => state.updateActiveRsiDetail);
  const updateActiveLocaleSaved = useProjectStore((state) => state.updateActiveLocaleSaved);
  const [statusOpen, setStatusOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'editor' | 'updates' | 'about'>('general');
  const [createPrototypeOpen, setCreatePrototypeOpen] = useState(false);
  const [createRsiOpen, setCreateRsiOpen] = useState(false);
  const [createLocaleOpen, setCreateLocaleOpen] = useState(false);
  const [statusLog, setStatusLog] = useState<string[]>([t('app.status.ready')]);
  const [statusHeight, setStatusHeight] = useState(176);
  const [isBooting, setIsBooting] = useState(true);
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({
    status: 'idle',
    message: '',
    version: '0.0.0',
    progress: null,
    downloadedVersion: null,
  });
  const footerResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const openTabs = useMemo(() => tabOrder.map((id) => tabsById[id]).filter(Boolean), [tabOrder, tabsById]);
  const activeTab = useMemo(() => activeTabId ? tabsById[activeTabId] ?? null : null, [activeTabId, tabsById]);

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
          openPrototypeTab(restored.selectedPrototypeId, await window.prototypeStudio.getPrototype(restored.selectedPrototypeId));
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
          openPrototypeTab(restored.selectedPrototypeId, await window.prototypeStudio.getPrototype(restored.selectedPrototypeId));
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
  }, [openPrototypeTab, setIsScanning, setProject, setScanProgress, setSearchQuery, t]);

  const openProjectRoot = useCallback(async (nextProjectRoot: string) => {
    try {
      setIsScanning(true);
      setScanProgress(`${t('loading.eyebrow.scan')}: ${nextProjectRoot}`);
      setStatusLog((items) => [`${new Date().toLocaleTimeString()}  ${t('app.status.scanStarted', { path: nextProjectRoot })}`, ...items].slice(0, 80));
      const result = await scanProject(nextProjectRoot);
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
    } finally {
      setIsScanning(false);
      setScanProgress('');
    }
  }, [setIsScanning, setProject, setScanProgress, t]);

  const handleOpenProject = useCallback(async () => {
    try {
      const nextProjectRoot = await selectProject();
      if (!nextProjectRoot) return;
      await openProjectRoot(nextProjectRoot);
    } catch (err) {
      console.error(err);
      setStatusLog((items) => [`${new Date().toLocaleTimeString()}  ${t('app.status.error', { message: err instanceof Error ? err.message : t('sidebar.refreshFailed') })}`, ...items].slice(0, 80));
      alert(err instanceof Error ? err.message : t('sidebar.refreshFailed'));
    } finally {
      setIsScanning(false);
      setScanProgress('');
    }
  }, [openProjectRoot, setIsScanning, setScanProgress, t]);

  const hasProject = counts.prototypes > 0 || counts.rsis > 0 || counts.locales > 0 || counts.components > 0;
  const isCheckingUpdates = updateState.status === 'checking' || updateState.status === 'available' || updateState.status === 'downloading';

  const handleCheckUpdates = useCallback(async () => {
    try {
      const next = await window.prototypeStudio.checkForUpdates();
      setUpdateState(next);
    } catch (error) {
      console.error(error);
    }
  }, []);

  const handleInstallUpdate = useCallback(async () => {
    try {
      await window.prototypeStudio.installUpdate();
    } catch (error) {
      console.error(error);
    }
  }, []);

  const handleRescanProject = useCallback(async () => {
    if (!useProjectStore.getState().projectRoot) return;
    try {
      await openProjectRoot(useProjectStore.getState().projectRoot!);
    } catch (error) {
      console.error(error);
    } finally {
      setIsScanning(false);
      setScanProgress('');
    }
  }, [openProjectRoot, setIsScanning, setScanProgress]);

  const handleOpenSettings = useCallback(() => {
    setSettingsTab('general');
    setSettingsOpen(true);
  }, []);

  const handleOpenAbout = useCallback(() => {
    setSettingsTab('about');
    setSettingsOpen(true);
  }, []);

  const handleCreatedPrototype = async (key: string) => {
    const currentProjectRoot = useProjectStore.getState().projectRoot;
    if (!currentProjectRoot) return;
    setIsScanning(true);
    setScanProgress(t('sidebar.refreshCreated', { value: key }));
    try {
      const result = await scanProject(currentProjectRoot);
      setProject(result);
      openPrototypeTab(key, await window.prototypeStudio.getPrototype(key));
    } catch (err) {
      alert(err instanceof Error ? err.message : t('sidebar.refreshFailed'));
    } finally {
      setIsScanning(false);
      setScanProgress('');
    }
  };

  const handleCreatedRsi = async (rsiPath: string) => {
    const currentProjectRoot = useProjectStore.getState().projectRoot;
    if (!currentProjectRoot) return;
    setIsScanning(true);
    setScanProgress(t('sidebar.refreshCreated', { value: rsiPath }));
    try {
      const result = await scanProject(currentProjectRoot);
      setProject(result);
      openRsiTab(rsiPath, await window.prototypeStudio.getRsiAsset(rsiPath));
    } catch (err) {
      alert(err instanceof Error ? err.message : t('sidebar.refreshFailed'));
    } finally {
      setIsScanning(false);
      setScanProgress('');
    }
  };

  const handleCreatedLocale = async (localePath: string) => {
    const currentProjectRoot = useProjectStore.getState().projectRoot;
    if (!currentProjectRoot) return;
    setIsScanning(true);
    setScanProgress(t('sidebar.refreshCreated', { value: localePath }));
    try {
      const result = await scanProject(currentProjectRoot);
      setProject(result);
      openLocaleTab(localePath, await window.prototypeStudio.getLocaleAsset(localePath));
    } catch (err) {
      alert(err instanceof Error ? err.message : t('sidebar.refreshFailed'));
    } finally {
      setIsScanning(false);
      setScanProgress('');
    }
  };

  const saveTab = useCallback(async (tab: EditorResourceTab) => {
    if (!projectRoot) return false;
    if (tab.kind === 'prototype') {
      const detail = tab.detail;
      if (!detail) return false;
      const saved = await window.prototypeStudio.savePrototype({
        projectRoot,
        filePath: detail.prototype._filePath,
        line: detail.prototype._line,
        text: tab.rawYaml,
      });
      activateTab(tab.id);
      updateActivePrototypeSaved(await window.prototypeStudio.getPrototype(tab.prototypeKey), saved.text);
      return true;
    }

    if (tab.kind === 'rsi') {
      if (!tab.detail) return false;
      activateTab(tab.id);
      const next = await window.prototypeStudio.saveRsiAsset({ path: tab.detail.path, meta: tab.detail.meta });
      if (next) {
        updateActiveRsiDetail(next, false);
        return true;
      }
      return false;
    }

    if (tab.kind === 'locale') {
      activateTab(tab.id);
      const next = await window.prototypeStudio.saveLocaleAsset({ path: tab.localePath, text: tab.text });
      if (next) {
        updateActiveLocaleSaved(next, next.text);
        return true;
      }
      return false;
    }

    return false;
  }, [activateTab, projectRoot, updateActiveLocaleSaved, updateActivePrototypeSaved, updateActiveRsiDetail]);

  const requestCloseTab = useCallback((tabId: string) => {
    const tab = useProjectStore.getState().tabsById[tabId];
    if (!tab) return;
    if (!tab.dirty) {
      closeTab(tabId);
      return;
    }
    activateTab(tabId);
    setPendingCloseTabId(tabId);
  }, [activateTab, closeTab]);

  const handleDiscardClose = useCallback(() => {
    if (!pendingCloseTabId) return;
    closeTab(pendingCloseTabId);
    setPendingCloseTabId(null);
  }, [closeTab, pendingCloseTabId]);

  const handleSaveClose = useCallback(async () => {
    if (!pendingCloseTabId) return;
    const tab = pendingCloseTabId ? useProjectStore.getState().tabsById[pendingCloseTabId] : null;
    if (!tab) {
      setPendingCloseTabId(null);
      return;
    }
    try {
      const saved = await saveTab(tab);
      if (!saved) return;
      closeTab(pendingCloseTabId);
      setPendingCloseTabId(null);
    } catch (error) {
      console.error(error);
    }
  }, [closeTab, pendingCloseTabId, saveTab]);

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

      <header className="h-14 border-b border-neutral-800 flex items-center gap-3 px-4 bg-neutral-950 shrink-0">
        <div className="flex items-center gap-4 shrink-0">
          <ActionsMenu
            hasProject={hasProject}
            onOpenProject={handleOpenProject}
            onOpenRecentProject={openProjectRoot}
            onCreatePrototype={() => setCreatePrototypeOpen(true)}
            onCreateRsi={() => setCreateRsiOpen(true)}
            onCreateLocale={() => setCreateLocaleOpen(true)}
            onRescanProject={handleRescanProject}
            onOpenSettings={handleOpenSettings}
            onOpenAbout={handleOpenAbout}
          />
        </div>
        <div className="min-w-0 flex-1 h-full">
          <TabBar
            tabs={openTabs}
            activeTabId={activeTabId}
            onActivate={activateTab}
            onClose={(tabId) => { void requestCloseTab(tabId); }}
            onReorder={reorderTab}
            emptyText={t('tabs.empty')}
          />
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handleOpenSettings}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-200 transition-colors hover:bg-neutral-800"
            title={t('settings.open')}
          >
            <Settings size={16} />
          </button>
        </div>
      </header>

      {(isScanning || isCheckingUpdates) && <div className={`studio-scan-strip shrink-0 ${updateState.status === 'downloading' ? 'studio-scan-strip--emerald' : ''}`} />}

      {hasProject ? (
        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          <Sidebar />
          {activeTab?.kind === 'rsi' ? <RsiEditor /> : activeTab?.kind === 'locale' ? <LocaleEditor /> : <Editor />}
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
            <span>{t('app.count.locales', { count: counts.locales })}</span>
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
        initialTab={settingsTab}
      />
      <CreatePrototypeModal open={createPrototypeOpen} onClose={() => setCreatePrototypeOpen(false)} onCreated={handleCreatedPrototype} />
      <CreateRsiModal open={createRsiOpen} onClose={() => setCreateRsiOpen(false)} onCreated={handleCreatedRsi} />
      <CreateLocaleModal open={createLocaleOpen} onClose={() => setCreateLocaleOpen(false)} onCreated={handleCreatedLocale} />
      {pendingCloseTabId && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4">
          <div className="w-[min(460px,96vw)] rounded-2xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl">
            <h3 className="text-lg font-semibold text-neutral-100">{t('tabs.unsavedTitle')}</h3>
            <p className="mt-2 text-sm text-neutral-400">{t('tabs.unsavedMessage')}</p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button onClick={() => setPendingCloseTabId(null)} className="rounded-md bg-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-700">
                {t('tabs.cancel')}
              </button>
              <button onClick={handleDiscardClose} className="rounded-md bg-red-700 px-4 py-2 text-sm text-white hover:bg-red-600">
                {t('tabs.discard')}
              </button>
              <button onClick={() => void handleSaveClose()} className="rounded-md bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-500">
                {t('tabs.saveAndClose')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuAction({
  icon,
  label,
  description,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-neutral-900"
    >
      <span className="mt-0.5 text-neutral-400">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm text-neutral-100">{label}</span>
        {description && <span className="block truncate text-xs text-neutral-500">{description}</span>}
      </span>
    </button>
  );
}

const ActionsMenu = memo(function ActionsMenu({
  hasProject,
  onOpenProject,
  onOpenRecentProject,
  onCreatePrototype,
  onCreateRsi,
  onCreateLocale,
  onRescanProject,
  onOpenSettings,
  onOpenAbout,
}: {
  hasProject: boolean;
  onOpenProject: () => void | Promise<void>;
  onOpenRecentProject: (projectRoot: string) => void | Promise<void>;
  onCreatePrototype: () => void;
  onCreateRsi: () => void;
  onCreateLocale: () => void;
  onRescanProject: () => void | Promise<void>;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.prototypeStudio.getRecentProjects().then((items) => {
      if (!cancelled) setRecentProjects(items);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current) return;
      if (menuRef.current.contains(event.target as Node)) return;
      setOpen(false);
    };

    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, []);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-3 text-sm text-neutral-200 transition-colors hover:bg-neutral-800"
        title={t('app.actionsMenu')}
      >
        <Menu size={16} />
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-11 z-50 w-72 rounded-xl border border-neutral-800 bg-neutral-950 p-2 shadow-xl">
          <MenuAction icon={<FolderOpen size={15} />} label={t('app.openProject')} onClick={() => { setOpen(false); void onOpenProject(); }} />
          {recentProjects.length > 0 && (
            <MenuAction
              icon={<FolderOpen size={15} />}
              label={t('app.recentProject')}
              description={recentProjects[0]}
              onClick={() => {
                setOpen(false);
                void onOpenRecentProject(recentProjects[0]);
              }}
            />
          )}
          {hasProject && (
            <>
              <div className="my-2 border-t border-neutral-800" />
              <MenuAction icon={<Plus size={15} />} label={t('app.createPrototype')} onClick={() => { setOpen(false); onCreatePrototype(); }} />
              <MenuAction icon={<ImageIcon size={15} />} label={t('app.createRsiSprite')} onClick={() => { setOpen(false); onCreateRsi(); }} />
              <MenuAction icon={<Languages size={15} />} label={t('app.createLocale')} onClick={() => { setOpen(false); onCreateLocale(); }} />
              <MenuAction icon={<RefreshCw size={15} />} label={t('app.rescanProject')} onClick={() => { setOpen(false); void onRescanProject(); }} />
            </>
          )}
          <div className="my-2 border-t border-neutral-800" />
          <MenuAction icon={<Settings size={15} />} label={t('settings.open')} onClick={() => { setOpen(false); onOpenSettings(); }} />
          <MenuAction icon={<Info size={15} />} label={t('app.aboutStudio')} onClick={() => { setOpen(false); onOpenAbout(); }} />
        </div>
      )}
    </div>
  );
});

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

const LoadingPanel = memo(function LoadingPanel({
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
});
