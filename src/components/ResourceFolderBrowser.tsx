import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { AlertTriangle, ChevronLeft, ChevronRight, Folder, FolderOpen, FileCode2, FileText, Image as ImageIcon } from 'lucide-react';
import { studio, type PrototypeDeclaration, type ResourceBrowserPage, type ResourceEntry } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { resourceBreadcrumbs } from '../lib/resource-breadcrumbs';
import ResourceTreeBrowser from './ResourceTreeBrowser';

interface Props {
  revision: number;
  selectedPath: string | null;
  onOpen: (resource: ResourceEntry) => void;
  onOpenPrototype: (path: string, line: number, entry: PrototypeDeclaration) => void;
}

const PAGE_SIZE = 100;

export default function ResourceFolderBrowser({ revision, selectedPath, onOpen, onOpenPrototype }: Props) {
  const { t } = useI18n();
  const [view, setView] = useState<'tree' | 'directory'>('tree');
  const [directory, setDirectory] = useState('Resources');
  const [page, setPage] = useState(0);
  const [loaded, setLoaded] = useState<{ directory: string; page: number; revision: number; value: ResourceBrowserPage } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<StudioError | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void studio.browseResourceFolder(directory, page * PAGE_SIZE, PAGE_SIZE)
      .then((value) => { if (active) setLoaded({ directory, page, revision, value }); })
      .catch((failure: unknown) => {
        if (active) { setLoaded(null); setError(normalizeStudioError(failure)); }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [directory, page, revision]);

  function navigate(path: string) {
    if (path === directory) return;
    setDirectory(path);
    setPage(0);
    setLoaded(null);
  }

  const breadcrumbs = resourceBreadcrumbs(directory);
  const result = loaded?.value;
  const stale = loading || !!error || loaded?.directory !== directory || loaded?.page !== page || loaded?.revision !== revision;
  return <div className="resource-folder-browser">
    <div className="resource-folder-view-switch" role="group" aria-label={t('browser.view')}>
      <button type="button" className={view === 'tree' ? 'selected' : ''} aria-pressed={view === 'tree'}
        onClick={() => setView('tree')}>{t('browser.treeView')}</button>
      <button type="button" className={view === 'directory' ? 'selected' : ''} aria-pressed={view === 'directory'}
        onClick={() => setView('directory')}>{t('browser.directoryView')}</button>
    </div>
    {view === 'tree' && <ResourceTreeBrowser revision={revision} selectedPath={selectedPath} onOpen={onOpen}
      onOpenPrototype={onOpenPrototype}/>}
    <div className="resource-folder-directory" hidden={view !== 'directory'}>
    <nav className="resource-folder-breadcrumbs" aria-label={t('browser.path')}>
      {breadcrumbs.map((segment, index) => <span key={segment.path}>
        {index > 0 && <span aria-hidden="true"> / </span>}
        <button type="button" disabled={segment.path === directory}
          onClick={() => navigate(segment.path)} title={segment.path}>{segment.name}</button>
      </span>)}
    </nav>
    {error && <p className="rsi-error" role="alert"><AlertTriangle size={14}/>
      {error.message} {error.hint}</p>}
    <div className="resource-list" aria-busy={stale} aria-disabled={stale}
      onClickCapture={(event) => { if (stale) { event.preventDefault(); event.stopPropagation(); } }}>
      {result?.parent && <button type="button" className="resource-row" onClick={() => navigate(result.parent!)}>
        <FolderOpen size={15}/><span>..</span><small>{t('browser.back')}</small>
      </button>}
      {!loading && result?.total === 0 && <p className="muted">{t('browser.empty')}</p>}
      {loading && <p className="muted" role="status">{t('browser.loading')}</p>}
      {result?.items.map((entry) =>
        <button key={entry.path} type="button" title={entry.path}
          className={'resource-row' + (selectedPath === entry.path ? ' active' : '')}
          onClick={() => entry.kind === 'folder'
            ? navigate(entry.path)
            : onOpen({ path: entry.path, kind: entry.kind as ResourceEntry['kind'] })}>
          {entry.kind === 'folder' ? <Folder size={15}/>
            : entry.kind === 'rsi' ? <ImageIcon size={15}/>
              : entry.kind === 'ftl' ? <FileText size={15}/> : <FileCode2 size={15}/>}
          <span>{entry.name}</span>
          <small>{entry.kind === 'folder' ? entry.descendant_resources : entry.kind.toUpperCase()}</small>
        </button>)}
    </div>
    <div className="pagination">
      <button type="button" aria-label={t('browser.prev')} disabled={page === 0 || stale}
        onClick={() => setPage((value) => value - 1)}><ChevronLeft size={17}/></button>
      <span>{result?.total
        ? t('common.countRange', {
            from: page * PAGE_SIZE + 1, to: Math.min((page + 1) * PAGE_SIZE, result.total),
            total: result.total,
          })
        : t('common.totalItems', { count: 0 })}</span>
      <button type="button" aria-label={t('browser.next')}
        disabled={stale || !result || (page + 1) * PAGE_SIZE >= result.total}
        onClick={() => setPage((value) => value + 1)}><ChevronRight size={17}/></button>
    </div>
    </div>
  </div>;
}
