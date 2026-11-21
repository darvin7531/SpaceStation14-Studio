import { AlertTriangle, ArrowRight, RefreshCcw } from 'lucide-react';
import type { ResourceDriftReport } from '../lib/api';

interface Props {
  report: ResourceDriftReport;
  activePath: string | null;
  activeDirty: boolean;
  busy: boolean;
  onActivate: (path: string) => void;
  onCompare: () => void;
  onReload: () => void;
  onRefreshIndex: () => void;
}

export default function ResourceDriftBanner({
  report, activePath, activeDirty, busy, onActivate, onCompare, onReload, onRefreshIndex,
}: Props) {
  if (!report.items.length && !report.skipped) return null;

  return <section className="resource-drift-banner" role="status" aria-label="Внешние изменения файлов">
    <div className="resource-drift-heading">
      <AlertTriangle size={17}/>
      <strong>Внешние изменения файлов</strong>
      <span>Черновики не перезаписаны. Проверьте текущие версии файлов.</span>
      <button type="button" disabled={busy} onClick={onRefreshIndex}>
        <RefreshCcw size={14}/> Обновить индекс
      </button>
    </div>
    {report.items.map((item) => <div className="resource-drift-item" key={item.path}>
      <span className={item.status === 'changed' ? 'resource-drift-changed' : 'resource-drift-unavailable'}>
        {item.status === 'changed' ? 'Изменён' : 'Недоступен'}
      </span>
      <code title={item.path}>{item.path}</code>
      {item.error_code && <small title={item.error_code}>{item.error_code}</small>}
      {item.path !== activePath
        ? <button type="button" disabled={busy} onClick={() => onActivate(item.path)}>
          Перейти <ArrowRight size={13}/>
        </button>
        : item.status === 'unavailable'
          ? <button type="button" disabled={busy} onClick={onRefreshIndex}>
            Обновить индекс <ArrowRight size={13}/>
          </button>
          : activeDirty
            ? <button type="button" disabled={busy} onClick={onCompare}>
              Сравнить <ArrowRight size={13}/>
            </button>
            : <button type="button" disabled={busy} onClick={onReload}>
              Перечитать <ArrowRight size={13}/>
            </button>}
    </div>)}
    {report.skipped > 0 && <p>Пропущено файлов из-за лимита чтения: {report.skipped}.</p>}
  </section>;
}
