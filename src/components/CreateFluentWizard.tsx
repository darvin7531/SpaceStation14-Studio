import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, FilePlus2, X } from 'lucide-react';
import { studio, type CreatedFluent, type NewFluentDraft, type NewFluentPreview } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { suggestedFluentDraft } from '../lib/fluent-create-defaults';

interface Props {
  onClose: () => void;
  onCreated: (created: CreatedFluent) => void;
  preferredFile?: string;
  preferredDraft?: NewFluentDraft;
}

export default function CreateFluentWizard({ onClose, onCreated, preferredFile, preferredDraft }: Props) {
  const [draft, setDraft] = useState<NewFluentDraft>(() => suggestedFluentDraft(preferredFile, preferredDraft));
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

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || checking || !preview) return;
    setCreating(true);
    setCreationError(null);
    try {
      const created = await studio.createNewFluent(draft);
      onCreated(created);
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
          Папка языка должна уже существовать в Resources/Locale.
        </p>
        <label>Путь нового .ftl относительно проекта
          <input value={draft.file} required spellCheck={false} maxLength={512}
            placeholder="Resources/Locale/en-US/my-messages.ftl"
            onChange={(event) => change('file', event.target.value)}/>
        </label>
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
            disabled={creating || checking || !preview}>
            <FilePlus2 size={15}/>{creating ? 'Создаю…' : 'Создать FTL'}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}
