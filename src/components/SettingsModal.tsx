import { useEffect, useState } from 'react';
import { AppInfo, AppSettings, UpdateState } from '../types';
import { useI18n } from '../i18n';
import { useEditorSettings } from '../editorSettings';
import { FileCode2, Globe2, Info, RefreshCw, Download, X } from 'lucide-react';

type SettingsTab = 'general' | 'editor' | 'updates' | 'about';

interface Props {
  open: boolean;
  onClose: () => void;
  updateState: UpdateState;
  onCheckUpdates: () => Promise<void> | void;
  onInstallUpdate: () => Promise<void> | void;
  initialTab?: SettingsTab;
}

export default function SettingsModal({ open, onClose, updateState, onCheckUpdates, onInstallUpdate, initialTab = 'general' }: Props) {
  const { language, setLanguage, t } = useI18n();
  const { settings, updateSettings } = useEditorSettings();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [savingAppSettings, setSavingAppSettings] = useState(false);

  useEffect(() => {
    if (open) setActiveTab(initialTab);
  }, [initialTab, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([
      window.prototypeStudio.getAppInfo(),
      window.prototypeStudio.getAppSettings(),
    ]).then(([info, settings]) => {
      if (cancelled) return;
      setAppInfo(info);
      setAppSettings(settings);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const restartRequired = appSettings != null && appSettings.useHardwareAcceleration !== appSettings.appliedUseHardwareAcceleration;

  async function handleHardwareAccelerationChange(checked: boolean) {
    setSavingAppSettings(true);
    try {
      const next = await window.prototypeStudio.updateAppSettings({ useHardwareAcceleration: checked });
      setAppSettings(next);
    } finally {
      setSavingAppSettings(false);
    }
  }

  const tabs = [
    { key: 'general' as const, icon: Globe2, label: t('settings.tab.general') },
    { key: 'editor' as const, icon: FileCode2, label: t('settings.tab.editor') },
    { key: 'updates' as const, icon: RefreshCw, label: t('settings.tab.updates') },
    { key: 'about' as const, icon: Info, label: t('settings.tab.about') },
  ];

  return (
    <div className="fixed inset-x-0 bottom-0 top-9 z-[60] overflow-hidden bg-black/65 p-4 md:p-6">
      <div className="mx-auto flex h-full items-center justify-center">
        <div className="grid max-h-[min(820px,calc(100vh-2rem))] min-h-0 w-[min(980px,96vw)] grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-950 shadow-2xl">
          <aside className="border-r border-neutral-800 bg-neutral-950/80 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-neutral-100">{t('settings.title')}</h2>
              </div>
              <button onClick={onClose} className="rounded-md p-2 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-1">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                      activeTab === tab.key ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
                    }`}
                  >
                    <Icon size={16} />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]">
            <div className="min-h-0 overflow-y-auto custom-scrollbar p-5">
              {activeTab === 'general' && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-lg font-semibold text-neutral-100">{t('settings.general.title')}</h3>
                  </div>
                  <div className="wizard-section">
                    <label className="wizard-label">
                      {t('settings.general.language')}
                      <select
                        value={language}
                        onChange={(event) => setLanguage(event.target.value as 'en' | 'ru')}
                        className="wizard-input"
                      >
                        <option value="en">{t('lang.english')}</option>
                        <option value="ru">{t('lang.russian')}</option>
                      </select>
                      <span className="wizard-help">{t('settings.general.languageHelp')}</span>
                    </label>

                    <label className="mt-4 flex items-center justify-between gap-4 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="text-neutral-200">{t('settings.general.hardwareAcceleration')}</div>
                        <div className="mt-1 text-xs text-neutral-500">
                          {restartRequired ? t('settings.general.restartToApply') : t('settings.general.hardwareAccelerationHelp')}
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={appSettings?.useHardwareAcceleration ?? true}
                        disabled={savingAppSettings}
                        onChange={(event) => void handleHardwareAccelerationChange(event.target.checked)}
                      />
                    </label>

                    {restartRequired && (
                      <div className="mt-4 flex items-center justify-between gap-4 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-3 text-sm">
                        <span className="text-amber-200">{t('settings.general.restartToApply')}</span>
                        <button
                          onClick={() => void window.prototypeStudio.restartApp()}
                          className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-black hover:bg-amber-400"
                        >
                          {t('settings.general.restartNow')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'editor' && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-lg font-semibold text-neutral-100">{t('settings.editor.title')}</h3>
                  </div>

                  <div className="wizard-section space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <label className="wizard-label">
                        {t('settings.editor.fontSize')}
                        <input
                          type="number"
                          min={10}
                          max={28}
                          value={settings.fontSize}
                          onChange={(event) => updateSettings({ fontSize: Number(event.target.value) })}
                          className="wizard-input"
                        />
                      </label>
                      <label className="wizard-label">
                        {t('settings.editor.tabSize')}
                        <select
                          value={settings.tabSize}
                          onChange={(event) => updateSettings({ tabSize: Number(event.target.value) })}
                          className="wizard-input"
                        >
                          <option value={2}>2</option>
                          <option value={4}>4</option>
                        </select>
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <label className="wizard-label">
                        {t('settings.editor.wordWrap')}
                        <select
                          value={settings.wordWrap}
                          onChange={(event) => updateSettings({ wordWrap: event.target.value as 'on' | 'off' })}
                          className="wizard-input"
                        >
                          <option value="on">{t('common.on')}</option>
                          <option value="off">{t('common.off')}</option>
                        </select>
                      </label>
                      <label className="wizard-label">
                        {t('settings.editor.lineNumbers')}
                        <select
                          value={settings.lineNumbers}
                          onChange={(event) => updateSettings({ lineNumbers: event.target.value as 'on' | 'off' | 'relative' })}
                          className="wizard-input"
                        >
                          <option value="on">{t('common.on')}</option>
                          <option value="off">{t('common.off')}</option>
                          <option value="relative">{t('settings.editor.relative')}</option>
                        </select>
                      </label>
                    </div>

                    <label className="flex items-center justify-between gap-4 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-sm">
                      <span className="text-neutral-200">{t('settings.editor.minimap')}</span>
                      <input
                        type="checkbox"
                        checked={settings.minimap}
                        onChange={(event) => updateSettings({ minimap: event.target.checked })}
                      />
                    </label>

                    <label className="flex items-center justify-between gap-4 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-sm">
                      <span className="text-neutral-200">{t('settings.editor.liveValidation')}</span>
                      <input
                        type="checkbox"
                        checked={settings.liveValidation}
                        onChange={(event) => updateSettings({ liveValidation: event.target.checked })}
                      />
                    </label>

                    <label className="wizard-label">
                      {t('settings.editor.validationDelay')}
                      <input
                        type="number"
                        min={100}
                        max={1500}
                        step={50}
                        value={settings.validationDelay}
                        onChange={(event) => updateSettings({ validationDelay: Number(event.target.value) })}
                        className="wizard-input"
                        disabled={!settings.liveValidation}
                      />
                      <span className="wizard-help">{t('settings.editor.validationDelayHelp')}</span>
                    </label>

                    <label className="flex items-center justify-between gap-4 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-sm">
                      <span className="text-neutral-200">{t('settings.editor.ctrlClickNavigation')}</span>
                      <input
                        type="checkbox"
                        checked={settings.ctrlClickNavigation}
                        onChange={(event) => updateSettings({ ctrlClickNavigation: event.target.checked })}
                      />
                    </label>
                  </div>
                </div>
              )}

              {activeTab === 'updates' && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-lg font-semibold text-neutral-100">{t('settings.updates.title')}</h3>
                  </div>
                  <div className="wizard-section space-y-4">
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-neutral-500">{t('settings.updates.currentVersion')}</span>
                      <span className="text-neutral-200">{updateState.version}</span>
                    </div>
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-neutral-500">{t('settings.updates.status')}</span>
                      <span className="text-neutral-200 text-right">{updateState.message}</span>
                    </div>
                    {updateState.status === 'downloading' && (
                      <div className="space-y-2">
                        <div className="h-2 overflow-hidden rounded-full bg-neutral-900">
                          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round(updateState.progress?.percent ?? 0)}%` }} />
                        </div>
                        <div className="text-xs text-neutral-500">{Math.round(updateState.progress?.percent ?? 0)}%</div>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void (updateState.status === 'downloaded' ? onInstallUpdate() : onCheckUpdates())}
                        disabled={updateState.status === 'checking' || updateState.status === 'downloading' || updateState.status === 'installing'}
                        className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-neutral-800 disabled:text-neutral-500"
                      >
                        {updateState.status === 'downloaded' ? <Download size={15} /> : <RefreshCw size={15} className={updateState.status === 'checking' ? 'animate-spin' : ''} />}
                        {updateState.status === 'downloaded'
                          ? t('settings.updates.action.restart')
                          : updateState.status === 'installing'
                            ? t('settings.updates.action.installing')
                            : t('settings.updates.action.check')}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'about' && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-lg font-semibold text-neutral-100">{t('settings.about.title')}</h3>
                    <p className="mt-2 text-sm text-neutral-400">{t('settings.about.description')}</p>
                  </div>
                  <div className="wizard-section space-y-3 text-sm text-neutral-300">
                    <div className="flex justify-between gap-4">
                      <span className="text-neutral-500">{t('settings.about.author')}</span>
                      <span>{appInfo?.author ?? 'darvin7531'}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-neutral-500">{t('settings.about.license')}</span>
                      <span>{appInfo?.license ?? 'AGPL-3.0-or-later'}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-neutral-500">{t('settings.about.github')}</span>
                      <button
                        onClick={() => void window.prototypeStudio.openExternal(appInfo?.repositoryUrl ?? 'https://github.com/darvin7531/SpaceStation14-Studio')}
                        className="text-blue-400 hover:text-blue-300"
                      >
                        {appInfo?.repositoryUrl ?? 'https://github.com/darvin7531/SpaceStation14-Studio'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-neutral-800 bg-neutral-950/95 px-5 py-3 text-sm backdrop-blur">
              <div className="truncate text-neutral-500">
                {t('settings.footer.version', { version: appInfo?.version ?? updateState.version })}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => void window.prototypeStudio.openExternal(appInfo?.repositoryUrl ?? 'https://github.com/darvin7531/SpaceStation14-Studio')}
                  className="text-blue-400 hover:text-blue-300"
                >
                  {t('settings.about.github')}
                </button>
                <button onClick={onClose} className="rounded-md bg-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-700">
                  {t('common.close')}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
