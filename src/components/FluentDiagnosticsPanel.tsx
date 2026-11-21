import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, FileWarning } from 'lucide-react';
import { studio, type FluentAnalysis } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  path: string;
  source: string;
  onRevealLine: (line: number) => void;
}

interface Inspection {
  path: string;
  source: string;
  result: FluentAnalysis;
}

/**
 * Runs only for the selected indexed .ftl, after the user stops typing.
 * Source + path identity ensures a delayed native result cannot display
 * findings from an old tab or an obsolete draft.
 */
export default function FluentDiagnosticsPanel({ path, source, onRevealLine }: Props) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [failure, setFailure] = useState<StudioError | null>(null);

  useEffect(() => {
    let active = true;
    setFailure(null);
    const handle = window.setTimeout(() => {
      void studio.analyzeFluentResource(path, source).then((result) => {
        if (!active) return;
        setInspection({ path, source, result });
        setFailure(null);
      }).catch((error: unknown) => {
        if (!active) return;
        setInspection(null);
        setFailure(normalizeStudioError(error));
      });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(handle);
    };
  }, [path, source]);

  const visible = inspection?.path === path && inspection.source === source
    ? inspection.result
    : null;

  return <section className="fluent-diagnostics" aria-label="Диагностика Fluent">
    <div className="fluent-diagnostics-heading">
      <FileWarning size={16}/>
      <strong>Проверка Fluent</strong>
      <small>Только текущий текст · файл не изменяется</small>
      {visible && <span>
        {visible.diagnostic_count === 0
          ? 'Ошибок нет'
          : 'Ошибок: ' + visible.diagnostic_count}
      </span>}
    </div>
    {visible ? visible.diagnostics.length > 0
      ? <div className="fluent-diagnostics-list">
        {visible.diagnostics.map((problem, index) =>
          <button type="button" key={problem.line + ':' + problem.column + ':' + index}
            className="fluent-diagnostics-item"
            title={problem.details}
            onClick={() => onRevealLine(problem.line)}>
            <AlertCircle size={15} className="fluent-diagnostics-error-icon"/>
            <span className="fluent-diagnostics-pos">{problem.line}:{problem.column}</span>
            <span className="fluent-diagnostics-message">{problem.message}
              <small>{problem.details}</small>
            </span>
          </button>)}
        {visible.truncated && <p className="fluent-diagnostics-more">
          Показаны первые {visible.diagnostics.length} ошибок из {visible.diagnostic_count}.
          Исправьте их, чтобы увидеть остальные.
        </p>}
      </div>
      : <div className="fluent-diagnostics-ok" role="status">
        <CheckCircle2 size={15}/>
        Синтаксических ошибок не обнаружено · объявлений: {visible.entry_count}.
      </div>
      : failure
        ? <div className="fluent-diagnostics-failure" role="alert">
          <AlertCircle size={15}/>{failure.message} {failure.hint}
          {failure.details && <details><summary>Техническая ошибка</summary>{failure.details}</details>}
        </div>
        : <p className="fluent-diagnostics-loading" role="status">Проверяю текущую версию…</p>}
    <p className="fluent-diagnostics-notice">
      Проверяется стандартный синтаксис Fluent. Наличие ключей в других файлах и расширения конкретного форка пока не анализируются.
      Проверка не блокирует сохранение незаконченного черновика.
    </p>
  </section>;
}
