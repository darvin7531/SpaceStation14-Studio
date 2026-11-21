import { useEffect, useRef } from 'react';
import { Settings2, X } from 'lucide-react';
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from '../lib/editor-settings';

interface Props {
  value: EditorSettings;
  onChange: (value: EditorSettings) => void;
  onClose: () => void;
}
export default function EditorSettingsDialog({ value, onChange, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
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
      <header><h2 id="settings-heading"><Settings2 size={18}/> Настройки редактора</h2>
        <button type="button" onClick={onClose} aria-label="Закрыть настройки"><X size={18}/></button></header>
      <p>Параметры применяются сразу и сохраняются для следующих запусков. Файлы проекта не меняются.</p>
      <div className="settings-fields">
        <label>Размер шрифта (10–28)
          <input type="number" min={10} max={28} step={1} value={value.fontSize}
            onChange={(event) => { const n = Number(event.target.value); if (Number.isFinite(n) && n >= 10 && n <= 28) patch({ fontSize: Math.round(n) }); }}/></label>
        <label>Отступы<select value={value.tabSize} onChange={(event) => patch({ tabSize: Number(event.target.value) === 4 ? 4 : 2 })}>
          <option value={2}>2 пробела</option><option value={4}>4 пробела</option></select></label>
        <label>Перенос строк<select value={value.wordWrap} onChange={(event) => patch({ wordWrap: event.target.value === 'off' ? 'off' : 'on' })}>
          <option value="on">Включён</option><option value="off">Выключен</option></select></label>
        <label>Номера строк<select value={value.lineNumbers} onChange={(event) => patch({ lineNumbers: event.target.value as EditorSettings['lineNumbers'] })}>
          <option value="on">Обычные</option><option value="relative">Относительные</option><option value="off">Скрыть</option></select></label>
        <label className="settings-check"><input type="checkbox" checked={value.minimap} onChange={(event) => patch({ minimap: event.target.checked })}/>Миникарта</label>
      </div>
      <footer><button type="button" onClick={() => onChange({ ...DEFAULT_EDITOR_SETTINGS })}>Сбросить</button>
      <button type="button" onClick={onClose}>Готово</button></footer>
    </div>
  </div>;
}
