import { useEffect, useState } from 'react';
import { FolderOpen, Languages, Plus, X } from 'lucide-react';
import { CreateLocaleDraft } from '../types';
import { useI18n } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (path: string) => Promise<void> | void;
}

const defaultDraft: CreateLocaleDraft = {
  locale: 'en-US',
  directory: 'Resources/Locale/en-US',
  fileName: 'new-file.ftl',
  starterKey: '',
  starterValue: '',
};

export default function CreateLocaleModal({ open, onClose, onCreated }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<CreateLocaleDraft>(defaultDraft);
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

  const update = (patch: Partial<CreateLocaleDraft>) => setDraft((current) => {
    const next = { ...current, ...patch };
    if (patch.locale && !patch.directory) {
      next.directory = `Resources/Locale/${patch.locale}`;
    }
    return next;
  });

  const handleBrowseFolder = async () => {
    const selected = await window.prototypeStudio.pickProjectFolder({ scope: 'locale', currentPath: draft.directory });
    if (selected) update({ directory: selected });
  };

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const detail = await window.prototypeStudio.createLocaleAsset(draft);
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
      <div className="w-[min(640px,96vw)] rounded-2xl border border-neutral-700 bg-neutral-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-amber-400">{t('locale.create.badge')}</div>
            <h2 className="text-xl font-semibold text-neutral-100">{t('locale.create.title')}</h2>
          </div>
          <button onClick={onClose} className="rounded-md p-2 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100">
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-4 p-5">
          <div className="grid grid-cols-2 gap-3">
            <label className="wizard-label">{t('locale.locale')}
              <input value={draft.locale} onChange={(event) => update({ locale: event.target.value })} className="wizard-input" />
            </label>
            <label className="wizard-label">{t('locale.fileName')}
              <input value={draft.fileName} onChange={(event) => update({ fileName: event.target.value })} className="wizard-input" />
            </label>
          </div>
          <label className="wizard-label">{t('locale.directory')}
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input value={draft.directory} onChange={(event) => update({ directory: event.target.value })} className="wizard-input" />
              <button type="button" onClick={() => void handleBrowseFolder()} className="inline-flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-3 text-xs text-neutral-300 hover:bg-neutral-800">
                <FolderOpen size={14} />
                {t('wizard.browse')}
              </button>
            </div>
            <span className="wizard-help">{t('locale.directoryHelp')}</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="wizard-label">{t('locale.starterKey')}
              <input value={draft.starterKey ?? ''} onChange={(event) => update({ starterKey: event.target.value })} placeholder="my-message" className="wizard-input" />
            </label>
            <label className="wizard-label">{t('locale.starterValue')}
              <input value={draft.starterValue ?? ''} onChange={(event) => update({ starterValue: event.target.value })} placeholder="Hello world" className="wizard-input" />
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-neutral-800 px-5 py-4">
          <button onClick={onClose} className="rounded-md bg-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-700">{t('common.cancel')}</button>
          <button onClick={() => void handleCreate()} disabled={isCreating} className="inline-flex items-center gap-2 rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:bg-neutral-800 disabled:text-neutral-500">
            <Languages size={15} />
            <Plus size={14} />
            {isCreating ? t('wizard.creating') : t('locale.createAction')}
          </button>
        </div>
      </div>
    </div>
  );
}
