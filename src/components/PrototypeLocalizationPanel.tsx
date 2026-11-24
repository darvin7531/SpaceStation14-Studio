import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { AlertTriangle, Languages, RefreshCw, X } from 'lucide-react';
import { studio, type EntityLocalizationSource, type EntityLocalizationAnalysis, type PrototypeFieldLocator, type ResourceDocument, type ResourceEntry, type NewFluentDraft } from '../lib/api';
import { buildEntityLocalePatch, planMissingEntityTranslations, buildMissingFluentDraft, isFluentDefinition, type EntityLocaleField, type EntityLocalePatch } from '../lib/entity-localization';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { localeFromFtlPath, localeResourceSearch } from '../lib/localization-settings';

interface Props {
  projectRoot: string;
  locator: PrototypeFieldLocator;
  source: string;
  busy: boolean;
  requiredLocales: readonly string[];
  onCreateMissing: (draft: NewFluentDraft) => void;
  onCreateBatch: (draft: NewFluentDraft, sourceSnapshot: string, projectRoot: string) => Promise<import('../lib/api').CreatedFluent>;
  onApply: (file: string, original: ResourceDocument, content: string, keepSource?: boolean, sourceSnapshot?: string, projectRoot?: string) => Promise<boolean>;
  onClose: () => void;
}

const FIELDS: { field: EntityLocaleField; label: import('../lib/ui-language').UIKey }[] = [
  { field: 'name', label: 'entityLocale.name' },
  { field: 'description', label: 'entityLocale.description' },
  { field: 'suffix', label: 'entityLocale.suffix' },
];

export default function PrototypeLocalizationPanel({ projectRoot, locator, source, busy, requiredLocales, onCreateMissing, onApply, onCreateBatch, onClose }: Props) {
  const { t } = useI18n();
  const [entity, setEntity] = useState<EntityLocalizationSource | null>(null);
  const [analysis, setAnalysis] = useState<EntityLocalizationAnalysis | null>(null);
  const [files, setFiles] = useState<ResourceEntry[]>([]);
  const [fileTotal, setFileTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState('');
  const [selected, setSelected] = useState<EntityLocaleField[]>(['name', 'description', 'suffix']);
  const [preview, setPreview] = useState<{ baseline: ResourceDocument; patch: EntityLocalePatch; sourceSnapshot: string; projectRoot: string } | null>(null);
  const [batchPreview, setBatchPreview] = useState<{
    sourceSnapshot: string;
    projectRoot: string;
    entries: { locale: string; baseline: ResourceDocument; patch: EntityLocalePatch }[];
    missingFiles: { locale: string; path: string; draft: NewFluentDraft }[];
  } | null>(null);
  const [reading, setReading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const [notice, setNotice] = useState<{ key: import('../lib/ui-language').UIKey; params?: Record<string, string | number> } | null>(null);

  useEffect(() => {
    let live = true;
    setEntity(null);
    setAnalysis(null);
    setPreview(null);
    setBatchPreview(null);
    setError(null);
    void Promise.all([
      studio.inspectEntityLocalization(locator, source),
      studio.analyzeEntityLocalization(locator, source, [...requiredLocales]),
    ]).then(([result, report]) => {
      if (!live) return;
      setEntity(result);
      setAnalysis(report);
    }).catch((failure) => {
      if (live) setError(normalizeStudioError(failure));
    });
    return () => { live = false; };
  }, [locator, source, requiredLocales]);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void studio.searchResources(search, 'ftl', 0, 100).then((result) => {
        if (!live) return;
        setFiles(result.items);
        setFileTotal(result.total);
      }).catch((failure) => {
        if (live) setError(normalizeStudioError(failure));
      });
    }, 160);
    return () => { live = false; window.clearTimeout(timer); };
  }, [search]);

  const chosen = selected.filter((field) => entity?.[field]?.trim());
  const disabled = busy || applying || reading || !entity;

  async function inspectTarget() {
    if (!entity || !target || chosen.length === 0 || disabled) return;
    setReading(true);
    setError(null);
    setPreview(null);
    try {
      // The old Electron implementation could create duplicate IDs in separate FTLs.
      // Check the indexed locale before editing, refusing incomplete scans instead of guessing.
      const matches = await studio.searchResourceContent(entity.localization_id, 'ftl', projectRoot);
      if (!matches.complete) {
        throw new Error(t('entityLocale.incompleteSearch'));
      }
      const localeRoot = target.split('/').slice(0, 3).join('/') + '/';
      const otherDefinition = matches.items.find((hit) => hit.path !== target
        && hit.path.startsWith(localeRoot)
        && isFluentDefinition(hit.preview, entity.localization_id));
      if (otherDefinition) {
        throw new Error(t('entityLocale.duplicate', { path: otherDefinition.path, line: otherDefinition.line }));
      }
      const baseline = await studio.readResource(target, projectRoot);
      if (baseline.path !== target) throw new Error(t('entityLocale.targetChanged'));
      const patch = buildEntityLocalePatch(baseline.content, entity, chosen);
      setPreview({ baseline, patch, sourceSnapshot: source, projectRoot });
      setNotice({ key: patch.changed ? 'entityLocale.previewReady' : 'entityLocale.alreadyPresent' });
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setReading(false);
    }
  }

  async function save() {
    if (!preview || !preview.patch.changed || disabled || !target || preview.baseline.path !== target || preview.sourceSnapshot !== source || preview.projectRoot !== projectRoot) return;
    setApplying(true);
    setError(null);
    try {
      const success = await onApply(target, preview.baseline, preview.patch.content, false, preview.sourceSnapshot, preview.projectRoot);
      if (!success) return;
      setPreview(null);
      setNotice({ key: 'entityLocale.updated' });
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setApplying(false);
    }
  }


  /** Port of Electron's multi-locale localization quick-fix.
   * Only native-confirmed missing values are staged; no FTL is modified here.
   */
  async function prepareBatch() {
    if (!entity || disabled || chosen.length === 0) return;
    setReading(true);
    setError(null);
    setBatchPreview(null);
    try {
      await studio.refreshProject(undefined, projectRoot);
      const fresh = await studio.analyzeEntityLocalization(locator, source, [...requiredLocales], projectRoot);
      setAnalysis(fresh);
      if (!fresh.complete) throw new Error(t('entityLocale.incompleteIndex'));
      const plan = planMissingEntityTranslations(fresh, chosen);
      if (!plan.length) {
        setNotice({ key: 'entityLocale.noMissing' });
        return;
      }
      const present = plan.filter((item) => item.fileExists);
      const missingFiles = plan.filter((item) => !item.fileExists).map(({ locale, path, fields }) => {
        if (!path.startsWith('Resources/Locale/') || !path.endsWith('.ftl') || localeFromFtlPath(path) !== locale) {
          throw new Error(t('entityLocale.invalidPath', { path }));
        }
        return { locale, path, draft: buildMissingFluentDraft(path, entity, fields) };
      });
      const entries: { locale: string; baseline: ResourceDocument; patch: EntityLocalePatch }[] = [];
      if (present.length) {
        const matches = await studio.searchResourceContent(entity.localization_id, 'ftl', projectRoot);
        if (!matches.complete) throw new Error(t('entityLocale.incompleteDefinitions'));
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(entity.localization_id)) {
          throw new Error(t('entityLocale.invalidId'));
        }
        for (const item of present) {
          if (!item.path.startsWith('Resources/Locale/') || !item.path.endsWith('.ftl')
              || localeFromFtlPath(item.path) !== item.locale) {
            throw new Error(t('entityLocale.invalidLocalePath', { locale: item.locale, path: item.path }));
          }
          const prefix = item.path.split('/').slice(0, 3).join('/') + '/';
          const duplicate = matches.items.find((hit) =>
            hit.path !== item.path && hit.path.startsWith(prefix) && isFluentDefinition(hit.preview, entity.localization_id));
          if (duplicate) {
            throw new Error(t('entityLocale.duplicateLocale', { locale: item.locale, path: duplicate.path, line: duplicate.line }));
          }
          const baseline = await studio.readResource(item.path, projectRoot);
          if (baseline.path !== item.path) throw new Error(t('entityLocale.ftlChanged', { path: item.path }));
          const patch = buildEntityLocalePatch(baseline.content, entity, item.fields);
          if (patch.changed) entries.push({ locale: item.locale, baseline, patch });
        }
      }
      setBatchPreview({ sourceSnapshot: source, projectRoot, entries, missingFiles });
      setNotice({ key: 'entityLocale.batchReady', params: { existing: entries.length, missing: missingFiles.length } });
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setReading(false);
    }
  }

  async function applyBatch() {
    if (!batchPreview || (!batchPreview.entries.length && !batchPreview.missingFiles.length) || batchPreview.sourceSnapshot !== source || batchPreview.projectRoot !== projectRoot || disabled) return;
    setApplying(true);
    setError(null);
    let saved = 0;
    try {
      for (const entry of batchPreview.entries) {
        // Every file keeps its preview SHA-256 revision and the normal unsaved-draft guard.
        const success = await onApply(entry.baseline.path, entry.baseline, entry.patch.content, true, source, batchPreview.projectRoot);
        if (!success) throw new Error(t('entityLocale.unconfirmed', { path: entry.baseline.path }));
        saved++;
        setBatchPreview((current) => current ? {
          ...current, entries: current.entries.filter((item) => item.baseline.path !== entry.baseline.path),
        } : null);
      }
      for (const item of batchPreview.missingFiles) {
        // Recheck the indexed locale and search before each exclusive create.
        await studio.refreshProject(undefined, projectRoot);
        const fresh = await studio.analyzeEntityLocalization(locator, source, [...requiredLocales], projectRoot);
        const plan = planMissingEntityTranslations(fresh, chosen);
        const candidate = plan.find((entry) => entry.locale === item.locale && entry.path === item.path && !entry.fileExists);
        if (!fresh.complete || !candidate || JSON.stringify(buildMissingFluentDraft(item.path, entity!, candidate.fields)) !== JSON.stringify(item.draft)) {
          throw new Error(t('entityLocale.changedRetry', { path: item.path }));
        }
        const matches = await studio.searchResourceContent(entity!.localization_id, 'ftl', projectRoot);
        if (!matches.complete) throw new Error(t('entityLocale.incompleteDefinitions'));
        const prefix = item.path.split('/').slice(0, 3).join('/') + '/';
        if (matches.items.some((hit) => hit.path.startsWith(prefix) && isFluentDefinition(hit.preview, entity!.localization_id))) {
          throw new Error(t('entityLocale.idExists', { locale: item.locale }));
        }
        const result = await onCreateBatch(item.draft, source, batchPreview.projectRoot);
        saved++;
        setBatchPreview((current) => current ? {
          ...current, missingFiles: current.missingFiles.filter((entry) => entry.path !== item.path),
        } : null);
        if (result.warning || !result.overview) {
          throw new Error(result.warning || t('entityLocale.indexNotUpdated'));
        }
      }
      setBatchPreview(null);
      setNotice({ key: 'entityLocale.saved', params: { count: saved } });
      try {
        setAnalysis(await studio.analyzeEntityLocalization(locator, source, [...requiredLocales], projectRoot));
      } catch {
        setNotice({ key: 'entityLocale.savedRefresh', params: { count: saved } });
      }
    } catch (failure) {
      setError(normalizeStudioError(failure));
      setNotice({ key: 'entityLocale.partial', params: { count: saved } });
    } finally {
      setApplying(false);
    }
  }

  return <section className="prototype-field-editor entity-locale-panel" aria-label={t('entityLocale.label', { id: locator.id })}>
    <header>
      <div><strong><Languages size={15}/> {t('entityLocale.heading', { id: locator.id })}</strong>
        <small>{locator.file} · {t('entityLocale.sourceOnly')}</small>
      </div>
      <button type="button" title={t('entityLocale.close')} aria-label={t('entityLocale.close')} disabled={reading || applying} onClick={onClose}><X size={16}/></button>
    </header>
    {error && <div className="prototype-field-error" role="alert">
      <AlertTriangle size={15}/><span>{error.message} {error.hint} <code>{error.code}</code></span>
    </div>}
    {!entity ? <p className="prototype-field-notice"><RefreshCw size={14}/> {t('entityLocale.checkingYaml')}</p> : <>
      <p className="prototype-field-notice">
        Fluent ID: <code>{entity.localization_id}</code>. {t('entityLocale.explanation')}
      </p>
      {analysis && <div className="entity-locale-status" aria-live="polite">
        <strong>{t('entityLocale.checkLocales')}</strong>
        {!analysis.complete ? <p role="alert">{t('entityLocale.incomplete')}
          {analysis.warnings.map((warning) => <span key={warning}>{warning} </span>)}</p>
          : analysis.diagnostics.length === 0 ? <p>{t('entityLocale.noGaps')}</p>
          : <div>
            <p>{t('entityLocale.missing')}</p>
            {analysis.diagnostics.map((issue) => <div key={issue.field}>
              <strong>{issue.field}</strong>: {issue.missing_locales.join(', ')}
              {issue.targets.filter((target) => issue.missing_locales.includes(target.locale)).map((target) =>
                target.file_exists ? <button type="button" key={target.locale} disabled={disabled}
                  onClick={() => {
                    setSearch(localeResourceSearch(target.locale));
                    setTarget(target.path);
                    setSelected([issue.field]);
                    setPreview(null);
                  }}>{t('entityLocale.fix', { locale: target.locale })}</button>
                  : <span key={target.locale}>
                    <small> {t('entityLocale.missingFile', { locale: target.locale, path: target.path })} </small>
                    {entity.name.trim() && <button type="button" disabled={disabled}
                      onClick={() => onCreateMissing({
                        file: target.path,
                        starter_key: entity.localization_id,
                        starter_value: entity.name,
                        starter_description: entity.description,
                        starter_suffix: entity.suffix,
                      })}>{t('entityLocale.create', { locale: target.locale })}</button>}
                  </span>)}
            </div>)}
          </div>}
      </div>}
      <div className="entity-locale-preview" aria-label={t('entityLocale.batchLabel')}>
        <strong>{t('entityLocale.batchTitle')}</strong>
        <p>{t('entityLocale.batchHelp')}</p>
        <button type="button" disabled={disabled || chosen.length === 0 || !analysis?.complete}
          onClick={() => void prepareBatch()}>
          <RefreshCw size={14}/> {reading ? t('entityLocale.checking') : t('entityLocale.previewAll')}
        </button>
        {batchPreview && <div aria-live="polite">
          <strong>{t('entityLocale.willChange', { count: batchPreview.entries.length })}</strong>
          {batchPreview.entries.map(({ locale, baseline, patch }) => <div key={baseline.path}>
            <code>{locale}</code> · {baseline.path} · +{patch.added.join(', ')}
          </div>)}
          {batchPreview.missingFiles.length > 0 && <>
            <strong>{t('entityLocale.willCreate')}</strong>
            {batchPreview.missingFiles.map((item) => <div key={item.locale + ':' + item.path}>
              {item.locale} · {item.path} · +{[item.draft.starter_value && 'name', item.draft.starter_description && 'description', item.draft.starter_suffix && 'suffix'].filter(Boolean).join(', ')}
            </div>)}
          </>}
          <div className="prototype-field-actions">
            <button type="button" disabled={disabled || batchPreview.sourceSnapshot !== source
              || (batchPreview.entries.length === 0 && batchPreview.missingFiles.length === 0)} onClick={() => void applyBatch()}>
              <Languages size={14}/> {applying ? t('entityLocale.writing') : t('entityLocale.writeCount', { count: batchPreview.entries.length + batchPreview.missingFiles.length })}
            </button>
            <button type="button" disabled={applying} onClick={() => setBatchPreview(null)}>{t('entityLocale.cancel')}</button>
          </div>
          <small>{t('entityLocale.batchCaveat')}</small>
        </div>}
      </div>
      <div className="entity-locale-fields">
        {FIELDS.map(({ field, label }) => <label key={field}>
          <input type="checkbox" checked={selected.includes(field)}
            disabled={disabled || !entity[field]}
            onChange={(event) => {
              setSelected((current) => event.target.checked
                ? [...current, field] : current.filter((candidate) => candidate !== field));
              setPreview(null);
              setBatchPreview(null);
            }}/>
          <span>{t(label)} — <code>{entity[field] || t('entityLocale.noYamlValue')}</code></span>
        </label>)}
      </div>
      <div className="entity-locale-shortcuts">
        <small>{t('entityLocale.required')}</small>
        {requiredLocales.map((locale) => <button type="button" key={locale}
          disabled={disabled} onClick={() => { setSearch(localeResourceSearch(locale)); setTarget(''); setPreview(null); }}>
          {locale}</button>)}
        <button type="button" disabled={disabled}
          onClick={() => { setSearch(''); setTarget(''); setPreview(null); }}>{t('entityLocale.all')}</button>
      </div>
      <label className="entity-locale-filter">{t('entityLocale.search')}
        <input type="search" placeholder={t('entityLocale.placeholder')}
          value={search} onChange={(event) => { setSearch(event.target.value); setPreview(null); }}/>
      </label>
      <label className="entity-locale-filter">{t('entityLocale.destination', { count: fileTotal })}
        <select value={target} disabled={disabled}
          onChange={(event) => { setTarget(event.target.value); setPreview(null); setError(null); }}>
          <option value="">{t('entityLocale.choose')}</option>
          {target && !files.some((entry) => entry.path === target)
            && <option value={target}>{target}</option>}
          {files.map((entry) => <option key={entry.path} value={entry.path}>{entry.path}</option>)}
        </select>
        {target && <small>{t('entityLocale.targetLocale', { locale: localeFromFtlPath(target) ?? t('entityLocale.unknown') })}</small>}
      </label>
      {preview && <div className="entity-locale-preview">
        <strong>{t('entityLocale.preview')}</strong>
        <small>{t('entityLocale.previewSummary', { added: preview.patch.added.join(', ') || t('entityLocale.noneAdded'), present: preview.patch.alreadyPresent.join(', ') || t('entityLocale.nonePresent') })}</small>
        <pre>{preview.patch.content === preview.baseline.content ? t('entityLocale.unchanged')
          : preview.patch.content.slice(-3500)}</pre>
      </div>}
      <div className="prototype-field-actions">
        <small>{notice ? t(notice.key, notice.params) : t('entityLocale.writeHelp')}</small>
        <button type="button" disabled={disabled || !target || chosen.length === 0} onClick={() => void inspectTarget()}>
          <RefreshCw size={14}/>{reading ? t('entityLocale.checking') : t('entityLocale.previewFtl')}
        </button>
        <button type="button" disabled={disabled || !preview?.patch.changed || preview?.sourceSnapshot !== source}
          onClick={() => void save()}>
          <Languages size={14}/>{applying ? t('entityLocale.writing') : t('entityLocale.writeFtl')}
        </button>
      </div>
    </>}
  </section>;
}
