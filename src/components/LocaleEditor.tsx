import { useMemo, useRef, useState } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { Save } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import { useI18n } from '../i18n';
import { useEditorSettings } from '../editorSettings';

export default function LocaleEditor() {
  const { t } = useI18n();
  const { settings } = useEditorSettings();
  const activeTabId = useProjectStore((state) => state.activeTabId);
  const tabsById = useProjectStore((state) => state.tabsById);
  const updateActiveLocaleText = useProjectStore((state) => state.updateActiveLocaleText);
  const updateActiveLocaleSaved = useProjectStore((state) => state.updateActiveLocaleSaved);
  const activeLocaleTab = useMemo(() => {
    const tab = activeTabId ? tabsById[activeTabId] : null;
    return tab?.kind === 'locale' ? tab : null;
  }, [activeTabId, tabsById]);
  const editorRef = useRef<any>(null);
  const [isSaving, setIsSaving] = useState(false);

  if (!activeLocaleTab) {
    return <div className="flex-1 flex items-center justify-center text-neutral-500 bg-neutral-950">{t('locale.empty')}</div>;
  }

  const detail = activeLocaleTab.detail;
  const isDirty = activeLocaleTab.dirty;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const saved = await window.prototypeStudio.saveLocaleAsset({
        path: activeLocaleTab.localePath,
        text: activeLocaleTab.text,
      });
      if (saved) {
        updateActiveLocaleSaved(saved, saved.text);
      }
    } catch (error) {
      console.error('Failed to save locale file', error);
      alert(error instanceof Error ? error.message : t('locale.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-neutral-950">
      <div className="h-12 border-b border-neutral-800 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <h2 className="font-medium text-neutral-200 truncate">{activeLocaleTab.title}</h2>
          <span className="text-xs text-neutral-500 truncate">{detail?.locale ?? ''}</span>
          <span className="text-xs text-neutral-500 truncate">{activeLocaleTab.subtitle}</span>
        </div>
        <button
          onClick={() => void handleSave()}
          disabled={!isDirty || isSaving}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            isDirty && !isSaving ? 'bg-amber-600 hover:bg-amber-700 text-white' : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
          }`}
        >
          <Save size={14} />
          {isSaving ? t('locale.saving') : t('locale.save')}
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        <MonacoEditor
          path={`inmemory://locale/${activeLocaleTab.id}.ftl`}
          height="100%"
          language="plaintext"
          theme="vs-dark"
          value={activeLocaleTab.text}
          onMount={(editor) => {
            editorRef.current = editor;
          }}
          onChange={(value) => {
            updateActiveLocaleText(value ?? '');
          }}
          options={useMemo(() => ({
            minimap: { enabled: settings.minimap },
            fontSize: settings.fontSize,
            wordWrap: settings.wordWrap,
            scrollBeyondLastLine: false,
            tabSize: settings.tabSize,
            lineNumbers: settings.lineNumbers,
          }), [settings.minimap, settings.fontSize, settings.wordWrap, settings.tabSize, settings.lineNumbers])}
        />
      </div>
    </div>
  );
}
