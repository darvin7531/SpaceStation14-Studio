import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, ListPlus, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import {
  studio,
  type ComponentOperation,
  type ComponentInspection,
  type PrototypeFieldLocator,
} from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  locator: PrototypeFieldLocator;
  source: string;
  busy: boolean;
  onApply: (locator: PrototypeFieldLocator, original: string, changed: string) => boolean;
  onClose: () => void;
}

export default function PrototypeComponentsPanel({
  locator, source, busy, onApply, onClose,
}: Props) {
  const [inspection, setInspection] = useState<ComponentInspection | null>(null);
  const [componentType, setComponentType] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setInspection(null);
    setPendingRemoval(null);
    setError(null);
    const timer = window.setTimeout(() => {
      void studio.inspectPrototypeComponents(locator, source)
        .then((result) => {
          if (!active) return;
          setInspection(result);
          setNotice(result.notice);
        })
        .catch((failure) => {
          if (active) setError(normalizeStudioError(failure));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [locator, source, refresh]);

  async function apply(operation: ComponentOperation) {
    if (!inspection || busy || loading || applying) return;
    setApplying(true);
    setError(null);
    const snapshot = source;
    try {
      const result = await studio.patchPrototypeComponents(locator, snapshot, operation);
      if (!result.changed) {
        setNotice('Изменений нет.');
        return;
      }
      if (!onApply(locator, snapshot, result.content)) {
        setError({
          code: 'COMPONENT_EDITOR_CHANGED',
          message: 'Черновик изменился во время редактирования компонентов.',
          hint: 'Обновите список и повторите действие. Текущий текст не перезаписан.',
        });
        return;
      }
      setComponentType('');
      setPendingRemoval(null);
      setNotice('Компонент изменён в черновике. Проверьте YAML и сохраните Ctrl+S.');
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setApplying(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void apply({ operation: 'add', type_name: componentType.trim() });
  }

  const disabled = busy || loading || applying || !inspection;

  return <section className="prototype-components-editor"
    aria-label={'Компоненты прототипа ' + locator.kind + ':' + locator.id}>
    <header>
      <div>
        <strong><ListPlus size={16}/>{locator.kind}:{locator.id} · компоненты</strong>
        <small>{locator.file} · документ {locator.document_index} · элемент {locator.item_index}</small>
      </div>
      <button type="button" onClick={onClose} disabled={applying}
        aria-label="Закрыть список компонентов"><X size={16}/></button>
    </header>
    {loading && <p className="prototype-component-notice" role="status">
      <RefreshCw size={14}/> Анализ явно объявленных компонентов…
    </p>}
    {error && <div className="prototype-field-error" role="alert">
      <AlertTriangle size={15}/>
      <span>{error.message} {error.hint} <code>{error.code}</code></span>
    </div>}
    {inspection && <>
      <p className="prototype-component-notice">{notice}</p>
      <div className="prototype-component-rows">
        {inspection.components.length === 0 && <p className="prototype-component-empty">
          В этом объявлении нет собственного списка компонентов. Наследуемые компоненты не показаны.
        </p>}
        {inspection.components.map((entry) => <div className="prototype-component-row"
          key={entry.index + ':' + entry.type_name}>
          <div>
            <strong>{entry.type_name}</strong>
            <small>Позиция {entry.index + 1} · дополнительных полей: {entry.field_count}</small>
          </div>
          {pendingRemoval === entry.index
            ? <div className="prototype-component-confirm" role="group"
                aria-label={'Удаление компонента ' + entry.type_name}>
                <span>Удалить {entry.type_name} из черновика?</span>
                <button type="button" className="prototype-component-danger" disabled={disabled}
                  onClick={() => void apply({
                    operation: 'remove', index: entry.index, expected_type: entry.type_name,
                  })}>Да, удалить</button>
                <button type="button" disabled={disabled} onClick={() => setPendingRemoval(null)}>
                  Отмена
                </button>
              </div>
            : <button type="button" disabled={disabled}
                title="Удалить компонент из черновика (с подтверждением)"
                onClick={() => setPendingRemoval(entry.index)}>
                <Trash2 size={14}/> Удалить
              </button>}
        </div>)}
      </div>
      <form className="prototype-component-add" onSubmit={add}>
        <label>Добавить компонент по типу
          <input spellCheck={false} placeholder="Sprite, Physics, Item…"
            list="prototype-component-name-suggestions"
            value={componentType} disabled={disabled}
            onChange={(event) => setComponentType(event.target.value)}/>
          <datalist id="prototype-component-name-suggestions">
            <option value="Sprite"/><option value="Physics"/><option value="Appearance"/>
            <option value="Item"/><option value="Transform"/><option value="Damageable"/>
          </datalist>
        </label>
        <button type="submit" disabled={disabled || componentType.trim().length === 0}>
          <Plus size={15}/>{applying ? 'Применение…' : 'Добавить в черновик'}
        </button>
      </form>
      <small className="prototype-component-caveat">
        Добавляется минимальный блок <code>- type</code>. Требования и поля компонента
        зависят от форка SS14; C#-валидация ещё не реализована.
        Блоки с комментариями и нестандартной YAML-разметкой автоматически не удаляются.
      </small>
    </>}
  </section>;
}
