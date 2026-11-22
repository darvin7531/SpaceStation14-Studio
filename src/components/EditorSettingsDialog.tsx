import { useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { Settings2, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from '../lib/editor-settings';
import { sanitizeLocalizationSettings, type LocalizationSettings } from '../lib/localization-settings';
import { studio, type AppUpdateCheck, type AppUpdateProgress } from '../lib/api';
import { normalizeStudioError } from '../lib/errors';

interface Props {
  value: EditorSettings;
  onChange: (value: EditorSettings) => void;
  localizationSettings: LocalizationSettings;
  dirtyCount: number;
  onLocalizationChange: (value: LocalizationSettings) => void;
  onClose: () => void;
}
export default function EditorSettingsDialog({ value, onChange, localizationSettings, dirtyCount, onLocalizationChange, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { language, setLanguage, t } = useI18n();
  const [section, setSection] = useState<'general' | 'editor' | 'updates' | 'about'>('general');
  const [updateStatus, setUpdateStatus] = useState<AppUpdateCheck | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [localeInput, setLocaleInput] = useState(localizationSettings.requiredLocales.join(', '));
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const localeInputRef = useRef(localeInput);
  const onLocalizationChangeRef = useRef(onLocalizationChange);
  onLocalizationChangeRef.current = onLocalizationChange;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    let active = true;
    void getVersion().then((version) => { if (active) setAppVersion(version); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<AppUpdateProgress>('studio:update-progress', (event) => {
      if (active) setUpdateProgress(event.payload);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    }).catch(() => {});
    return () => { active = false; unlisten?.(); };
  }, []);

  async function checkUpdates() {
    if (checkingUpdates || installingUpdate) return;
    setCheckingUpdates(true);
    setUpdateError(null);
    setUpdateProgress(null);
    try {
      setUpdateStatus(await studio.checkAppUpdates());
    } catch (reason) {
      const error = normalizeStudioError(reason);
      setUpdateError(error.message + ' ' + error.hint);
      setUpdateStatus(null);
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function installUpdate() {
    if (installingUpdate || dirtyCount > 0 || updateStatus?.status !== 'available') return;
    setInstallingUpdate(true);
    setUpdateError(null);
    try {
      await studio.installAppUpdate();
      setUpdateStatus(null);
    } catch (reason) {
      const error = normalizeStudioError(reason);
      setUpdateError(error.message + ' ' + error.hint);
    } finally {
      setInstallingUpdate(false);
    }
  }

  const commitLocales = () => {
    const next = sanitizeLocalizationSettings({ requiredLocales: localeInputRef.current.split(',') });
    localeInputRef.current = next.requiredLocales.join(', ');
    setLocaleInput(localeInputRef.current);
    if (next.requiredLocales.join('\u0000') !== localizationSettings.requiredLocales.join('\u0000')) {
      onLocalizationChangeRef.current(next);
    }
  };
  const commitLocalesRef = useRef(commitLocales);
  commitLocalesRef.current = commitLocales;
  const closeSettings = () => {
    commitLocalesRef.current();
    onCloseRef.current();
  };
  const closeSettingsRef = useRef(closeSettings);
  closeSettingsRef.current = closeSettings;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); closeSettingsRef.current(); }
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
    if (event.target === event.currentTarget) closeSettings();
  }}>
    <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-heading" tabIndex={-1} ref={ref}>
      <header><h2 id="settings-heading"><Settings2 size={18}/> {t('settings.title')}</h2>
        <button type="button" onClick={closeSettings} aria-label={t('settings.close')}><X size={18}/></button></header>
      <nav className="settings-tabs" aria-label={t('settings.sections')}>
        <button type="button" aria-current={section === 'general' ? 'page' : undefined} onClick={() => setSection('general')}>{t('settings.general')}</button>
        <button type="button" aria-current={section === 'editor' ? 'page' : undefined} onClick={() => setSection('editor')}>{t('settings.editor')}</button>
        <button type="button" aria-current={section === 'updates' ? 'page' : undefined} onClick={() => setSection('updates')}>{t('settings.updates')}</button>
        <button type="button" aria-current={section === 'about' ? 'page' : undefined} onClick={() => setSection('about')}>{t('settings.about')}</button>
      </nav>
      <p>{t('settings.description')}</p>
      {section === 'general' && <div className="settings-fields">
        <label>{t('settings.language')}
          <select value={language} onChange={(event) => setLanguage(event.target.value === 'en' ? 'en' : 'ru')}>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
          <small>{t('settings.languageHint')}</small>
        </label>
        <label>{t('settings.requiredLocales')}
          <input type="text" placeholder="ru-RU, en-US" value={localeInput}
            onChange={(event) => { localeInputRef.current = event.target.value; setLocaleInput(event.target.value); }}
            onBlur={commitLocales}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}/>
          <small>{t('settings.requiredLocalesHint')}</small>
        </label>
      </div>}
      {section === 'editor' && <div className="settings-fields">
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
      </div>}
      {section === 'updates' && <div className="settings-fields">
        <p>{t('settings.updatesDescription')}</p>
        <p>{t('settings.updatesVersion')}: {appVersion ?? '—'}</p>
        {updateStatus && <p role="status">{updateStatus.message}
          {updateStatus.available_version ? ' (' + updateStatus.available_version + ')' : ''}
        </p>}
        {updateError && <p role="alert">{updateError}</p>}
        {updateProgress?.event === 'downloading' && <p role="status">
          {t('settings.updatesDownloading')} {updateProgress.total_bytes && updateProgress.total_bytes > 0
            ? Math.floor(updateProgress.downloaded_bytes * 100 / updateProgress.total_bytes) + '%'
            : Math.round(updateProgress.downloaded_bytes / 1024) + ' KiB'}
        </p>}
        {updateProgress?.event === 'finished' && <p role="status">{t('settings.updatesDownloaded')}</p>}
        {dirtyCount > 0 && <small role="status">{t('settings.updatesDirty', { count: dirtyCount })}</small>}
        <div className="settings-update-actions">
          <button type="button" disabled={checkingUpdates || installingUpdate}
            onClick={() => void checkUpdates()}>
            {checkingUpdates ? t('settings.updatesChecking') : t('settings.updatesCheck')}
          </button>
          <button type="button" disabled={installingUpdate || checkingUpdates || dirtyCount > 0
            || updateStatus?.status !== 'available'}
            onClick={() => void installUpdate()}>
            {installingUpdate ? t('settings.updatesInstalling') : t('settings.updatesInstall')}
          </button>
        </div>
        <small>{t('settings.updatesSigningNotice')}</small>
      </div>}
      {section === 'about' && <div className="settings-about">
        <p>{t('settings.aboutDescription')}</p>
        <dl>
          <dt>{t('settings.aboutVersion')}</dt><dd>{appVersion ?? '—'}</dd>
          <dt>{t('settings.aboutAuthor')}</dt><dd>darvin7531</dd>
          <dt>{t('settings.aboutLicense')}</dt><dd>AGPL-3.0-or-later</dd>
          <dt>GitHub</dt><dd>github.com/darvin7531/SpaceStation14-Studio</dd>
        </dl>
      </div>}
      <footer>
        {section === 'editor' && <button type="button" onClick={() => onChange({ ...DEFAULT_EDITOR_SETTINGS })}>{t('settings.reset')}</button>}
        <button type="button" onClick={closeSettings}>{t('settings.done')}</button>
      </footer>
    </div>
  </div>;
}
