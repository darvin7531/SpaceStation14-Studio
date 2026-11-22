import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { open } from '@tauri-apps/plugin-dialog';
import { projectFolderDefaultPath, relativeProjectFolder } from '../lib/project-folder-picker';
import { AlertCircle, FilePlus2, X } from 'lucide-react';
import { studio, type CreatedFluent, type ExternalCreatedFluent, type NewFluentDraft, type NewFluentPreview } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { moveFluentDraftToLocale, suggestedFluentDraft } from '../lib/fluent-create-defaults';
import { localeFromFtlPath } from '../lib/localization-settings';

interface Props {
  onClose: () => void;
  projectRoot: string;
  requiredLocales: readonly string[];
  onCreated: (created: CreatedFluent) => void;
  onExternalCreated: (created: ExternalCreatedFluent) => void;
  preferredFile?: string;
  preferredDraft?: NewFluentDraft;
}

export default function CreateFluentWizard({ onClose, onCreated, onExternalCreated, projectRoot, requiredLocales, preferredFile, preferredDraft }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<NewFluentDraft>(() => suggestedFluentDraft(preferredFile, preferredDraft));
  const [destination, setDestination] = useState<'project' | 'external'>('project');
  const [gameLocaleInput, setGameLocaleInput] = useState(() =>
    localeFromFtlPath(preferredDraft?.file ?? preferredFile ?? '') ?? 'en-US');
  const [preview, setPreview] = useState<NewFluentPreview | null>(null);
  const [validationError, setValidationError] = useState<StudioError | null>(null);
  const [creationError, setCreationError] = useState<StudioError | null>(null);
  const [checking, setChecking] = useState(true);
  const [creating, setCreating] = useState(false);

  function changeGameLocale(next: string) {
    setGameLocaleInput(next);
    const path = moveFluentDraftToLocale(draft.file, next);
    if (path && path !== draft.file) change('file', path);
  }

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
        title: t('wizard.fluent.dialogFolder'),
      });
      if (typeof chosen !== 'string') return;
      const folder = relativeProjectFolder(projectRoot, chosen, 'fluent');
      if (!folder) {
        setCreationError({
          code: 'FTL_FOLDER_NOT_IN_LOCALE',
          message: t('wizard.fluent.folderError'),
          hint: t('wizard.fluent.folderHint'),
        });
        return;
      }
      const filename = draft.file.split('/').pop() || 'StudioNew.ftl';
      change('file', folder + '/' + filename);
      const nextLocale = localeFromFtlPath(folder + '/' + filename);
      if (nextLocale) setGameLocaleInput(nextLocale);
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
            <h2 id="fluent-create-heading">{t('wizard.fluent.title')}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={creating} aria-label={t('wizard.common.close')}><X size={18}/></button>
        </header>
        <p className="fluent-create-help">
          {t('wizard.fluent.intro')}
        </p>
        <div className="create-proto-mode" role="group" aria-label={t('wizard.fluent.location')}>
          <button type="button" className={destination === 'project' ? 'selected' : ''}
            onClick={() => setDestination('project')}>{t('wizard.common.project')}</button>
          <button type="button" className={destination === 'external' ? 'selected' : ''}
            onClick={() => setDestination('external')}>{t('wizard.common.external')}</button>
        </div>
        {destination === 'project' && <label>{t('wizard.fluent.gameLocale')}
          <input list="fluent-game-locales" value={gameLocaleInput}
            onChange={(event) => changeGameLocale(event.target.value)}
            spellCheck={false} placeholder="ru-RU"/>
          <datalist id="fluent-game-locales">
            {[...new Set(['ru-RU', 'en-US', ...requiredLocales])].map((locale) =>
              <option key={locale} value={locale}/>)}
          </datalist>
          <small>{t('wizard.fluent.gameLocaleHint')}</small>
        </label>}
        <label>{destination === 'external' ? t('wizard.fluent.externalFilename') : t('wizard.fluent.projectPath')}
          <input value={draft.file} required spellCheck={false} maxLength={512}
            placeholder="Resources/Locale/en-US/my-messages.ftl"
            onChange={(event) => {
              change('file', event.target.value);
              const locale = localeFromFtlPath(event.target.value);
              if (locale) setGameLocaleInput(locale);
            }}/>
        </label>
        {destination === 'project' && <button type="button" disabled={creating || pickingFolder}
          onClick={() => void pickProjectFolder()}>
          {pickingFolder ? t('wizard.common.chooseFolder') : t('wizard.fluent.pickFolder')}
        </button>}
        <label>{t('wizard.fluent.starterKey')}
          <input value={draft.starter_key} required spellCheck={false} maxLength={128}
            placeholder="entity-example" onChange={(event) => change('starter_key', event.target.value)}/>
        </label>
        <label>{t('wizard.fluent.starterValue')}
          <input value={draft.starter_value} spellCheck={false}
            placeholder="Example"
            onChange={(event) => change('starter_value', event.target.value)}/>
        </label>
        {preferredDraft && <div className="fluent-create-entity-fields">
          <label>{t('wizard.fluent.description')}
            <input value={draft.starter_description ?? ''} spellCheck={false}
              onChange={(event) => change('starter_description', event.target.value)}/>
          </label>
          <label>{t('wizard.fluent.suffix')}
            <input value={draft.starter_suffix ?? ''} spellCheck={false}
              onChange={(event) => change('starter_suffix', event.target.value)}/>
          </label>
        </div>}
        <div className="fluent-create-preview">
          <strong>{t('wizard.fluent.preview')}</strong>
          {checking ? <p>{t('wizard.common.checking')}</p> : validationError
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
            {creationError.details && <details><summary>{t('wizard.common.details')}</summary><pre>{creationError.details}</pre></details>}
          </span>
        </div>}
        <footer>
          <button type="button" disabled={creating} onClick={onClose}>{t('wizard.common.cancel')}</button>
          <button type="submit" className="fluent-create-submit"
            disabled={creating || pickingFolder || checking || !preview}>
            <FilePlus2 size={15}/>{creating ? t('wizard.common.creating') : t('wizard.fluent.create')}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}
