import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FilePlus2, FolderInput, Layers, X } from 'lucide-react';
import { CreatePrototypeOptions, DraftValidation, PrototypeDraft } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (key: string) => Promise<void> | void;
}

const defaultDraft: PrototypeDraft = {
  mode: 'append',
  type: 'entity',
  id: '',
  name: '',
  description: '',
  suffix: '',
  parent: '',
  abstract: false,
  filePath: 'Resources/Prototypes/_PrototypeStudio/entity.yml',
  includeSprite: true,
  sprite: '',
  spriteState: '',
  includeItem: false,
  includePhysics: false,
  includeAppearance: false,
};

export default function CreatePrototypeModal({ open, onClose, onCreated }: Props) {
  const [options, setOptions] = useState<CreatePrototypeOptions | null>(null);
  const [draft, setDraft] = useState<PrototypeDraft>(defaultDraft);
  const [validation, setValidation] = useState<DraftValidation | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const next = await window.prototypeStudio.createOptions();
      if (cancelled) return;
      setOptions(next);
      setDraft((current) => ({ ...current, filePath: current.filePath || next.defaultFile }));
    })();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      const next = await window.prototypeStudio.validateDraft(draft);
      if (!cancelled) setValidation(next);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [draft, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.ctrlKey && event.key === 'Enter') void handleCreate();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const typeHint = useMemo(() => {
    if (!options) return '';
    return options.types.includes(draft.type) ? 'Known prototype type from project index.' : 'New or unknown type; only generic fields will be generated.';
  }, [draft.type, options]);

  if (!open) return null;

  const update = (patch: Partial<PrototypeDraft>) => setDraft((current) => ({ ...current, ...patch }));

  async function handleCreate() {
    const checked = await window.prototypeStudio.validateDraft(draft);
    setValidation(checked);
    if (!checked.ok) return;

    setIsCreating(true);
    try {
      const created = await window.prototypeStudio.createFromDraft(draft);
      await onCreated(created.key);
      onClose();
      setDraft(defaultDraft);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/65 p-4 md:p-6">
      <div className="mx-auto flex h-full items-center justify-center">
        <div className="grid max-h-[min(920px,calc(100vh-2rem))] min-h-0 w-[min(1180px,96vw)] grid-cols-1 overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-950 shadow-2xl lg:grid-cols-[minmax(420px,520px)_1fr]">
        <section className="min-h-0 overflow-y-auto border-b border-neutral-800 p-5 custom-scrollbar lg:border-b-0 lg:border-r">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-blue-400">Prototype Wizard</div>
              <h2 className="text-xl font-semibold text-neutral-100">Create Prototype</h2>
            </div>
            <button onClick={onClose} className="rounded-md p-2 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100">
              <X size={18} />
            </button>
          </div>

          <details open className="wizard-section">
            <summary><FilePlus2 size={15} /> Identity</summary>
            <div className="grid gap-3 pt-3">
              <label className="wizard-label">type
                <input list="prototype-types" value={draft.type} onChange={(event) => update({ type: event.target.value })} className="wizard-input" />
                <datalist id="prototype-types">{options?.types.map((type) => <option key={type} value={type} />)}</datalist>
                <span className="wizard-help">{typeHint}</span>
              </label>
              <label className="wizard-label">id
                <input value={draft.id} onChange={(event) => update({ id: event.target.value })} placeholder="MyNewPrototype" className="wizard-input" />
              </label>
              <label className="wizard-label">parent
                <input value={draft.parent ?? ''} onChange={(event) => update({ parent: event.target.value })} placeholder="BaseItem" className="wizard-input" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="wizard-label">name
                  <input value={draft.name ?? ''} onChange={(event) => update({ name: event.target.value })} className="wizard-input" />
                </label>
                <label className="wizard-label">suffix
                  <input value={draft.suffix ?? ''} onChange={(event) => update({ suffix: event.target.value })} className="wizard-input" />
                </label>
              </div>
              <label className="wizard-label">description
                <textarea value={draft.description ?? ''} onChange={(event) => update({ description: event.target.value })} className="wizard-input min-h-20 resize-y" />
              </label>
              <label className="flex items-center gap-2 text-sm text-neutral-300">
                <input type="checkbox" checked={draft.abstract ?? false} onChange={(event) => update({ abstract: event.target.checked })} />
                abstract prototype
              </label>
            </div>
          </details>

          <details open className="wizard-section">
            <summary><FolderInput size={15} /> File Target</summary>
            <div className="grid gap-3 pt-3">
              <div className="grid grid-cols-2 gap-2">
                <button className={draft.mode === 'append' ? 'wizard-toggle active' : 'wizard-toggle'} onClick={() => update({ mode: 'append' })}>Append existing</button>
                <button className={draft.mode === 'new' ? 'wizard-toggle active' : 'wizard-toggle'} onClick={() => update({ mode: 'new' })}>Create new file</button>
              </div>
              <label className="wizard-label">file path
                <input list="prototype-files" value={draft.filePath} onChange={(event) => update({ filePath: event.target.value })} className="wizard-input" />
                <datalist id="prototype-files">{options?.files.slice(0, 2000).map((file) => <option key={file} value={file} />)}</datalist>
                <span className="wizard-help">Must stay inside Resources/Prototypes and end with .yml/.yaml.</span>
              </label>
            </div>
          </details>

          {draft.type === 'entity' && (
            <details open className="wizard-section">
              <summary><Layers size={15} /> Entity Components</summary>
              <div className="grid gap-3 pt-3">
                <label className="flex items-center gap-2 text-sm text-neutral-300">
                  <input type="checkbox" checked={draft.includeSprite ?? false} onChange={(event) => update({ includeSprite: event.target.checked })} /> Sprite
                </label>
                {(draft.includeSprite || draft.sprite) && (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="wizard-label">sprite
                      <input value={draft.sprite ?? ''} onChange={(event) => update({ sprite: event.target.value })} placeholder="Objects/Tools/foo.rsi" className="wizard-input" />
                    </label>
                    <label className="wizard-label">state
                      <input value={draft.spriteState ?? ''} onChange={(event) => update({ spriteState: event.target.value })} placeholder="icon" className="wizard-input" />
                    </label>
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm text-neutral-300"><input type="checkbox" checked={draft.includeItem ?? false} onChange={(event) => update({ includeItem: event.target.checked })} /> Item</label>
                <label className="flex items-center gap-2 text-sm text-neutral-300"><input type="checkbox" checked={draft.includePhysics ?? false} onChange={(event) => update({ includePhysics: event.target.checked })} /> Physics</label>
                <label className="flex items-center gap-2 text-sm text-neutral-300"><input type="checkbox" checked={draft.includeAppearance ?? false} onChange={(event) => update({ includeAppearance: event.target.checked })} /> Appearance</label>
              </div>
            </details>
          )}
        </section>

        <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          <div className="border-b border-neutral-800 p-4">
            <div className="flex items-center gap-2 text-sm">
              {validation?.ok ? <CheckCircle2 size={16} className="text-green-500" /> : <AlertTriangle size={16} className="text-yellow-500" />}
              <span className="text-neutral-300">{validation?.ok ? 'Draft is ready to create.' : 'Check required fields and warnings.'}</span>
            </div>
            {validation?.issues.length ? (
              <div className="mt-3 grid gap-2">
                {validation.issues.map((issue, index) => (
                  <div key={index} className={issue.level === 'error' ? 'text-sm text-red-400' : 'text-sm text-yellow-400'}>
                    {issue.field}: {issue.message}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="min-h-0 overflow-auto p-4 custom-scrollbar">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">YAML Preview</div>
            <pre className="min-h-full rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-xs text-neutral-200">{validation?.yaml ?? ''}</pre>
          </div>

          <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-neutral-800 bg-neutral-950/95 p-4 backdrop-blur">
            <button onClick={onClose} className="rounded-md bg-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-700">Cancel</button>
            <button disabled={!validation?.ok || isCreating} onClick={() => void handleCreate()} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-neutral-800 disabled:text-neutral-500">
              {isCreating ? 'Creating...' : 'Create Prototype'}
            </button>
          </div>
        </section>
      </div>
      </div>
    </div>
  );
}
