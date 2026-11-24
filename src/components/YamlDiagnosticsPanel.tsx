import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, FileWarning } from 'lucide-react';
import { studio, type YamlSyntaxReport } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { yamlSyntaxHint } from '../lib/yaml-diagnostics-hint';
import { useI18n } from '../i18n';

export function YamlDiagnosticResult({ report, onRevealLine }: { report: YamlSyntaxReport; onRevealLine: (line: number) => void }) {
  const { t, language } = useI18n();
  return <button type="button" className="yaml-diagnostics-error" onClick={() => onRevealLine(report.line ?? 1)}>
    <AlertCircle size={15}/>
    <span>{report.line ?? '?'}:{report.column ?? '?'} — {report.message ?? t('yamlDiagnostics.error')}<br/>
      <strong>{t('yamlDiagnostics.fix')}</strong> {yamlSyntaxHint(report.valid, report.message, language)}</span>
  </button>;
}

interface Props {
  path: string;
  source: string;
  enabled: boolean;
  delayMs: number;
  onRevealLine: (line: number) => void;
}
interface Snapshot {
  path: string;
  source: string;
  report: YamlSyntaxReport;
}

/** Read-only draft validation, with stale-request results discarded. */
export default function YamlDiagnosticsPanel({ path, source, enabled, delayMs, onRevealLine }: Props) {
  const { t, language } = useI18n();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failure, setFailure] = useState<StudioError | null>(null);
  const [manual, setManual] = useState<{ path: string; source: string; token: number } | null>(null);
  const shouldRun = enabled || (manual?.path === path && manual.source === source);

  useEffect(() => {
    if (!shouldRun) return;
    let active = true;
    setFailure(null);
    const timer = window.setTimeout(() => {
      void studio.analyzeYamlResource(path, source).then((report) => {
        if (!active) return;
        setSnapshot({ path, source, report });
        setFailure(null);
      }).catch((error: unknown) => {
        if (!active) return;
        setSnapshot(null);
        setFailure(normalizeStudioError(error));
      });
    }, enabled ? delayMs : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [path, source, enabled, delayMs, shouldRun, manual?.token]);

  const report = shouldRun && snapshot?.path === path && snapshot.source === source
    ? snapshot.report : null;

  return <section className="yaml-diagnostics" aria-label={t('yamlDiagnostics.title')}>
    <header>
      <FileWarning size={16}/><strong>{t('yamlDiagnostics.title')}</strong>
      <small>{t('yamlDiagnostics.readOnly')}</small>
      {!enabled && <button type="button" onClick={() => setManual((current) => ({
        path, source, token: (current?.token ?? 0) + 1,
      }))}>{t('yamlDiagnostics.checkNow')}</button>}
    </header>
    {!shouldRun ? <p>{t('yamlDiagnostics.disabled')}</p>
      : failure ? <p role="alert"><AlertCircle size={15}/> {language === 'ru' ? `${failure.message} ${failure.hint}` : t('yamlDiagnostics.failure')}</p>
        : report?.valid ? <p role="status"><CheckCircle2 size={15}/>
          {t('yamlDiagnostics.valid')}</p>
          : report ? <YamlDiagnosticResult report={report} onRevealLine={onRevealLine}/>
            : <p role="status">{t('yamlDiagnostics.loading')}</p>}
    <footer>{t('yamlDiagnostics.scope')}</footer>
  </section>;
}
