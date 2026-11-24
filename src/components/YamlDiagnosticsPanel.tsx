import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, FileWarning } from 'lucide-react';
import { studio, type YamlSyntaxReport } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { yamlSyntaxHint } from '../lib/yaml-diagnostics-hint';

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

  return <section className="yaml-diagnostics" aria-label="Проверка YAML">
    <header>
      <FileWarning size={16}/><strong>Проверка YAML</strong>
      <small>Без записи на диск</small>
      {!enabled && <button type="button" onClick={() => setManual((current) => ({
        path, source, token: (current?.token ?? 0) + 1,
      }))}>Проверить сейчас</button>}
    </header>
    {!shouldRun ? <p>Автопроверка отключена. Можно проверить текущий текст вручную.</p>
      : failure ? <p role="alert"><AlertCircle size={15}/> {failure.message} {failure.hint}</p>
        : report?.valid ? <p role="status"><CheckCircle2 size={15}/>
          Синтаксис YAML корректен.</p>
          : report ? <button type="button" className="yaml-diagnostics-error"
              onClick={() => onRevealLine(report.line ?? 1)}>
              <AlertCircle size={15}/>
              <span>{report.line ?? '?'}:{report.column ?? '?'} — {report.message ?? 'Ошибка синтаксиса YAML'}<br/>
                <strong>Как исправить:</strong> {yamlSyntaxHint(report.valid)}</span>
            </button>
            : <p role="status">Проверка текущего черновика…</p>}
    <footer>Проверяется синтаксис YAML, не типы компонентов, наследование или правила RobustToolbox.</footer>
  </section>;
}
