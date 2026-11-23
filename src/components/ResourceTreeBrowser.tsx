import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FileCode2, FileText, Folder, FolderOpen, Image as ImageIcon } from 'lucide-react';
import { useI18n } from '../i18n';
import { studio, type PrototypeDeclaration, type ResourceBrowserEntry, type ResourceBrowserPage, type ResourceEntry, type SourceOutline } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { RESOURCE_TREE_MAX_DEPTH, RESOURCE_TREE_PAGE_SIZE, treePageOffset, treePrototypes, treePrototypeKey } from '../lib/resource-tree';

interface Props {
  selectedPath: string | null;
  onOpen: (entry: ResourceEntry) => void;
  onOpenPrototype: (path: string, line: number, entry: PrototypeDeclaration) => void;
}

function TreeIcon({ kind, expanded = false }: { kind: ResourceBrowserEntry['kind']; expanded?: boolean }) {
  if (kind === 'folder') return expanded ? <FolderOpen size={14}/> : <Folder size={14}/>;
  if (kind === 'rsi') return <ImageIcon size={14}/>;
  if (kind === 'ftl') return <FileText size={14}/>;
  return <FileCode2 size={14}/>;
}

/** Electron sidebar tree, loaded one folder at a time by the native index. */
function TreeDirectory({ directory, name, depth, selectedPath, onOpen, onOpenPrototype, initialOpen = false }:
  Props & { directory: string; name: string; depth: number; initialOpen?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(initialOpen);
  const [page, setPage] = useState(0);
  const [loaded, setLoaded] = useState<{ directory: string; page: number; value: ResourceBrowserPage } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!expanded || depth >= RESOURCE_TREE_MAX_DEPTH) return;
    let active = true;
    setLoading(true);
    setError(null);
    void studio.browseResourceFolder(directory, treePageOffset(page), RESOURCE_TREE_PAGE_SIZE)
      .then((value) => { if (active) setLoaded({ directory, page, value }); })
      .catch((reason) => {
        if (active) { setLoaded(null); setError(normalizeStudioError(reason)); }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [expanded, directory, page, retry, depth]);

  const result = loaded?.directory === directory && loaded.page === page ? loaded.value : null;
  const offset = treePageOffset(page);
  return <div className="resource-tree-branch">
    <button type="button" className="resource-tree-row" style={{ paddingLeft: 8 + depth * 14 }}
      title={directory} aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}>
      {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
      <TreeIcon kind="folder" expanded={expanded}/><span>{name}</span>
      {loading && <small>{t('browser.loading')}</small>}
    </button>
    {expanded && <div className="resource-tree-children">
      {error && <p className="resource-tree-error" role="alert">
        <AlertTriangle size={13}/>{error.message}
        <button type="button" onClick={() => setRetry((x) => x + 1)}>{t('browser.retry')}</button>
      </p>}
      {!loading && result?.total === 0 && <p className="muted">{t('browser.empty')}</p>}
      {result?.items.map((entry) => entry.kind === 'folder'
        ? <TreeDirectory key={entry.path} directory={entry.path} name={entry.name}
            depth={depth + 1} selectedPath={selectedPath} onOpen={onOpen}
            onOpenPrototype={onOpenPrototype}/>
        : entry.kind === 'yaml'
          ? <TreeYaml key={entry.path} entry={entry} depth={depth + 1}
              selectedPath={selectedPath} onOpen={onOpen} onOpenPrototype={onOpenPrototype}/>
          : <button type="button" key={entry.path} title={entry.path}
              className={'resource-tree-row' + (selectedPath === entry.path ? ' active' : '')}
              style={{ paddingLeft: 8 + (depth + 1) * 14 }}
              onClick={() => onOpen({ path: entry.path, kind: entry.kind as ResourceEntry['kind'] })}>
              <span className="resource-tree-spacer"/><TreeIcon kind={entry.kind}/><span>{entry.name}</span>
            </button>)}
      {result && offset + result.items.length < result.total && <button type="button"
        className="resource-tree-page" disabled={loading}
        onClick={() => setPage((n) => n + 1)}>
        {t('browser.next')} · {t('common.countRange', {
          from: offset + result.items.length + 1,
          to: Math.min(offset + result.items.length + RESOURCE_TREE_PAGE_SIZE, result.total),
          total: result.total,
        })}
      </button>}
      {page > 0 && <button type="button" className="resource-tree-page"
        disabled={loading} onClick={() => setPage((n) => Math.max(0, n - 1))}>
        {t('browser.prev')}
      </button>}
    </div>}
  </div>;
}

/** Electron displayed prototypes inside YAML files. Read and parse only
 * when the user expands that exact indexed file; never scan all YAML at once.
 */
function TreeYaml({ entry, depth, selectedPath, onOpen, onOpenPrototype }:
  Props & { entry: ResourceBrowserEntry; depth: number }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [outline, setOutline] = useState<SourceOutline | null>(null);
  const [error, setError] = useState<StudioError | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!expanded || outline) return;
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const document = await studio.readResource(entry.path);
        if (!active) return;
        const inspected = await studio.inspectYamlOutline(entry.path, document.content);
        if (active) setOutline(inspected);
      } catch (reason) {
        if (active) setError(normalizeStudioError(reason));
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [expanded, entry.path, outline]);

  const declarations = outline ? treePrototypes(outline) : [];
  return <div className="resource-tree-branch">
    <div className={'resource-tree-row' + (selectedPath === entry.path ? ' active' : '')}
      style={{ paddingLeft: 8 + depth * 14 }}>
      <button type="button" className="resource-tree-toggle" aria-expanded={expanded} data-resource-path={entry.path}
        title={expanded ? t('browser.collapse') : t('browser.expand')}
        onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
      </button>
      <button type="button" className="resource-tree-filename" title={entry.path}
        onClick={() => onOpen({ path: entry.path, kind: 'yaml' })}>
        <TreeIcon kind="yaml"/><span>{entry.name}</span>
      </button>
      {loading && <small>{t('browser.loading')}</small>}
    </div>
    {expanded && <div>
      {error && <p role="alert" className="resource-tree-error">
        <AlertTriangle size={13}/>{error.message}
      </p>}
      {!loading && !error && outline && declarations.length === 0
        && <p className="muted">{t('browser.noPrototypes')}</p>}
      {declarations.map((item) => <button type="button" className="resource-tree-row"
        data-testid="tree-prototype" data-prototype-id={item.id} data-resource-path={item.file}
        key={treePrototypeKey(item)}
        style={{ paddingLeft: 8 + (depth + 1) * 14 }}
        title={item.file + ':' + item.line}
        onClick={() => onOpenPrototype(item.file, item.line, item)}>
        <span className="resource-tree-spacer"/><FileCode2 size={13}/>
        <span>{item.id}</span><small>{item.kind}</small>
      </button>)}
      {outline?.truncated && <p className="resource-tree-warning">{t('browser.prototypeTruncated')}</p>}
    </div>}
  </div>;
}

export default function ResourceTreeBrowser({ selectedPath, onOpen, onOpenPrototype }: Props) {
  const { t } = useI18n();
  return <div className="resource-tree" aria-label={t('browser.treeView')}>
    <TreeDirectory directory="Resources" name="Resources" initialOpen depth={0}
      selectedPath={selectedPath} onOpen={onOpen} onOpenPrototype={onOpenPrototype}/>
  </div>;
}
