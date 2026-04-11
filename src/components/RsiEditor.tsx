import { useCallback, useMemo, useState, type DragEvent } from 'react';
import { useProjectStore } from '../store/projectStore';
import { ImagePlus, Save, Plus, Trash2, Upload } from 'lucide-react';
import { useI18n } from '../i18n';

export default function RsiEditor() {
  const { t } = useI18n();
  const highlightedRsiState = useProjectStore((state) => state.highlightedRsiState);
  const setHighlightedRsiState = useProjectStore((state) => state.setHighlightedRsiState);
  const updateActiveRsiDetail = useProjectStore((state) => state.updateActiveRsiDetail);
  const updateActiveRsiMeta = useProjectStore((state) => state.updateActiveRsiMeta);
  const tabsById = useProjectStore((state) => state.tabsById);
  const activeTabId = useProjectStore((state) => state.activeTabId);
  const [isSaving, setIsSaving] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const activeRsiTab = useMemo(
    () => {
      const tab = activeTabId ? tabsById[activeTabId] : null;
      return tab?.kind === 'rsi' ? tab : null;
    },
    [activeTabId, tabsById],
  );
  const detail = activeRsiTab?.detail ?? null;
  const meta = detail?.meta;
  const states = detail?.states ?? [];
  const isDirty = activeRsiTab?.kind === 'rsi' ? activeRsiTab.dirty : false;

  const primaryPreview = useMemo(() => states.find((state) => state.name === 'icon') ?? states[0] ?? null, [states]);

  if (!detail || !meta) {
    return <div className="flex-1 flex items-center justify-center text-neutral-500 bg-neutral-950">{t('rsi.empty')}</div>;
  }

  const updateMeta = useCallback((patch: Partial<typeof meta>) => {
    if (!detail) return;
    updateActiveRsiMeta((current) => ({
      ...current,
      meta: {
        ...current.meta,
        ...patch,
      },
    }));
  }, [detail, updateActiveRsiMeta]);

  const updateState = useCallback((index: number, patch: Record<string, any>) => {
    const next = meta!.states.map((state, stateIndex) => stateIndex === index ? { ...state, ...patch } : state);
    updateMeta({ states: next });
  }, [meta, updateMeta]);

  const addState = useCallback(() => {
    updateMeta({ states: [...meta!.states, { name: `state-${meta!.states.length + 1}` }] });
  }, [meta, updateMeta]);

  const removeState = useCallback((index: number) => {
    updateMeta({ states: meta!.states.filter((_, stateIndex) => stateIndex !== index) });
  }, [meta, updateMeta]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const next = await window.prototypeStudio.saveRsiAsset({ path: detail.path, meta });
      if (next) updateActiveRsiDetail(next, false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    const files = Array.from(event.dataTransfer.files as FileList).filter((file: File) => file.type === 'image/png' || file.name.toLowerCase().endsWith('.png'));
    if (files.length === 0) return;
    const payload = await Promise.all(files.map(async (file) => ({
      name: file.name,
      dataUrl: await readFileAsDataUrl(file),
    })));
    const next = await window.prototypeStudio.importRsiImages({ path: detail.path, files: payload });
    if (next) updateActiveRsiDetail(next, false);
  };

  return (
    <div className="flex-1 min-w-0 bg-neutral-950 flex flex-col">
      <div className="h-12 border-b border-neutral-800 flex items-center justify-between px-4 shrink-0">
        <div className="min-w-0">
          <h2 className="font-medium text-neutral-200 truncate">{detail.path}</h2>
        </div>
        <button
          onClick={() => void handleSave()}
          disabled={isSaving || !isDirty}
          className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:bg-neutral-800 disabled:text-neutral-500"
          style={{ backgroundColor: !isSaving && isDirty ? '#059669' : undefined }}
        >
          <Save size={14} />
          {isSaving ? t('rsi.saving') : t('rsi.save')}
        </button>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[minmax(340px,420px)_1fr]">
        <div className="border-r border-neutral-800 overflow-y-auto custom-scrollbar p-4 space-y-4">
          <section className="wizard-section">
            <div className="text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-3">{t('rsi.meta')}</div>
            <div className="grid gap-3">
              <label className="wizard-label">{t('common.license')}
                <input value={meta.license} onChange={(event) => updateMeta({ license: event.target.value })} className="wizard-input" />
              </label>
              <label className="wizard-label">{t('common.copyright')}
                <textarea value={meta.copyright} onChange={(event) => updateMeta({ copyright: event.target.value })} className="wizard-input min-h-24 resize-y" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="wizard-label">{t('common.width')}
                  <input type="number" min={1} value={meta.size.x} onChange={(event) => updateMeta({ size: { ...meta.size, x: Number(event.target.value) } })} className="wizard-input" />
                </label>
                <label className="wizard-label">{t('common.height')}
                  <input type="number" min={1} value={meta.size.y} onChange={(event) => updateMeta({ size: { ...meta.size, y: Number(event.target.value) } })} className="wizard-input" />
                </label>
              </div>
            </div>
          </section>

          <section className="wizard-section">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wider text-neutral-400">{t('rsi.statesTitle')}</div>
              <button onClick={addState} className="inline-flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700">
                <Plus size={13} />
                {t('rsi.addState')}
              </button>
            </div>
            <div className="space-y-3">
              {meta.states.map((state, index) => (
                <div key={`${state.name}:${index}`} className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
                  <div className="grid gap-3">
                    <div className="flex items-center justify-between gap-2">
                      <label className="wizard-label flex-1">{t('rsi.stateName')}
                        <input value={state.name} onChange={(event) => updateState(index, { name: event.target.value })} className="wizard-input" />
                      </label>
                      <button onClick={() => removeState(index)} className="mt-5 rounded-md p-2 text-neutral-500 hover:bg-neutral-800 hover:text-red-400" title={t('rsi.deleteState')}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <label className="wizard-label">{t('rsi.directions')}
                      <select value={state.directions ?? 1} onChange={(event) => updateState(index, { directions: Number(event.target.value) === 1 ? undefined : Number(event.target.value) })} className="wizard-input">
                        <option value={1}>1</option>
                        <option value={4}>4</option>
                        <option value={8}>8</option>
                      </select>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="min-h-0 overflow-y-auto custom-scrollbar p-4 space-y-4">
          <div
            onDragOver={(event) => { event.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(event) => void handleDrop(event)}
            className={`rounded-2xl border border-dashed p-6 transition-colors ${isDragOver ? 'border-emerald-400 bg-emerald-500/10' : 'border-neutral-700 bg-neutral-900/40'}`}
          >
            <div className="flex items-center gap-3 text-neutral-200">
              <Upload size={18} className="text-emerald-400" />
              <div>
                <div className="font-medium">{t('rsi.dropTitle')}</div>
                <div className="text-sm text-neutral-500">{t('rsi.dropHelp')}</div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
            {states.map((state) => (
              <div
                key={state.name}
                onClick={() => setHighlightedRsiState(state.name)}
                className={`rounded-xl border bg-neutral-900/60 p-3 ${highlightedRsiState === state.name ? 'border-emerald-400 ring-1 ring-emerald-400/60' : 'border-neutral-800'}`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="truncate text-sm font-medium text-neutral-200" title={state.name}>{state.name}</div>
                  <span className="text-[11px] text-neutral-500">{t('rsi.directionsShort', { count: state.directions ?? 1 })}</span>
                </div>
                <div className="checkerboard rounded-lg border border-neutral-800 min-h-[150px] flex items-center justify-center overflow-hidden">
                  {state.previewDataUrl ? (
                    <img src={state.previewDataUrl} alt={state.name} className="max-h-32 max-w-full object-contain [image-rendering:pixelated]" draggable={false} />
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-neutral-500 text-xs p-4 text-center">
                      <ImagePlus size={24} />
                      {t('rsi.missingPng')}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {primaryPreview && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-3">{t('rsi.primaryPreview')}</div>
              <div className="checkerboard rounded-lg border border-neutral-800 min-h-[240px] flex items-center justify-center overflow-hidden">
                {primaryPreview.previewDataUrl ? (
                  <img src={primaryPreview.previewDataUrl} alt={primaryPreview.name} className="max-h-56 max-w-full object-contain [image-rendering:pixelated]" draggable={false} />
                ) : (
                  <div className="text-neutral-500 text-sm">{t('rsi.noPngFor', { name: primaryPreview.name })}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}
