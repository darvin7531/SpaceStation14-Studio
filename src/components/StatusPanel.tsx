import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { AlertTriangle, CheckCircle2, ChevronUp, RotateCcw } from 'lucide-react';
import {
  studio, type ProjectOverview, type ProjectScanProgress,
  type PrototypeDiagnosticPage,
} from '../lib/api';
import { type StudioError } from '../lib/errors';
import { appendStatusRecord, type StatusRecord } from '../lib/status-log';

interface Props {
  overview: ProjectOverview | null;
  scanProgress: ProjectScanProgress | null;
  opening: boolean;
  refreshing: boolean;
  dirtyCount: number;
  notice: string | null;
  error: StudioError | null;
  revision: number;
  onOpenIssue: (path: string, line: number) => void;
}

export default function StatusPanel({
  overview, scanProgress, opening, refreshing, dirtyCount,
  notice, error, revision, onOpenIssue,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(176);
  const [logs, setLogs] = useState<StatusRecord[]>([{
    id: 0, at: '', message: 'Готово к работе.', kind: 'info',
  }]);
  const [issues, setIssues] = useState<PrototypeDiagnosticPage | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const nextId = useRef(0);
  const drag = useRef<{ top: number; height: number } | null>(null);

  function add(message: string, kind: StatusRecord['kind']) {
    const entry: StatusRecord = {
      id: ++nextId.current,
      at: new Date().toLocaleTimeString(),
      message,
      kind,
    };
    setLogs((previous) => appendStatusRecord(previous, entry));
  }

  useEffect(() => {
    if (notice) add(notice, 'info');
  }, [notice]);

  useEffect(() => {
    if (error) add(error.message + ' [' + error.code + ']', 'error');
  }, [error]);

  useEffect(() => {
    if (scanProgress) add(
      'Индексирую ' + scanProgress.phase + ': ' + scanProgress.indexed_resources + ' ресурсов',
      'info',
    );
  }, [scanProgress]);

  useEffect(() => {
    if (overview) add('Проект открыт: ' + overview.project_root, 'info');
  }, [overview?.project_root]);

  useEffect(() => {
    if (!expanded || !overview) return;
    let active = true;
    setLoadingIssues(true);
    setIssueError(null);
    void studio.listPrototypeDiagnostics(0, 80).then((page) => {
      if (!active) return;
      setIssues(page);
      setIssueError(null);
    }).catch((reason: unknown) => {
      if (!active) return;
      setIssues(null);
      setIssueError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoadingIssues(false);
    });
    return () => { active = false; };
  }, [expanded, overview?.project_root, revision]);

  useEffect(() => {
    function move(event: globalThis.PointerEvent) {
      const state = drag.current;
      if (!state) return;
      setHeight(Math.max(120, Math.min(520, state.height + state.top - event.clientY)));
    }
    function release() {
      drag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      release();
    };
  }, []);

  function startResize(event: PointerEvent<HTMLDivElement>) {
    drag.current = { top: event.clientY, height };
    setExpanded(true);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }

  const headline = opening && scanProgress
    ? 'Индекс ' + scanProgress.phase + ': ' + scanProgress.indexed_resources + ' ресурсов'
    : refreshing ? 'Обновление индекса…' : logs[0]?.message ?? 'Готово к работе.';
  const issueCount = overview ? (issues?.total ?? null) : 0;
  return <footer className="studio-status-panel" style={{ height: expanded ? height : 32 }}>
    {expanded && <div className="studio-status-grip" title="Изменить размер панели"
      onPointerDown={startResize}/>}
    <button type="button" className="studio-status-summary" onClick={() => setExpanded((value) => !value)}
      aria-expanded={expanded} aria-label="Показать журнал состояния и диагностику">
      <span className="studio-status-summary-message">
        {error ? <AlertTriangle size={14}/> : <CheckCircle2 size={14}/>}
        <span title={headline}>{headline}</span>
      </span>
      <span className="studio-status-summary-counts">
        {overview && <>
          <small>{overview.prototype_files} YAML</small>
          <small>{overview.rsi_directories} RSI</small>
          <small>{overview.locale_files} FTL</small>
          <small>{dirtyCount} черновиков</small>
          {issueCount !== null && <small>{issueCount} ошибок индекса</small>}
        </>}
        <ChevronUp size={14} className={expanded ? 'studio-status-arrow-open' : ''}/>
      </span>
    </button>
    {expanded && <div className="studio-status-detail">
      <div className="studio-status-events" aria-label="Журнал событий редактора">
        <strong>Журнал</strong>
        {logs.map((item) => <div key={item.id}
          className={'studio-status-log-entry studio-status-log-' + item.kind}>
          <time>{item.at}</time><span>{item.message}</span>
        </div>)}
      </div>
      <div className="studio-status-issues" aria-label="Ошибки прототипов">
        <div className="studio-status-issues-head">
          <strong>Проблемы YAML</strong>
          {overview && <button type="button" disabled={loadingIssues}
            title="Повторить проверку индекса" onClick={() => {
              setLoadingIssues(true);
              setIssueError(null);
              void studio.listPrototypeDiagnostics(0, 80).then(setIssues)
                .catch((err) => setIssueError(err instanceof Error ? err.message : String(err)))
                .finally(() => setLoadingIssues(false));
            }}><RotateCcw size={13}/> Обновить</button>}
        </div>
        {!overview ? <p>Откройте игровой проект.</p>
          : loadingIssues ? <p>Проверяю индекс…</p>
            : issueError ? <p role="alert">{issueError}</p>
              : issues?.total === 0 ? <p>Индекс не сообщает об ошибках прототипов.</p>
                : issues ? <>
                  {issues.items.map((issue, i) => <button type="button"
                    key={issue.file + ':' + issue.line + ':' + issue.code + ':' + i}
                    onClick={() => onOpenIssue(issue.file, issue.line)}
                    className="studio-status-issue">
                    <b>{issue.code}</b><span>{issue.message}</span>
                    <small>{issue.file}:{issue.line}</small>
                  </button>)}
                  {issues.total > issues.items.length && <small>
                    Показаны первые {issues.items.length} из {issues.total}. Полный список доступен в каталоге.
                  </small>}
                </> : <p>Данные диагностики ещё не загружены.</p>}
      </div>
    </div>}
  </footer>;
}
