import { AlertTriangle, GitCompareArrows, RefreshCw, X } from 'lucide-react';
import type { ResourceDocument } from '../lib/api';
import YamlDiffView from '../editor/YamlDiffView';

interface Props {
  file: string;
  disk: ResourceDocument;
  draft: string;
  draftChanged: boolean;
  busy: boolean;
  onAccept: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

/** This component is read-only; "accept" only updates an optimistic revision. */
export default function ConflictReviewPanel({
  file, disk, draft, draftChanged, busy, onAccept, onRefresh, onClose,
}: Props) {
  return <section className="conflict-review" aria-label={'Проверка изменений YAML: ' + file}>
    <div className="conflict-review-heading">
      <GitCompareArrows size={16}/>
      <strong>Сравнение перед сохранением: {file.split('/').at(-1)}</strong>
      <button type="button" onClick={onClose} title="Закрыть сравнение" aria-label="Закрыть сравнение">
        <X size={16}/>
      </button>
    </div>
    <p><AlertTriangle size={15}/>
      Слева — последняя прочитанная версия файла на диске, справа — черновик.
      Принятие версии не сохраняет файл: после проверки потребуется нажать «Сохранить».
    </p>
    {draftChanged && <p role="alert" className="conflict-review-stale">
      Черновик изменён после открытия сравнения. Обновите сравнение, прежде чем принимать ревизию.
    </p>}
    <YamlDiffView original={disk.content} modified={draft}
      fileLabel={file} originalLabel="Файл на диске" modifiedLabel="Черновик Studio"/>
    <div className="conflict-review-actions">
      <button type="button" disabled={busy} onClick={onRefresh}>
        <RefreshCw size={14}/>{busy ? 'Читаю…' : 'Обновить сравнение'}
      </button>
      <button type="button" className="conflict-review-accept"
        disabled={busy || draftChanged} onClick={onAccept}>
        Принять версию файла как основу
      </button>
      <button type="button" disabled={busy} onClick={onClose}>Закрыть без изменений</button>
    </div>
    <small>Принятие новой ревизии — осознанный выбор. Если файл изменится ещё раз,
      проверка будет повторена и сохранение останется заблокированным.</small>
  </section>;
}
