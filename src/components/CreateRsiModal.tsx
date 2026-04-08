import { useEffect, useState } from 'react';
import { FolderOpen, FolderPlus, X } from 'lucide-react';
import { CreateRsiDraft } from '../types';
import { useI18n } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (path: string) => Promise<void> | void;
}

const defaultDraft: CreateRsiDraft = {
  directory: 'Resources/Textures/_Studio',
  name: 'new-rsi',
  sizeX: 32,
  sizeY: 32,
  license: 'CC-BY-SA-3.0',
  copyright: '',
};

export default function CreateRsiModal({ open, onClose, onCreated }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<CreateRsiDraft>(defaultDraft);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const update = (patch: Partial<CreateRsiDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const handleBrowseFolder = async () => {
    const selected = await window.prototypeStudio.pickProjectFolder({ scope: 'textures', currentPath: draft.directory });
    if (selected) update({ directory: selected });
  };

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const detail = await window.prototypeStudio.createRsiAsset(draft);
      if (!detail) return;
      await onCreated(detail.path);
      setDraft(defaultDraft);
      onClose();
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-x-0 bottom-0 top-9 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="w-[min(560px,96vw)] rounded-2xl border border-neutral-700 bg-neutral-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-emerald-400">{t('rsi.create.badge')}</div>
            <h2 className="text-xl font-semibold text-neutral-100">{t('rsi.create.title')}</h2>
          </div>
          <button onClick={onClose} className="rounded-md p-2 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100">
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-4 p-5">
          <label className="wizard-label">{t('rsi.directory')}
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input value={draft.directory} onChange={(event) => update({ directory: event.target.value })} className="wizard-input" />
              <button type="button" onClick={() => void handleBrowseFolder()} className="inline-flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-3 text-xs text-neutral-300 hover:bg-neutral-800">
                <FolderOpen size={14} />
                {t('wizard.browse')}
              </button>
            </div>
            <span className="wizard-help">{t('rsi.directoryHelp')}</span>
          </label>
          <label className="wizard-label">{t('rsi.name')}
            <input value={draft.name} onChange={(event) => update({ name: event.target.value })} className="wizard-input" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="wizard-label">{t('common.width')}
              <input type="number" min={1} value={draft.sizeX} onChange={(event) => update({ sizeX: Number(event.target.value) })} className="wizard-input" />
            </label>
            <label className="wizard-label">{t('common.height')}
              <input type="number" min={1} value={draft.sizeY} onChange={(event) => update({ sizeY: Number(event.target.value) })} className="wizard-input" />
            </label>
          </div>
          <label className="wizard-label">{t('common.license')}
            <input value={draft.license} onChange={(event) => update({ license: event.target.value })} className="wizard-input" />
          </label>
          <label className="wizard-label">{t('common.copyright')}
            <textarea value={draft.copyright} onChange={(event) => update({ copyright: event.target.value })} className="wizard-input min-h-24 resize-y" />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-neutral-800 px-5 py-4">
          <button onClick={onClose} className="rounded-md bg-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-700">{t('common.cancel')}</button>
          <button onClick={() => void handleCreate()} disabled={isCreating} className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:bg-neutral-800 disabled:text-neutral-500">
            <FolderPlus size={15} />
            {isCreating ? t('wizard.creating') : t('rsi.createAction')}
          </button>
        </div>
      </div>
    </div>
  );
}
