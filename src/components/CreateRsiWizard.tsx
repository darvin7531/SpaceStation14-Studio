import { useEffect, useState, type FormEvent } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { projectFolderDefaultPath, relativeProjectFolder } from '../lib/project-folder-picker';
import { AlertCircle, FolderPlus, X } from 'lucide-react';
import { studio, type CreatedRsi, type ExternalCreatedRsi, type NewRsiDraft, type NewRsiPreview } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  onClose: () => void;
  projectRoot: string;
  onCreated: (result: CreatedRsi) => void;
  onExternalCreated: (result: ExternalCreatedRsi) => void;
  preferredPath?: string;
}

function initialDirectory(path?: string): string {
  const parent = path?.slice(0, path.lastIndexOf('/'));
  return parent?.startsWith('Resources/Textures') ? parent : 'Resources/Textures';
}

export default function CreateRsiWizard({ onClose, onCreated, onExternalCreated, projectRoot, preferredPath }: Props) {
  const [draft, setDraft] = useState<NewRsiDraft>(() => ({
    directory: initialDirectory(preferredPath),
    name: 'new-sprite',
    size_x: 32,
    size_y: 32,
    license: 'CC-BY-SA-3.0',
    copyright: '',
  }));
  const [destination, setDestination] = useState<'project' | 'external'>('project');
  const [preview, setPreview] = useState<NewRsiPreview | null>(null);
  const [validationError, setValidationError] = useState<StudioError | null>(null);
  const [creationError, setCreationError] = useState<StudioError | null>(null);
  const [checking, setChecking] = useState(true);
  const [creating, setCreating] = useState(false);

  function change<K extends keyof NewRsiDraft>(key: K, value: NewRsiDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setChecking(true);
    setPreview(null);
    setValidationError(null);
    setCreationError(null);
  }

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      void studio.previewNewRsi(draft).then((result) => {
        if (!active) return;
        setPreview(result);
        setValidationError(null);
      }).catch((failure: unknown) => {
        if (!active) return;
        setPreview(null);
        setValidationError(normalizeStudioError(failure));
      }).finally(() => {
        if (active) setChecking(false);
      });
    }, 180);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [draft]);

  const [pickingFolder, setPickingFolder] = useState(false);

  async function pickProjectFolder() {
    setPickingFolder(true);
    setCreationError(null);
    try {
      const chosen = await open({
        directory: true, multiple: false,
        defaultPath: projectFolderDefaultPath(projectRoot, 'rsi'),
        title: 'Выберите папку для RSI в игровом проекте',
      });
      if (typeof chosen !== 'string') return;
      const folder = relativeProjectFolder(projectRoot, chosen, 'rsi');
      if (!folder) {
        setCreationError({
          code: 'RSI_FOLDER_NOT_IN_TEXTURES',
          message: 'Выбранная папка находится вне текстур открытого проекта.',
          hint: 'Выберите папку внутри Resources/Textures.',
        });
        return;
      }
      change('directory', folder);
    } catch (failure) {
      setCreationError(normalizeStudioError(failure));
    } finally {
      setPickingFolder(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (checking || creating || pickingFolder || !preview) return;
    setCreating(true);
    setCreationError(null);
    try {
      if (destination === 'external') {
        const result = await studio.createExternalRsi(draft);
        if (result) onExternalCreated(result);
      } else {
        const result = await studio.createNewRsi(draft);
        onCreated(result);
      }
    } catch (failure) {
      setCreationError(normalizeStudioError(failure));
    } finally {
      setCreating(false);
    }
  }

  return <div className="fluent-create-backdrop">
    <section className="fluent-create-modal" role="dialog" aria-modal="true"
      aria-labelledby="rsi-create-heading">
      <form onSubmit={(event) => void submit(event)}>
        <header className="fluent-create-heading">
          <div>
            <small>Rust Rework · RSI</small>
            <h2 id="rsi-create-heading">Новый спрайт RSI</h2>
          </div>
          <button type="button" disabled={creating} onClick={onClose}
            aria-label="Закрыть мастер создания RSI"><X size={18}/></button>
        </header>
        <p className="fluent-create-help">
          Создаётся отдельный каталог .rsi с корректным meta.json. Существующие RSI никогда
          не перезаписываются. Родительская папка внутри Resources/Textures должна существовать.
          Изображения и состояния можно добавить позже.
        </p>
        <div className="create-proto-mode" role="group" aria-label="Размещение RSI">
          <button type="button" className={destination === 'project' ? 'selected' : ''}
            onClick={() => setDestination('project')}>В проекте</button>
          <button type="button" className={destination === 'external' ? 'selected' : ''}
            onClick={() => setDestination('external')}>Вне проекта</button>
        </div>
        {destination === 'external' && <p className="fluent-create-help">
          Родительская папка будет выбрана в системном диалоге. Внешний RSI не входит в открытый проект.
        </p>}
        {destination === 'project' && <label>Папка внутри Resources/Textures
          <input value={draft.directory} required spellCheck={false} maxLength={512}
            onChange={(event) => change('directory', event.target.value)}
            placeholder="Resources/Textures/Objects"/>
        </label>}
        {destination === 'project' && <button type="button" disabled={creating || pickingFolder}
          onClick={() => void pickProjectFolder()}>
          {pickingFolder ? 'Выбираю папку…' : 'Выбрать папку RSI…'}
        </button>}
        <label>Имя спрайта (без .rsi)
          <input value={draft.name} required spellCheck={false} maxLength={80}
            onChange={(event) => change('name', event.target.value)}
            placeholder="my-sprite"/>
        </label>
        <div className="rsi-create-grid">
          <label>Ширина кадра
            <input type="number" min={1} max={2048} value={draft.size_x}
              onChange={(event) => change('size_x', Number(event.target.value))}/>
          </label>
          <label>Высота кадра
            <input type="number" min={1} max={2048} value={draft.size_y}
              onChange={(event) => change('size_y', Number(event.target.value))}/>
          </label>
        </div>
        <label>Лицензия (SPDX)
          <input value={draft.license} required maxLength={128}
            onChange={(event) => change('license', event.target.value)}/>
        </label>
        <label>Авторство и источники
          <textarea className="rsi-create-copyright" value={draft.copyright}
            onChange={(event) => change('copyright', event.target.value)}/>
        </label>
        <div className="fluent-create-preview">
          <strong>Предпросмотр meta.json</strong>
          {checking ? <p>Проверяю…</p> : validationError
            ? <div role="alert"><AlertCircle size={15}/>
              <span>{validationError.message} {validationError.hint}</span>
            </div>
            : <>
              <small>{destination === 'project' ? 'Будет создан: ' + (preview?.path ?? '')
                : 'Будет создан: ' + draft.name + '.rsi в выбранной внешней папке'}</small>
              <pre className="rsi-create-metadata">{preview?.metadata ?? ''}</pre>
              {preview?.warnings.map((warning) => <small key={warning}>{warning}</small>)}
            </>}
        </div>
        {creationError && <div className="fluent-create-error" role="alert">
          <AlertCircle size={16}/>
          <span>{creationError.message} {creationError.hint}
            {creationError.details && <details><summary>Технические сведения</summary>
              <pre>{creationError.details}</pre></details>}
          </span>
        </div>}
        <footer>
          <button type="button" disabled={creating} onClick={onClose}>Отмена</button>
          <button type="submit" className="fluent-create-submit"
            disabled={creating || pickingFolder || checking || !preview}>
            <FolderPlus size={15}/>{creating ? 'Создаю…' : 'Создать RSI'}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}
