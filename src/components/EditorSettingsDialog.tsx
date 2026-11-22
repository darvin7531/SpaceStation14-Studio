import { useEffect, useRef } from 'react';
import { Settings2, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from '../lib/editor-settings';

interface Props {
  value: EditorSettings;
  onChange: (value: EditorSettings) => void;
  onClose: () => void;
}
export default function EditorSettingsDialog({ value, onChange, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { language, setLanguage, t } = useI18n();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab' || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)'));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);
  const patch = (v: Partial<EditorSettings>) => onChange({ ...value, ...v });
  return <div className="settings-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-heading" tabIndex={-1} ref={ref}>
      <header><h2 id="settings-heading"><Settings2 size={18}/> {t('settings.title')}</h2>
        <button type="button" onClick={onClose} aria-label="{t('settings.close')}"><X size={18}/></button></header>
      <p>{t('settings.description')}</p>
      <div className="settings-fields">
        <label>{t('settings.language')}
          <select value={language} onChange={(event) => setLanguage(event.target.value === 'en' ? 'en' : 'ru')}>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
          <small>{t('settings.languageHint')}</small>
        </label>
        <label>{t('settings.fontSize')}
          <input type="number" min={10} max={28} step={1} value={value.fontSize}
            onChange={(event) => { const n = Number(event.target.value); if (Number.isFinite(n) && n >= 10 && n <= 28) patch({ fontSize: Math.round(n) }); }}/></label>
        <label>{t('settings.tabs')}<select value={value.tabSize} onChange={(event) => patch({ tabSize: Number(event.target.value) === 4 ? 4 : 2 })}>
          <option value={2}>{t('settings.spaces2')}</option><option value={4}>{t('settings.spaces4')}</option></select></label>
        <label>{t('settings.wordWrap')}<select value={value.wordWrap} onChange={(event) => patch({ wordWrap: event.target.value === 'off' ? 'off' : 'on' })}>
          <option value="on">{t('settings.enabled')}</option><option value="off">{t('settings.disabled')}</option></select></label>
        <label>{t('settings.lineNumbers')}<select value={value.lineNumbers} onChange={(event) => patch({ lineNumbers: event.target.value as EditorSettings['lineNumbers'] })}>
          <option value="on">{t('settings.normal')}</option><option value="relative">{t('settings.relative')}</option><option value="off">{t('settings.hidden')}</option></select></label>
        <label className="settings-check"><input type="checkbox" checked={value.minimap} onChange={(event) => patch({ minimap: event.target.checked })}/>{t('settings.minimap')}</label>
        <label className="settings-check"><input type="checkbox"
          checked={value.ctrlClickNavigation} onChange={(event) => patch({ ctrlClickNavigation: event.target.checked })}/>
          {t('settings.navigate')}
        </label>
        <label className="settings-check"><input type="checkbox" checked={value.liveValidation}
          onChange={(event) => patch({ liveValidation: event.target.checked })}/>{t('settings.validate')}</label>
        <label>{t('settings.validationDelay')}
          <input type="number" min={100} max={1500} step={50}
            disabled={!value.liveValidation} value={value.validationDelay}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next) && next >= 100 && next <= 1500) patch({ validationDelay: Math.round(next) });
            }}/>
        </label>
      </div>
      <footer><button type="button" onClick={() => onChange({ ...DEFAULT_EDITOR_SETTINGS })}>{t('settings.reset')}</button>
      <button type="button" onClick={onClose}>{t('settings.done')}</button></footer>
    </div>
  </div>;
}
