import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { studio, type ResourceEntry } from '../lib/api';
import { normalizeStudioError } from '../lib/errors';

interface Props {
  onClose: () => void;
  onOpen: (item: ResourceEntry) => void;
}

/** Bounded indexed search: the WebView never walks project directories. */
export default function QuickOpenPanel({ onClose, onOpen }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ResourceEntry[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => { previous?.focus(); };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailure(null);
    const timer = window.setTimeout(() => {
      void studio.searchResources(query, 'all', 0, 50)
        .then((page) => {
          if (!active) return;
          setItems(page.items);
          setSelected(0);
        })
        .catch((error: unknown) => {
          if (!active) return;
          const issue = normalizeStudioError(error);
          setFailure(issue.message + ' ' + issue.hint);
          setItems([]);
        })
        .finally(() => { if (active) setLoading(false); });
    }, 130);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query]);

  return <div className="quick-open-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="quick-open-dialog" role="dialog" aria-modal="true" aria-label={t('quick.title')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        else if (event.key === 'ArrowDown') {
          event.preventDefault(); setSelected((i) => Math.max(0, Math.min(items.length - 1, i + 1)));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault(); setSelected((i) => Math.max(0, i - 1));
        } else if (event.key === 'Enter' && !loading && items[selected]) {
          event.preventDefault(); onClose(); onOpen(items[selected]);
        }
      }}>
      <header>
        <Search size={18}/>
        <input ref={input} type="search" autoComplete="off" aria-label={t('quick.searchLabel')}
          placeholder={t('quick.placeholder')} value={query}
          onChange={(event) => setQuery(event.target.value)}/>
        <button type="button" aria-label={t('quick.close')} onClick={onClose}><X size={17}/></button>
      </header>
      <div className="quick-open-results" role="listbox" aria-label={t('quick.matches')}>
        {failure && <p role="alert">{failure}</p>}
        {!failure && loading && <p role="status">{t('quick.loading')}</p>}
        {!failure && !loading && items.length === 0 && <p>{t('quick.noMatches')}</p>}
        {!failure && !loading && items.map((item, index) =>
          <button type="button" role="option" key={item.path} aria-selected={index === selected}
            className={index === selected ? 'selected' : ''}
            onMouseEnter={() => setSelected(index)}
            onClick={() => { onClose(); onOpen(item); }}>
            <strong>{item.path.split('/').at(-1)}</strong>
            <span>{item.path}</span>
            <small>{item.kind.toUpperCase()}</small>
          </button>)}
      </div>
      <footer>{t('quick.shortcuts')}</footer>
    </section>
  </div>;
}
