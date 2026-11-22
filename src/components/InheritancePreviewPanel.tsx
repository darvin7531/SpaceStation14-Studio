import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { AlertCircle, GitMerge } from 'lucide-react';
import {
  studio, type PrototypeInheritancePreview,
} from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  kind: string;
  id: string;
  workspaceKey: string;
  onNavigate: (kind: string, id: string) => void;
  onOpen: (file: string, line: number) => void;
}

/** Read-only structural inheritance projection. This never claims the C#
 * DataField serialization result or writes anything to the workspace. */
export default function InheritancePreviewPanel({
  kind, id, workspaceKey, onNavigate, onOpen,
}: Props) {
  const { t } = useI18n();
  const [report, setReport] = useState<PrototypeInheritancePreview | null>(null);
  const [failure, setFailure] = useState<StudioError | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let current = true;
    setReport(null);
    setFailure(null);
    setBusy(true);
    void studio.prototypeInheritancePreview(kind, id).then((result) => {
      if (current) setReport(result);
    }).catch((error: unknown) => {
      if (current) setFailure(normalizeStudioError(error));
    }).finally(() => {
      if (current) setBusy(false);
    });
    return () => { current = false; };
  }, [kind, id, workspaceKey]);

  return <div className="proto-source-report" aria-label={t('inheritance.label')}>
    {busy && <p className="muted" role="status">
      {t('inheritance.loading')}
    </p>}
    {failure && <div role="alert" className="proto-error">
      <p><AlertCircle size={14}/> {failure.message}</p>
      <p>{failure.hint}</p>
      <code>{failure.code}</code>
    </div>}
    {report && <>
      <p className="proto-relations-caveat">
        <GitMerge size={14}/> {report.structural_complete
          ? t('inheritance.complete')
          : t('inheritance.incomplete')}
        {' '}{t('inheritance.caveat')}
      </p>
      {report.warnings.map((warning, index) =>
        <p key={index} className="proto-source-warning">{warning}</p>)}
      <div className="proto-source-tags">
        <strong>{t('inheritance.parents')}</strong>
        {report.direct_parents.length
          ? report.direct_parents.map((name, index) =>
              <button key={index} className="proto-relation-link" type="button"
                onClick={() => onNavigate(kind, name)}>{name}</button>)
          : <small>{t('inheritance.none')}</small>}
      </div>
      <div className="proto-source-tags">
        <strong>{t('inheritance.sources', { count: report.lineage.length })}</strong>
        {report.lineage.map((name, index) =>
          <button key={index} className="proto-relation-link" type="button"
            onClick={() => onNavigate(kind, name)}>{index + 1}. {name}</button>)}
      </div>
      <p className="proto-relations-caveat">
        {t('inheritance.partials', { count: report.total_partials })}
      </p>
      <strong className="proto-source-label">{t('inheritance.fields', { count: report.fields.length })}</strong>
      {report.fields.map((field) => <div key={field.key} className="proto-merged-row">
        <strong>{field.key}</strong>
        <span>{field.preview}</span>
        {field.source_file && <button className="proto-relation-source" type="button"
          title={t('inheritance.open', { file: field.source_file })}
          onClick={() => onOpen(field.source_file, 1)}>
          {field.source_file.split('/').at(-1)}
        </button>}
      </div>)}
      <strong className="proto-source-label">{t('inheritance.components', { count: report.components.length })}</strong>
      {report.components.map((component) => <div key={component.type_name} className="proto-merged-row">
        <strong>{component.type_name}</strong>
        <span>{component.keys.length ? component.keys.join(', ') : t('inheritance.noFields')}</span>
        {component.source_file && <button className="proto-relation-source" type="button"
          title={t('inheritance.open', { file: component.source_file })}
          onClick={() => onOpen(component.source_file, 1)}>
          {component.source_file.split('/').at(-1)}
        </button>}
      </div>)}
    </>}
  </div>;
}
