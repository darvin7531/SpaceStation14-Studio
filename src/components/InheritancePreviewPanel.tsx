import { useEffect, useState } from 'react';
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

  return <div className="proto-source-report" aria-label="Структурное наследование с partial">
    {busy && <p className="muted" role="status">
      Разбираю цепочку предков и применяю partial-правки в Rust…
    </p>}
    {failure && <div role="alert" className="proto-error">
      <p><AlertCircle size={14}/> {failure.message}</p>
      <p>{failure.hint}</p>
      <code>{failure.code}</code>
    </div>}
    {report && <>
      <p className="proto-relations-caveat">
        <GitMerge size={14}/> {report.structural_complete
          ? 'Все статические источники цепочки найдены и структурно объединены.'
          : 'Часть цепочки неоднозначна или неполна — показаны только доступные исходные данные.'}
        {' '}Это не окончательный игровой объект: правила C# DataField,
        пользовательские сериализаторы и значения по умолчанию здесь не вычисляются.
      </p>
      {report.warnings.map((warning, index) =>
        <p key={index} className="proto-source-warning">{warning}</p>)}
      <div className="proto-source-tags">
        <strong>Прямые родители:</strong>
        {report.direct_parents.length
          ? report.direct_parents.map((name, index) =>
              <button key={index} className="proto-relation-link" type="button"
                onClick={() => onNavigate(kind, name)}>{name}</button>)
          : <small>Нет</small>}
      </div>
      <div className="proto-source-tags">
        <strong>Источники в цепочке ({report.lineage.length}):</strong>
        {report.lineage.map((name, index) =>
          <button key={index} className="proto-relation-link" type="button"
            onClick={() => onNavigate(kind, name)}>{index + 1}. {name}</button>)}
      </div>
      <p className="proto-relations-caveat">
        Partial-объявлений применено во всей цепочке: {report.total_partials}.
      </p>
      <strong className="proto-source-label">Поля ({report.fields.length})</strong>
      {report.fields.map((field) => <div key={field.key} className="proto-merged-row">
        <strong>{field.key}</strong>
        <span>{field.preview}</span>
        {field.source_file && <button className="proto-relation-source" type="button"
          title={'Открыть ' + field.source_file}
          onClick={() => onOpen(field.source_file, 1)}>
          {field.source_file.split('/').at(-1)}
        </button>}
      </div>)}
      <strong className="proto-source-label">Компоненты ({report.components.length})</strong>
      {report.components.map((component) => <div key={component.type_name} className="proto-merged-row">
        <strong>{component.type_name}</strong>
        <span>{component.keys.length ? component.keys.join(', ') : 'Нет явных полей'}</span>
        {component.source_file && <button className="proto-relation-source" type="button"
          title={'Открыть ' + component.source_file}
          onClick={() => onOpen(component.source_file, 1)}>
          {component.source_file.split('/').at(-1)}
        </button>}
      </div>)}
    </>}
  </div>;
}
