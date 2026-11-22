import { useEffect, useState } from 'react';
import { studio, type LinkedPrototypeReport } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  kind: string;
  id: string;
  workspaceKey: string;
  onNavigate: (kind: string, id: string) => void;
}

/** Port of main/src/components/Inspector.tsx "Linked prototypes" section.
 * Keeps the original 24 visible links and path notation, but loads lazily. */
export default function LinkedPrototypePanel({
  kind, id, workspaceKey, onNavigate,
}: Props) {
  const [report, setReport] = useState<LinkedPrototypeReport | null>(null);
  const [error, setError] = useState<StudioError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setReport(null);
    setError(null);
    setLoading(true);
    void studio.prototypeLinkedReferences(kind, id).then((value) => {
      if (live) setReport(value);
    }).catch((reason: unknown) => {
      if (live) setError(normalizeStudioError(reason));
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [kind, id, workspaceKey]);

  return <section className="proto-source-report" aria-label="Связанные прототипы">
    {loading && <p role="status" className="muted">Ищу ссылки в полях и компонентах…</p>}
    {error && <div className="proto-error" role="alert">
      <strong>{error.message}</strong><p>{error.hint}</p><code>{error.code}</code>
    </div>}
    {report && <>
      {!report.items.length && <p className="muted">Нет связанных прототипов.</p>}
      {!report.source_complete && <p className="proto-relations-caveat">
        Не все ссылки могут быть найдены: часть исходников или наследования неоднозначна.
      </p>}
      {report.warnings.map((warning, i) => <p key={i} className="proto-relations-caveat">{warning}</p>)}
      {report.items.map((link) => <button type="button"
        key={link.kind + ':' + link.id} className="proto-linked-reference"
        onClick={() => onNavigate(link.kind, link.id)}
        title={'Перейти к ' + link.kind + ':' + link.id}>
        <span><strong>{link.id}</strong><small>{link.kind} / {link.field}</small></span>
        <span aria-hidden="true">↗</span>
      </button>)}
      {report.limited && <small className="muted">
        Показаны первые {report.items.length} совпадений.
      </small>}
    </>}
  </section>;
}
