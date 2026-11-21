import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, ListPlus, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import {
  studio,
  type ComponentOperation,
  type ComponentInspection,
  type ComponentScalarField,
  type ComponentScalarKind,
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
  const [pendingFieldRemoval, setPendingFieldRemoval] = useState<{ index: number; key: string } | null>(null);
  const [addingField, setAddingField] = useState<{
    index: number; key: string;
    kind: Exclude<ComponentScalarKind, 'complex'>; value: string;
  } | null>(null);
  const [editingField, setEditingField] = useState<{
    index: number;
    key: string;
    kind: 'string' | 'bool' | 'int' | 'float';
    value: string;
  } | null>(null);
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
    setPendingFieldRemoval(null);
    setAddingField(null);
    setEditingField(null);
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
      setPendingFieldRemoval(null);
      setAddingField(null);
      setEditingField(null);
      setNotice('Компонент или его поле изменены в черновике. Проверьте YAML и сохраните Ctrl+S.');
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

  function edit(index: number, field: ComponentScalarField) {
    if (!field.editable || field.kind === 'complex') return;
    setEditingField({
      index, key: field.key, kind: field.kind, value: field.value,
    });
  }

  function submitField(event: FormEvent<HTMLFormElement>, expectedType: string) {
    event.preventDefault();
    if (!editingField) return;
    void apply({
      operation: 'update_field',
      index: editingField.index,
      expected_type: expectedType,
      key: editingField.key,
      kind: editingField.kind,
      value: editingField.value,
    });
  }

  function newField(index: number) {
    setPendingRemoval(null);
    setPendingFieldRemoval(null);
    setEditingField(null);
    setAddingField({ index, key: '', kind: 'string', value: '' });
  }

  function submitNewField(event: FormEvent<HTMLFormElement>, expectedType: string) {
    event.preventDefault();
    if (!addingField) return;
    void apply({
      operation: 'add_field', index: addingField.index, expected_type: expectedType,
      key: addingField.key.trim(), kind: addingField.kind, value: addingField.value,
    });
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
          <div className="prototype-component-properties" aria-label={'Поля компонента ' + entry.type_name}>
            {entry.fields.length === 0 && <span className="prototype-component-no-fields">
              Дополнительных полей нет
            </span>}
            {entry.fields.map((field) => <div className="prototype-component-property"
              key={field.key}>
              <code title={field.key}>{field.key}</code>
              <span className="prototype-component-scalar-kind">{field.kind}</span>
              <span className="prototype-component-scalar-value" title={field.value}>
                {field.value}
              </span>
              {field.editable && field.kind !== 'complex'
                ? <div className="prototype-component-property-actions">
                    <button type="button" disabled={disabled}
                      onClick={() => edit(entry.index, field)}>Изменить</button>
                    {pendingFieldRemoval?.index === entry.index && pendingFieldRemoval.key === field.key
                      ? <>
                          <button type="button" className="prototype-component-danger" disabled={disabled}
                            onClick={() => void apply({
                              operation: 'remove_field',
                              index: entry.index, expected_type: entry.type_name, key: field.key,
                              expected_kind: field.kind as Exclude<ComponentScalarKind, 'complex'>,
                              expected_value: field.value,
                            })}>Удалить?</button>
                          <button type="button" disabled={disabled}
                            onClick={() => setPendingFieldRemoval(null)}>Отмена</button>
                        </>
                      : <button type="button" disabled={disabled} title={'Удалить поле ' + field.key}
                          onClick={() => setPendingFieldRemoval({ index: entry.index, key: field.key })}>
                          <Trash2 size={12}/>
                        </button>}
                  </div>
                : <span className="prototype-component-readonly" title="Сложное значение редактируется в Monaco">
                    Только YAML
                  </span>}
            </div>)}
          </div>
          {addingField?.index !== entry.index && <button type="button" disabled={disabled}
            className="prototype-component-add-property-trigger"
            onClick={() => newField(entry.index)}>
            <Plus size={13}/> Добавить поле
          </button>}
          {addingField?.index === entry.index && <form className="prototype-component-field-form"
            onSubmit={(event) => submitNewField(event, entry.type_name)}>
            <label>Имя поля
              <input spellCheck={false} disabled={disabled} placeholder="sprite, count, visible…"
                value={addingField.key}
                onChange={(event) => setAddingField({ ...addingField, key: event.target.value })}/>
            </label>
            <label>Тип
              <select disabled={disabled} value={addingField.kind}
                onChange={(event) => {
                  const next = event.target.value as Exclude<ComponentScalarKind, 'complex'>;
                  setAddingField({ ...addingField, kind: next,
                    value: next === 'bool' ? 'false' : '' });
                }}>
                <option value="string">string</option><option value="bool">bool</option>
                <option value="int">int</option><option value="float">float</option>
              </select>
            </label>
            <label>Значение
              {addingField.kind === 'bool'
                ? <select disabled={disabled} value={addingField.value}
                    onChange={(event) => setAddingField({ ...addingField, value: event.target.value })}>
                    <option value="false">false</option><option value="true">true</option>
                  </select>
                : <input spellCheck={false} disabled={disabled} value={addingField.value}
                    placeholder={addingField.kind === 'int' ? '0' : addingField.kind === 'float' ? '1.0' : ''}
                    onChange={(event) => setAddingField({ ...addingField, value: event.target.value })}/>}
            </label>
            <button type="submit" disabled={disabled || !addingField.key.trim()}>
              Добавить поле
            </button>
            <button type="button" disabled={disabled}
              onClick={() => setAddingField(null)}>Отмена</button>
          </form>}
          {editingField?.index === entry.index && <form className="prototype-component-field-form"
            onSubmit={(event) => submitField(event, entry.type_name)}>
            <label>Поле <code>{editingField.key}</code> · {editingField.kind}
              {editingField.kind === 'bool'
                ? <select disabled={disabled} value={editingField.value}
                    onChange={(event) => setEditingField({ ...editingField, value: event.target.value })}>
                    <option value="true">true</option><option value="false">false</option>
                  </select>
                : <input disabled={disabled} value={editingField.value} spellCheck={false}
                    onChange={(event) => setEditingField({ ...editingField, value: event.target.value })}/>}
            </label>
            <button type="submit" disabled={disabled}>Применить поле</button>
            <button type="button" disabled={disabled}
              onClick={() => setEditingField(null)}>Отмена</button>
          </form>}
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
        Поля string/bool/int/float можно добавлять, менять и удалять.
        Вложенные структуры и теги остаются в Monaco. Поля с комментариями не удаляются автоматически.
      </small>
    </>}
  </section>;
}
