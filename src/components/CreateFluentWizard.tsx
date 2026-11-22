import { useEffect, useState, type FormEvent } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { projectFolderDefaultPath, relativeProjectFolder } from '../lib/project-folder-picker';
import { AlertCircle, FilePlus2, X } from 'lucide-react';
import { studio, type CreatedFluent, type ExternalCreatedFluent, type NewFluentDraft, type NewFluentPreview } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { suggestedFluentDraft } from '../lib/fluent-create-defaults';

interface Props {
  onClose: () => void;
  projectRoot: string;
  onCreated: (created: CreatedFluent) => void;
  onExternalCreated: (created: ExternalCreatedFluent) => void;
  preferredFile?: string;
  preferredDraft?: NewFluentDraft;
}

export default function CreateFluentWizard({ onClose, onCreated, onExternalCreated, projectRoot, preferredFile, preferredDraft }: Props) {
  const [draft, setDraft] = useState<NewFluentDraft>(() => suggestedFluentDraft(preferredFile, preferredDraft));
  const [destination, setDestination] = useState<'project' | 'external'>('project');
  const [preview, setPreview] = useState<NewFluentPreview | null>(null);
  const [validationError, setValidationError] = useState<StudioError | null>(null);
  const [creationError, setCreationError] = useState<StudioError | null>(null);
  const [checking, setChecking] = useState(true);
  const [creating, setCreating] = useState(false);

  function change<K extends keyof NewFluentDraft>(field: K, value: NewFluentDraft[K]) {
    setChecking(true);
    setPreview(null);
    setValidationError(null);
    setCreationError(null);
    setDraft((previous) => ({ ...previous, [field]: value }));
  }

  useEffect(() => {
    let live = true;
    const timeout = window.setTimeout(() => {
      void studio.previewNewFluent(draft).then((result) => {
        if (!live) return;
        setPreview(result);
        setValidationError(null);
      }).catch((error: unknown) => {
        if (!live) return;
        setPreview(null);
        setValidationError(normalizeStudioError(error));
      }).finally(() => {
        if (live) setChecking(false);
      });
    }, 180);
    return () => {
      live = false;
      window.clearTimeout(timeout);
    };
  }, [draft]);

  const [pickingFolder, setPickingFolder] = useState(false);

  async function pickProjectFolder() {
    setPickingFolder(true);
    setCreationError(null);
    try {
      const chosen = await open({
        directory: true, multiple: false,
        defaultPath: projectFolderDefaultPath(projectRoot, 'fluent'),
        title: 'Выберите папку игровой локализации',
      });
      if (typeof chosen !== 'string') return;
      const folder = relativeProjectFolder(projectRoot, chosen, 'fluent');
      if (!folder) {
        setCreationError({
          code: 'FTL_FOLDER_NOT_IN_LOCALE',
          message: 'Выбранная папка не принадлежит локализациям открытого проекта.',
          hint: 'Выберите существующую папку внутри Resources/Locale/<локаль>.',
        });
        return;
      }
      const filename = draft.file.split('/').pop() || 'StudioNew.ftl';
      change('file', folder + '/' + filename);
    } catch (failure) {
      setCreationError(normalizeStudioError(failure));
    } finally {
      setPickingFolder(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || pickingFolder || checking || !preview) return;
    setCreating(true);
    setCreationError(null);
    try {
      if (destination === 'external') {
        const created = await studio.createExternalFluent(draft);
        if (created) onExternalCreated(created);
      } else {
        const created = await studio.createNewFluent(draft);
        onCreated(created);
      }
    } catch (error) {
      setCreationError(normalizeStudioError(error));
    } finally {
      setCreating(false);
    }
  }

  return <div className="fluent-create-backdrop">
    <section className="fluent-create-modal" role="dialog" aria-modal="true" aria-labelledby="fluent-create-heading">
      <form onSubmit={(event) => void create(event)}>
        <header className="fluent-create-heading">
          <div>
            <small>Rust Rework · Fluent</small>
            <h2 id="fluent-create-heading">Новая локализация</h2>
          </div>
          <button type="button" onClick={onClose} disabled={creating} aria-label="Закрыть мастер"><X size={18}/></button>
        </header>
        <p className="fluent-create-help">
          Создаётся новый файл, а существующие файлы никогда не перезаписываются.
          Для проекта папка языка должна существовать в Resources/Locale.
          При внешнем создании расположение выбирается через системный диалог.
        </p>
        <div className="create-proto-mode" role="group" aria-label="Размещение FTL">
          <button type="button" className={destination === 'project' ? 'selected' : ''}
            onClick={() => setDestination('project')}>В проекте</button>
          <button type="button" className={destination === 'external' ? 'selected' : ''}
            onClick={() => setDestination('external')}>Вне проекта</button>
        </div>
        <label>{destination === 'external' ? 'Имя FTL для предпросмотра (фактический путь выберете отдельно)' : 'Путь нового .ftl относительно проекта'}
          <input value={draft.file} required spellCheck={false} maxLength={512}
            placeholder="Resources/Locale/en-US/my-messages.ftl"
            onChange={(event) => change('file', event.target.value)}/>
        </label>
        {destination === 'project' && <button type="button" disabled={creating || pickingFolder}
          onClick={() => void pickProjectFolder()}>
          {pickingFolder ? 'Выбираю папку…' : 'Выбрать папку FTL…'}
        </button>}
        <label>Начальный идентификатор
          <input value={draft.starter_key} required spellCheck={false} maxLength={128}
            placeholder="entity-example" onChange={(event) => change('starter_key', event.target.value)}/>
        </label>
        <label>Начальное значение (одна строка)
          <input value={draft.starter_value} spellCheck={false}
            placeholder="Example"
            onChange={(event) => change('starter_value', event.target.value)}/>
        </label>
        {preferredDraft && <div className="fluent-create-entity-fields">
          <label>Описание entity (.desc)
            <input value={draft.starter_description ?? ''} spellCheck={false}
              onChange={(event) => change('starter_description', event.target.value)}/>
          </label>
          <label>Суффикс entity (.suffix)
            <input value={draft.starter_suffix ?? ''} spellCheck={false}
              onChange={(event) => change('starter_suffix', event.target.value)}/>
          </label>
        </div>}
        <div className="fluent-create-preview">
          <strong>Содержимое нового файла</strong>
          {checking ? <p>Проверяю…</p> : validationError
            ? <div role="alert"><AlertCircle size={15}/>
                <span>{validationError.message} {validationError.hint}</span>
              </div>
            : <pre>{preview?.content ?? ''}</pre>}
          {preview?.warnings.map((warning) =>
            <small key={warning}>{warning}</small>)}
        </div>
        {creationError && <div className="fluent-create-error" role="alert">
          <AlertCircle size={16}/>
          <span>{creationError.message} {creationError.hint}
            {creationError.details && <details><summary>Подробности</summary><pre>{creationError.details}</pre></details>}
          </span>
        </div>}
        <footer>
          <button type="button" disabled={creating} onClick={onClose}>Отмена</button>
          <button type="submit" className="fluent-create-submit"
            disabled={creating || pickingFolder || checking || !preview}>
            <FilePlus2 size={15}/>{creating ? 'Создаю…' : 'Создать FTL'}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}
