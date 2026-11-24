import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { open } from '@tauri-apps/plugin-dialog';
import { projectFolderDefaultPath, relativeProjectFolder } from '../lib/project-folder-picker';
import { AlertCircle, AlertTriangle, CheckCircle2, FilePlus2, X } from 'lucide-react';
import {
  studio,
  type CreatedPrototype,
  type ExternalCreatedPrototype,
  type AppendPrototypePreview,
  type NewPrototypeDraft,
  type NewPrototypePreview,
} from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { prototypeWizardShortcut } from '../lib/prototype-wizard-shortcut';

export type PrototypeDestinationMode = 'new' | 'append';

interface Props {
  onClose: () => void;
  projectRoot: string;
  onCreated: (result: CreatedPrototype, mode: PrototypeDestinationMode) => void;
  onExternalCreated: (result: ExternalCreatedPrototype) => void;
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
  suffix: '',
  abstract_prototype: false,
  sprite: '',
  sprite_state: '',
  include_sprite: false,
  include_item: false,
  include_physics: false,
  include_appearance: false,
  file: preferredPath('NewPrototype'),
};

export default function CreatePrototypeWizard({
  onClose, onCreated, onExternalCreated, projectRoot, dirtyPaths, preferredExistingFile,
}: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<PrototypeDestinationMode>('new');
  const [destination, setDestination] = useState<'project' | 'external'>('project');
  const [availableFiles, setAvailableFiles] = useState<string[]>([]);
  const [matchingFileCount, setMatchingFileCount] = useState(0);
  const [availableKinds, setAvailableKinds] = useState<string[]>([]);
  const [draft, setDraft] = useState<NewPrototypeDraft>(INITIAL);
  const [preview, setPreview] = useState<NewPrototypePreview | AppendPrototypePreview | null>(null);
  const targetIsDirty = mode === 'append' && dirtyPaths.includes(draft.file);
  const [validationError, setValidationError] = useState<StudioError | null>(null);
  const [createError, setCreateError] = useState<StudioError | null>(null);
  const [checking, setChecking] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const busyRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const form = formRef.current;
    const focusable = () => Array.from(form?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.getClientRects().length > 0);
    form?.querySelector<HTMLInputElement>('input')?.focus();
    const focusInside = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      // A separately mounted dialog owns its own focus and shortcuts.
      if (!form?.contains(target) && !target?.closest('[role="dialog"], dialog[open]')) focusable()[0]?.focus();
    };
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const otherDialog = target?.closest('[role="dialog"], dialog[open]');
      if (otherDialog && !otherDialog.contains(form)) return;
      if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const items = focusable();
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (items.length && (index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1))) {
          event.preventDefault();
          items[event.shiftKey ? items.length - 1 : 0].focus();
        }
        return;
      }
      const action = prototypeWizardShortcut(event, busyRef.current);
      if (event.key === 'Escape' || action) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (action === 'close') onCloseRef.current();
      if (action === 'submit') form?.requestSubmit();
    };
    document.addEventListener('focusin', focusInside);
    window.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('focusin', focusInside);
      window.removeEventListener('keydown', keydown, true);
      if (previous?.isConnected && (document.activeElement === document.body || form?.contains(document.activeElement))) previous.focus();
    };
  }, []);


  function switchDestination(next: 'project' | 'external') {
    if (next === destination) return;
    setChecking(true);
    setPreview(null);
    setValidationError(null);
    setCreateError(null);
    setDestination(next);
  }

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
    void studio.listPrototypeKinds().then((kinds) => {
      if (active) setAvailableKinds(kinds);
    }).catch(() => {
      if (active) setAvailableKinds([]);
    });
    return () => { active = false; };
  }, []);

  // Electron allowed choosing any indexed YAML, including files past the
  // first search page. Query the native index as the user narrows the path.
  useEffect(() => {
    if (mode !== 'append') return;
    let active = true;
    const timer = window.setTimeout(() => {
      void studio.searchResources(draft.file, 'yaml', 0, 200).then((page) => {
        if (!active) return;
        setAvailableFiles(page.items.map((entry) => entry.path));
        setMatchingFileCount(page.total);
      }).catch(() => {
        if (active) {
          setAvailableFiles([]);
          setMatchingFileCount(0);
        }
      });
    }, 160);
    return () => { active = false; window.clearTimeout(timer); };
  }, [mode, draft.file]);

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
        next.include_sprite = false;
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
          message: t('wizard.proto.dirtyMessage'),
          hint: t('wizard.proto.dirtyHint'),
        });
        setChecking(false);
        return;
      }
      const request = mode === 'new'
        ? studio.previewNewPrototype(draft, destination === 'external')
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
  }, [draft, mode, destination, targetIsDirty]);

  async function pickProjectFolder() {
    if (busyRef.current || mode !== 'new' || destination !== 'project') return;
    busyRef.current = true;
    setPickingFolder(true);
    setCreateError(null);
    try {
      const chosen = await open({
        directory: true, multiple: false,
        defaultPath: projectFolderDefaultPath(projectRoot, 'prototype'),
        title: t('wizard.proto.folderTitle'),
      });
      if (typeof chosen !== 'string') return;
      const folder = relativeProjectFolder(projectRoot, chosen, 'prototype');
      if (!folder) {
        setCreateError({
          code: 'PROTOTYPE_FOLDER_NOT_IN_RESOURCES',
          message: t('wizard.proto.folderError'),
          hint: t('wizard.proto.folderHint'),
        });
        return;
      }
      const filename = draft.file.split('/').pop() || (draft.id || 'NewPrototype') + '.yml';
      update('file', folder + '/' + filename);
    } catch (failure) {
      setCreateError(normalizeStudioError(failure));
    } finally {
      busyRef.current = false;
      setPickingFolder(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || creating || pickingFolder || checking || !preview || targetIsDirty) return;
    busyRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      if (mode === 'new' && destination === 'external') {
        const result = await studio.createExternalPrototype(draft);
        if (result) onExternalCreated(result);
      } else {
        const result = mode === 'append'
          ? await studio.appendPrototype(draft, (preview as AppendPrototypePreview).expected_revision, projectRoot)
          : await studio.createNewPrototype(draft, projectRoot);
        onCreated(result, mode);
      }
    } catch (error) {
      setCreateError(normalizeStudioError(error));
    } finally {
      busyRef.current = false;
      setCreating(false);
    }
  }

  return <div className="create-proto-backdrop" role="presentation">
    <section className="create-proto-modal" role="dialog" aria-modal="true"
      aria-labelledby="create-proto-title">
      <form ref={formRef} className="create-proto-layout" onSubmit={(event) => void create(event)}>
        <div className="create-proto-form">
          <header className="create-proto-head">
            <div><small><FilePlus2 size={14}/> {t('wizard.proto.newContent')}</small>
              <h2 id="create-proto-title">{t('wizard.proto.title')}</h2>
            </div>
            <button type="button" onClick={onClose} disabled={creating || pickingFolder} aria-label={t('wizard.proto.close')}>
              <X size={18}/>
            </button>
          </header>
          <p className="create-proto-intro">
            {t('wizard.proto.intro')}
          </p>
          <div className="create-proto-mode" role="group" aria-label={t('wizard.proto.mode')}>
            <button type="button" className={mode === 'new' ? 'selected' : ''}
              disabled={creating} onClick={() => switchMode('new')}>{t('wizard.proto.newFile')}</button>
            <button type="button" className={mode === 'append' ? 'selected' : ''}
              disabled={creating} onClick={() => switchMode('append')}>{t('wizard.proto.append')}</button>
          </div>

          {mode === 'new' && <div className="create-proto-mode" role="group" aria-label={t('wizard.proto.destination')}>
            <button type="button" className={destination === 'project' ? 'selected' : ''}
              onClick={() => switchDestination('project')}>{t('wizard.proto.project')}</button>
            <button type="button" className={destination === 'external' ? 'selected' : ''}
              onClick={() => switchDestination('external')}>{t('wizard.common.external')}</button>
          </div>}
          <fieldset className="create-proto-group">
            <legend>{t('wizard.proto.identity')}</legend>
            <label>{t('wizard.proto.type')}
              <input required list="new-prototype-kinds" value={draft.kind}
                onChange={(event) => update('kind', event.target.value)}/>
              <datalist id="new-prototype-kinds">
                {[...new Set([...availableKinds, 'entity', 'reagent', 'tile', 'construction', 'recipe'])]
                  .map((kind) => <option key={kind} value={kind}/>)}
              </datalist>
              <small>{t('wizard.proto.typesHint')}</small>
            </label>
            <label>ID
              <input required maxLength={128} value={draft.id}
                placeholder="MyNewItem" spellCheck={false}
                onChange={(event) => update('id', event.target.value)}/>
            </label>
            <label>{t('wizard.proto.parent')}
              <input value={draft.parent} placeholder="BaseItem" spellCheck={false}
                onChange={(event) => update('parent', event.target.value)}/>
            </label>
            <label className="create-proto-check">
              <input type="checkbox" checked={draft.abstract_prototype}
                onChange={(event) => update('abstract_prototype', event.target.checked)}/>
              {t('wizard.proto.abstract')}
            </label>
          </fieldset>

          <fieldset className="create-proto-group">
            <legend>{t('wizard.proto.descriptionSection')}</legend>
            <label>{t('wizard.proto.name')}
              <input value={draft.name} onChange={(event) => update('name', event.target.value)}/>
            </label>
            <label>{t('wizard.proto.description')}
              <textarea rows={3} value={draft.description}
                onChange={(event) => update('description', event.target.value)}/>
            </label>
            <label>{t('wizard.proto.suffix')}
              <input value={draft.suffix}
                onChange={(event) => update('suffix', event.target.value)}/>
            </label>
          </fieldset>

          {draft.kind === 'entity' && <fieldset className="create-proto-group">
            <legend>{t('wizard.proto.components')}</legend>
            <label>{t('wizard.proto.sprite')}
              <input value={draft.sprite} placeholder="Objects/Tools/myitem.rsi"
                onChange={(event) => update('sprite', event.target.value)}/>
            </label>
            <label>{t('wizard.proto.spriteState')}
              <input value={draft.sprite_state} placeholder="icon"
                onChange={(event) => update('sprite_state', event.target.value)}/>
            </label>
            <div className="create-proto-checkboxes">
              {([
                ['include_sprite', 'Sprite'],
                ['include_item', 'Item'],
                ['include_physics', 'Physics'],
                ['include_appearance', 'Appearance'],
              ] as const).map(([key, label]) => <label className="create-proto-check" key={key}>
                <input type="checkbox" checked={draft[key]}
                  onChange={(event) => update(key, event.target.checked)}/>
                {label}
              </label>)}
            </div>
            <small>{t('wizard.proto.componentHint')}</small>
          </fieldset>}

          <fieldset className="create-proto-group">
            <legend>{mode === 'new' ? t('wizard.proto.fileNew') : t('wizard.proto.fileExisting')}</legend>
            <label>{mode === 'new' && destination === 'external'
              ? t('wizard.proto.pathExternal')
              : t('wizard.proto.pathProject')}
              <input required value={draft.file} spellCheck={false}
                list={mode === 'append' ? 'append-prototype-files' : undefined}
                placeholder={mode === 'append' ? 'Resources/Prototypes/Entities/items.yml' : ''}
                onChange={(event) => update('file', event.target.value)}/>
              {mode === 'append' && <>
                <datalist id="append-prototype-files">
                  {availableFiles.map((file) => <option key={file} value={file}/>)}
                </datalist>
                {matchingFileCount > availableFiles.length && <small>
                  {t('wizard.proto.matches', { shown: availableFiles.length, total: matchingFileCount })}
                </small>}
              </>}
            </label>
            {mode === 'new' && destination === 'project' && <button type="button"
              disabled={creating || pickingFolder} onClick={() => void pickProjectFolder()}>
              {pickingFolder ? t('wizard.common.chooseFolder') : t('wizard.proto.pickFolder')}
            </button>}
            <small>{mode === 'new' && destination === 'external'
              ? t('wizard.proto.externalHelp')
              : mode === 'new'
                ? t('wizard.proto.newHelp')
                : t('wizard.proto.appendHelp')}</small>
          </fieldset>
        </div>

        <div className="create-proto-preview">
          <div className="create-proto-status">
            {checking ? <span>{t('wizard.proto.checking')}</span>
              : validationError
                ? <span className="create-proto-invalid"><AlertCircle size={16}/> {validationError.message}</span>
                : <span className="create-proto-valid"><CheckCircle2 size={16}/> {t('wizard.proto.valid')}</span>}
            {validationError && <p>{validationError.hint} <code>{validationError.code}</code></p>}
          </div>
          {preview?.warnings.map((warning, i) => <div className="create-proto-warning" key={i}>
            <AlertTriangle size={14}/>{warning}
          </div>)}
          <label className="create-proto-yaml-label">
            {mode === 'new' ? t('wizard.proto.previewNew') : t('wizard.proto.previewAppend')}
          </label>
          {mode === 'append' && preview && 'expected_revision' in preview && <small className="create-proto-revision">
            {t('wizard.proto.revision', { revision: preview.expected_revision.slice(0, 12) })}
          </small>}
          <pre className="create-proto-yaml">{preview?.yaml ?? t('wizard.proto.previewHint')}</pre>
          {createError && <div className="create-proto-error" role="alert">
            <AlertCircle size={16}/><div>
              <strong>{createError.message}</strong><p>{createError.hint}</p>
              <code>{createError.code}</code>
              {createError.details && <details><summary>{t('wizard.proto.errorDetails')}</summary>
                <pre>{createError.details}</pre></details>}
            </div>
          </div>}
          <footer className="create-proto-actions">
            <button type="button" onClick={onClose} disabled={creating || pickingFolder}>{t('wizard.common.cancel')}</button>
            <button type="submit" disabled={checking || creating || pickingFolder || !preview || targetIsDirty}>
              <FilePlus2 size={14}/>{creating
                ? t('wizard.proto.writing')
                : mode === 'new' && destination === 'external' ? t('wizard.proto.externalCreate')
                : mode === 'new' ? t('wizard.proto.createFile') : t('wizard.proto.add')}
            </button>
          </footer>
        </div>
      </form>
    </section>
  </div>;
}
