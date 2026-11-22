import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, FileWarning } from 'lucide-react';
import { studio, type FluentInspection } from '../lib/api';
import { useI18n } from '../i18n';
import { ftlInspectorDetails } from '../lib/ftl-inspector';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  path: string;
  source: string;
  onRevealLine: (line: number) => void;
  onRevealSource: (path: string, line: number) => void;
  enabled: boolean;
  delayMs: number;
}

interface Inspection {
  path: string;
  source: string;
  result: FluentInspection;
}

/**
 * Runs only for the selected indexed .ftl, after the user stops typing.
 * Source + path identity ensures a delayed native result cannot display
 * findings from an old tab or an obsolete draft.
 */
export default function FluentDiagnosticsPanel({ path, source, onRevealLine, onRevealSource, enabled, delayMs }: Props) {
  const { t } = useI18n();
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [failure, setFailure] = useState<StudioError | null>(null);
  const [manual, setManual] = useState<{ path: string; source: string; token: number } | null>(null);
  const manualCurrent = manual?.path === path && manual.source === source;
  const shouldRun = enabled || manualCurrent;

  useEffect(() => {
    let active = true;
    if (!shouldRun) return;
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
    }, enabled ? delayMs : 0);
    return () => {
      active = false;
      window.clearTimeout(handle);
    };
  }, [path, source, enabled, delayMs, manual?.token, shouldRun]);

  const visible = shouldRun && inspection?.path === path && inspection.source === source
    ? inspection.result
    : null;
  const syntax = visible?.syntax;
  const locale = visible?.locale;
  const metadata = ftlInspectorDetails(path, source, syntax?.entry_count ?? null);

  return <section className="fluent-diagnostics" aria-label="Диагностика Fluent">
    <div className="fluent-resource-summary" aria-label={t('ftl.inspector')}>
      <strong>{t('ftl.inspector')}</strong>
      <dl>
        <div><dt>{t('ftl.path')}</dt><dd title={metadata.path}>{metadata.path}</dd></div>
        <div><dt>{t('ftl.locale')}</dt><dd>{metadata.locale ?? '—'}</dd></div>
        <div><dt>{t('ftl.entries')}</dt><dd>{metadata.entries ?? '—'}</dd></div>
        <div><dt>{t('ftl.characters')}</dt><dd>{metadata.characters}</dd></div>
      </dl>
    </div>
    <div className="fluent-diagnostics-heading">
      <FileWarning size={16}/>
      <strong>Проверка Fluent</strong>
      <small>Только текущий текст · файл не изменяется</small>
      {!enabled && <button type="button" className="fluent-check-now"
        onClick={() => setManual((old) => ({ path, source, token: (old?.token ?? 0) + 1 }))}>
        Проверить сейчас
      </button>}
      {syntax && <span>
        {syntax.diagnostic_count === 0
          ? 'Синтаксис: без ошибок'
          : 'Синтаксис: ' + syntax.diagnostic_count + ' ошибок'}
      </span>}
    </div>
    {syntax ? syntax.diagnostics.length > 0
      ? <div className="fluent-diagnostics-list">
        {syntax.diagnostics.map((problem, index) =>
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
        {syntax.truncated && <p className="fluent-diagnostics-more">
          Показаны первые {syntax.diagnostics.length} ошибок из {syntax.diagnostic_count}.
          Исправьте их, чтобы увидеть остальные.
        </p>}
      </div>
      : <div className="fluent-diagnostics-ok" role="status">
        <CheckCircle2 size={15}/>
        Синтаксических ошибок не обнаружено · объявлений: {syntax.entry_count}.
      </div>
      : !shouldRun
        ? <p className="fluent-diagnostics-loading">Автопроверка отключена. Для проверки нажмите «Проверить сейчас».</p>
        : failure
        ? <div className="fluent-diagnostics-failure" role="alert">
          <AlertCircle size={15}/>{failure.message} {failure.hint}
          {failure.details && <details><summary>Техническая ошибка</summary>{failure.details}</details>}
        </div>
        : <p className="fluent-diagnostics-loading" role="status">Проверяю текущую версию…</p>}
    {locale && <div className="fluent-locale-panel" aria-label="Ключи и ссылки Fluent">
      <div className="fluent-locale-heading">
        <strong>Ключи и ссылки · {locale.locale}</strong>
        <span>{locale.file_count} файлов · {locale.declaration_count} объявлений · {locale.reference_count} ссылок</span>
        <span>{locale.complete ? 'Индекс полный' : 'Индекс неполный'}</span>
      </div>
      {locale.warnings.map((warning, index) =>
        <p className="fluent-locale-warning" key={index}>{warning}</p>)}
      {locale.issues.length ? <div className="fluent-diagnostics-list">
        {locale.issues.map((issue, index) =>
          <div className="fluent-diagnostics-row"
            key={issue.code + ':' + issue.line + ':' + issue.symbol + ':' + index}>
            <button type="button" className="fluent-diagnostics-item"
              onClick={() => onRevealLine(issue.line)}>
              <AlertCircle size={15} className="fluent-diagnostics-error-icon"/>
              <span className="fluent-diagnostics-pos">{issue.line}</span>
              <span className="fluent-diagnostics-message">{issue.message}</span>
            </button>
            {issue.related_file && <button type="button" className="fluent-related-source"
              onClick={() => onRevealSource(issue.related_file!, issue.related_line ?? 1)}>
              Открыть другое объявление: {issue.related_file}{issue.related_line ? ':' + issue.related_line : ''}
            </button>}
          </div>)}
        {locale.truncated && <p className="fluent-diagnostics-more">
          Показаны первые {locale.issues.length} проблем из {locale.issue_count}.
        </p>}
      </div> : <p className="fluent-diagnostics-ok">
        {locale.complete
          ? 'Дубликатов и отсутствующих ссылок в этой локали не обнаружено.'
          : 'Среди проверенных объявлений дубликаты не обнаружены. Ссылки проверены частично.'}
      </p>}
    </div>}
    <p className="fluent-diagnostics-notice">
      Проверяются определения и ссылки в рамках одной локали. Отчёт не учитывает
      правила загрузки ресурсов SS14 и fallback между языками. Номер строки у ссылки
      соответствует началу объявления. Проверка не блокирует сохранение черновика.
    </p>
  </section>;
}
