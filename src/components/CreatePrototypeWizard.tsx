import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, FilePlus2, X } from 'lucide-react';
import {
  studio,
  type CreatedPrototype,
  type AppendPrototypePreview,
  type NewPrototypeDraft,
  type NewPrototypePreview,
} from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

export type PrototypeDestinationMode = 'new' | 'append';

interface Props {
  onClose: () => void;
  onCreated: (result: CreatedPrototype, mode: PrototypeDestinationMode) => void;
  dirtyPaths: readonly string[];
  preferredExistingFile?: string;
}

function preferredPath(id: string): string {
  return 'Resources/Prototypes/_PrototypeStudio/' + (id || 'NewPrototype') + '.yml';
}

const INITIAL: NewPrototypeDraft = {
  kind: 'entity',
  id: '',
  parent: '',
  name: '',
  description: '',
  abstract_prototype: false,
  sprite: '',
  sprite_state: '',
  include_item: false,
  include_physics: false,
  include_appearance: false,
  file: preferredPath('NewPrototype'),
};

export default function CreatePrototypeWizard({
  onClose, onCreated, dirtyPaths, preferredExistingFile,
}: Props) {
  const [mode, setMode] = useState<PrototypeDestinationMode>('new');
  const [availableFiles, setAvailableFiles] = useState<string[]>([]);
  const [draft, setDraft] = useState<NewPrototypeDraft>(INITIAL);
  const [preview, setPreview] = useState<NewPrototypePreview | AppendPrototypePreview | null>(null);
  const targetIsDirty = mode === 'append' && dirtyPaths.includes(draft.file);
  const [validationError, setValidationError] = useState<StudioError | null>(null);
  const [createError, setCreateError] = useState<StudioError | null>(null);
  const [checking, setChecking] = useState(true);
  const [creating, setCreating] = useState(false);

  function switchMode(next: PrototypeDestinationMode) {
    if (next === mode) return;
    setChecking(true);
    setPreview(null);
    setValidationError(null);
    setCreateError(null);
    setMode(next);
    setDraft((current) => ({
      ...current,
      file: next === 'append' ? (preferredExistingFile ?? '') : preferredPath(current.id || 'NewPrototype'),
    }));
  }

  useEffect(() => {
    let active = true;
    void studio.searchResources('', 'yaml', 0, 250).then((page) => {
      if (active) setAvailableFiles(page.items.map((entry) => entry.path));
    }).catch(() => {
      if (active) setAvailableFiles([]);
    });
    return () => { active = false; };
  }, []);

  function update<K extends keyof NewPrototypeDraft>(field: K, value: NewPrototypeDraft[K]) {
    // Do not leave an old valid preview enabled during the debounce window.
    setChecking(true);
    setPreview(null);
    setValidationError(null);
    setCreateError(null);
    setDraft((current) => {
      const next = { ...current, [field]: value };
      if (mode === 'new' && field === 'id'
          && current.file === preferredPath(current.id || 'NewPrototype')) {
        next.file = preferredPath(String(value));
      }
      if (field === 'kind' && value !== 'entity') {
        next.sprite = '';
        next.sprite_state = '';
        next.include_item = false;
        next.include_physics = false;
        next.include_appearance = false;
      }
      return next;
    });
  }

  useEffect(() => {
    let active = true;
    const handle = window.setTimeout(() => {
      setChecking(true);
      if (targetIsDirty) {
        setPreview(null);
        setValidationError({
          code: 'APPEND_DIRTY_TARGET',
          message: 'Целевой YAML содержит несохранённые изменения в открытой вкладке.',
          hint: 'Сначала сохраните файл либо выберите другой YAML, иначе изменения вкладки могут устареть.',
        });
        setChecking(false);
        return;
      }
      const request = mode === 'new'
        ? studio.previewNewPrototype(draft)
        : studio.previewAppendPrototype(draft);
      void request.then((value) => {
        if (!active) return;
        setPreview(value);
        setValidationError(null);
      }).catch((error: unknown) => {
        if (!active) return;
        setPreview(null);
        setValidationError(normalizeStudioError(error));
      }).finally(() => {
        if (active) setChecking(false);
      });
    }, 160);
    return () => {
      active = false;
      window.clearTimeout(handle);
    };
  }, [draft, mode, targetIsDirty]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || checking || !preview || targetIsDirty) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = mode === 'append'
        ? await studio.appendPrototype(draft, (preview as AppendPrototypePreview).expected_revision)
        : await studio.createNewPrototype(draft);
      onCreated(result, mode);
    } catch (error) {
      setCreateError(normalizeStudioError(error));
    } finally {
      setCreating(false);
    }
  }

  return <div className="create-proto-backdrop" role="presentation">
    <section className="create-proto-modal" role="dialog" aria-modal="true"
      aria-labelledby="create-proto-title">
      <form className="create-proto-layout" onSubmit={(event) => void create(event)}>
        <div className="create-proto-form">
          <header className="create-proto-head">
            <div><small><FilePlus2 size={14}/> Новое содержимое</small>
              <h2 id="create-proto-title">Создать прототип</h2>
            </div>
            <button type="button" onClick={onClose} disabled={creating} aria-label="Закрыть мастер">
              <X size={18}/>
            </button>
          </header>
          <p className="create-proto-intro">
            Выберите создание нового YAML либо безопасное добавление прототипа в существующий список.
            В обоих режимах все проверки и запись выполняются на стороне Rust.
          </p>
          <div className="create-proto-mode" role="group" aria-label="Способ размещения прототипа">
            <button type="button" className={mode === 'new' ? 'selected' : ''}
              disabled={creating} onClick={() => switchMode('new')}>Новый файл</button>
            <button type="button" className={mode === 'append' ? 'selected' : ''}
              disabled={creating} onClick={() => switchMode('append')}>В существующий YAML</button>
          </div>

          <fieldset className="create-proto-group">
            <legend>Идентификатор и наследование</legend>
            <label>Тип прототипа
              <input required list="new-prototype-kinds" value={draft.kind}
                onChange={(event) => update('kind', event.target.value)}/>
              <datalist id="new-prototype-kinds">
                <option value="entity"/><option value="reagent"/><option value="tile"/>
                <option value="construction"/><option value="recipe"/>
              </datalist>
            </label>
            <label>ID
              <input required maxLength={128} value={draft.id}
                placeholder="MyNewItem" spellCheck={false}
                onChange={(event) => update('id', event.target.value)}/>
            </label>
            <label>Родитель (необязательно)
              <input value={draft.parent} placeholder="BaseItem" spellCheck={false}
                onChange={(event) => update('parent', event.target.value)}/>
            </label>
            <label className="create-proto-check">
              <input type="checkbox" checked={draft.abstract_prototype}
                onChange={(event) => update('abstract_prototype', event.target.checked)}/>
              Абстрактный прототип
            </label>
          </fieldset>

          <fieldset className="create-proto-group">
            <legend>Описание</legend>
            <label>Имя
              <input value={draft.name} onChange={(event) => update('name', event.target.value)}/>
            </label>
            <label>Описание
              <textarea rows={3} value={draft.description}
                onChange={(event) => update('description', event.target.value)}/>
            </label>
          </fieldset>

          {draft.kind === 'entity' && <fieldset className="create-proto-group">
            <legend>Компоненты entity (необязательно)</legend>
            <label>RSI спрайт
              <input value={draft.sprite} placeholder="Objects/Tools/myitem.rsi"
                onChange={(event) => update('sprite', event.target.value)}/>
            </label>
            <label>Состояние спрайта
              <input value={draft.sprite_state} placeholder="icon"
                onChange={(event) => update('sprite_state', event.target.value)}/>
            </label>
            <div className="create-proto-checkboxes">
              {([
                ['include_item', 'Item'],
                ['include_physics', 'Physics'],
                ['include_appearance', 'Appearance'],
              ] as const).map(([key, label]) => <label className="create-proto-check" key={key}>
                <input type="checkbox" checked={draft[key]}
                  onChange={(event) => update(key, event.target.checked)}/>
                {label}
              </label>)}
            </div>
            <small>Это шаблоны компонентов: совместимость с конкретным форком проверяется отдельно.</small>
          </fieldset>}

          <fieldset className="create-proto-group">
            <legend>{mode === 'new' ? 'Расположение нового файла' : 'Выберите существующий YAML'}</legend>
            <label>Путь относительно корня проекта
              <input required value={draft.file} spellCheck={false}
                list={mode === 'append' ? 'append-prototype-files' : undefined}
                placeholder={mode === 'append' ? 'Resources/Prototypes/Entities/items.yml' : ''}
                onChange={(event) => update('file', event.target.value)}/>
              {mode === 'append' && <datalist id="append-prototype-files">
                {availableFiles.map((file) => <option key={file} value={file}/>)}
              </datalist>}
            </label>
            <small>{mode === 'new'
              ? 'Разрешены существующие каталоги внутри Resources/Prototypes. Папка _PrototypeStudio создаётся автоматически при необходимости.'
              : 'Файл должен быть проиндексирован. Пока поддерживаются только обычные однодокументные YAML-списки, без Partial-тегов.'}</small>
          </fieldset>
        </div>

        <div className="create-proto-preview">
          <div className="create-proto-status">
            {checking ? <span>Проверяю YAML…</span>
              : validationError
                ? <span className="create-proto-invalid"><AlertCircle size={16}/> {validationError.message}</span>
                : <span className="create-proto-valid"><CheckCircle2 size={16}/> Синтаксис проверен</span>}
            {validationError && <p>{validationError.hint} <code>{validationError.code}</code></p>}
          </div>
          {preview?.warnings.map((warning, i) => <div className="create-proto-warning" key={i}>
            <AlertTriangle size={14}/>{warning}
          </div>)}
          <label className="create-proto-yaml-label">
            {mode === 'new' ? 'Предпросмотр нового YAML (Rust)' : 'Добавляемый блок (Rust)'}
          </label>
          {mode === 'append' && preview && 'expected_revision' in preview && <small className="create-proto-revision">
            Ожидаемая версия файла: {preview.expected_revision.slice(0, 12)}… Файл ещё не изменён.
          </small>}
          <pre className="create-proto-yaml">{preview?.yaml ?? 'Укажите корректные поля прототипа для предпросмотра.'}</pre>
          {createError && <div className="create-proto-error" role="alert">
            <AlertCircle size={16}/><div>
              <strong>{createError.message}</strong><p>{createError.hint}</p>
              <code>{createError.code}</code>
              {createError.details && <details><summary>Технические подробности</summary>
                <pre>{createError.details}</pre></details>}
            </div>
          </div>}
          <footer className="create-proto-actions">
            <button type="button" onClick={onClose} disabled={creating}>Отмена</button>
            <button type="submit" disabled={checking || creating || !preview || targetIsDirty}>
              <FilePlus2 size={14}/>{creating
                ? 'Записываю…'
                : mode === 'new' ? 'Создать файл' : 'Добавить прототип'}
            </button>
          </footer>
        </div>
      </form>
    </section>
  </div>;
}
