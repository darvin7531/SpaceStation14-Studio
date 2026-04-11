import { ReactNode, memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Languages, Layers, Image as ImageIcon, RotateCcw, ZoomIn, ZoomOut, Box, ChevronRight } from 'lucide-react';
import IssueCard from './IssueCard';
import { useI18n } from '../i18n';
import { useProjectStore } from '../store/projectStore';
import { useEditorSettings } from '../editorSettings';
import { useLocalizationSettings } from '../localizationSettings';
import { openLocaleByPath, openPrototypeByKey } from '../services/navigation';
import { PrototypeLocalizationAnalysis } from '../types';

export default function Inspector() {
  const { t } = useI18n();
  const { settings } = useEditorSettings();
  const { settings: localizationSettings } = useLocalizationSettings();
  const activeTabId = useProjectStore((state) => state.activeTabId);
  const tabsById = useProjectStore((state) => state.tabsById);
  const activeTab = useMemo(() => activeTabId ? tabsById[activeTabId] ?? null : null, [activeTabId, tabsById]);
  const detail = activeTab?.kind === 'prototype' ? activeTab.detail : null;
  const selectedRsi = activeTab?.kind === 'rsi' ? activeTab.detail : null;
  const selectedLocale = activeTab?.kind === 'locale' ? activeTab.detail : null;
  const rawYaml = activeTab?.kind === 'prototype' ? activeTab.rawYaml : '';
  const localizationSourceText = settings.liveValidation
    ? rawYaml
    : (detail?.prototype?._rawYaml ?? rawYaml);
  const proto = detail?.prototype ?? null;
  const resolvedProto = detail?.resolved;
  const protoIssues = detail?.issues ?? [];
  const linkedPrototypes = detail?.linkedPrototypes ?? [];
  const spriteComponent = resolvedProto?.components?.find?.((component: any) => component?.type === 'Sprite');
  const rsi = detail?.rsi;
  const [zoom, setZoom] = useState(4);
  const [localizationAnalysis, setLocalizationAnalysis] = useState<PrototypeLocalizationAnalysis | null>(null);
  const [sectionOpen, setSectionOpen] = useState({
    validation: true,
    linked: false,
    sprite: true,
    layers: false,
    inheritance: false,
  });

  const toggleValidation = useCallback(() => setSectionOpen((c) => ({ ...c, validation: !c.validation })), []);
  const toggleLinked = useCallback(() => setSectionOpen((c) => ({ ...c, linked: !c.linked })), []);
  const toggleSprite = useCallback(() => setSectionOpen((c) => ({ ...c, sprite: !c.sprite })), []);
  const toggleLayers = useCallback(() => setSectionOpen((c) => ({ ...c, layers: !c.layers })), []);
  const toggleInheritance = useCallback(() => setSectionOpen((c) => ({ ...c, inheritance: !c.inheritance })), []);

  useEffect(() => {
    setZoom(4);
  }, [proto?._key, rsi?.previewState, rsi?.path]);

  useEffect(() => {
    if (!activeTab || activeTab.kind !== 'prototype') {
      setLocalizationAnalysis(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      const next = await window.prototypeStudio.analyzePrototypeLocalization({
        key: activeTab.prototypeKey,
        text: localizationSourceText,
        requiredLocales: localizationSettings.requiredLocales,
      });
      if (!cancelled) setLocalizationAnalysis(next);
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [activeTab, localizationSettings.requiredLocales, localizationSourceText]);

  if (selectedRsi && !proto) {
    return (
      <aside className="w-80 border-l border-neutral-800 bg-neutral-900/50 flex flex-col shrink-0 overflow-y-auto custom-scrollbar">
        <div className="p-4 border-b border-neutral-800">
          <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3">{t('inspector.rsiValidation')}</h3>
          {selectedRsi.issues.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-green-500">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              {t('inspector.noRsiIssues')}
            </div>
          ) : (
            <div className="space-y-2">
              {selectedRsi.issues.map((issue, index) => (
                <div key={index}>
                  <IssueCard issue={issue} compact />
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    );
  }

  if (selectedLocale && !proto) {
    return (
      <aside className="w-80 border-l border-neutral-800 bg-neutral-900/50 flex flex-col shrink-0 overflow-y-auto custom-scrollbar">
        <div className="p-4 border-b border-neutral-800">
          <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Languages size={14} />
            {t('locale.inspector')}
          </h3>
          <div className="space-y-3 text-sm text-neutral-300">
            <KeyValue label={t('inspector.path')} value={selectedLocale.path} title={selectedLocale.path} />
            <KeyValue label={t('locale.locale')} value={selectedLocale.locale} />
            <KeyValue label={t('locale.entries')} value={String(selectedLocale.entryCount)} />
            <KeyValue label={t('locale.characters')} value={String(selectedLocale.text.length)} />
          </div>
        </div>
      </aside>
    );
  }

  if (!proto) {
    return (
      <aside className="w-80 border-l border-neutral-800 bg-neutral-900/50 flex flex-col shrink-0">
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">{t('inspector.noPrototypeSelected')}</div>
      </aside>
    );
  }

  const compactIssues = protoIssues.slice(0, 4);
  const locDiagnostics = localizationAnalysis?.diagnostics ?? [];
  const combinedIssueCount = compactIssues.length + locDiagnostics.length;

  return (
    <aside className="w-80 border-l border-neutral-800 bg-neutral-900/50 flex flex-col shrink-0 overflow-y-auto custom-scrollbar">
      <Section
        title={t('inspector.validation')}
        open={sectionOpen.validation}
        onToggle={toggleValidation}
      >
        {combinedIssueCount === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-500">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            {t('inspector.noIssues')}
          </div>
        ) : (
          <div className="space-y-2">
            {compactIssues.map((issue, index) => (
              <div key={index}>
                <IssueCard issue={issue} compact />
              </div>
            ))}
            {locDiagnostics.map((diagnostic) => (
              <div key={`${diagnostic.field}:${diagnostic.localizationId}`} className="rounded-md border border-neutral-800 bg-neutral-950 p-3">
                <div className="text-xs text-yellow-400">{t('inspector.localization')} / {t(`editor.field.${diagnostic.field}`)} / {diagnostic.missingLocales.join(', ')}</div>
                <div className="mt-1 text-sm text-neutral-300">{diagnostic.message}</div>
                <div className="mt-2 space-y-2">
                  {diagnostic.targets.map((target) => (
                    <div key={`${target.locale}:${target.path}`} className="rounded border border-neutral-800 bg-neutral-900 px-2 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs text-neutral-400">{target.locale}</div>
                          <div className="truncate text-[11px] text-neutral-500" title={target.path}>{target.path}</div>
                        </div>
                        <button
                          onClick={() => void openLocaleByPath(target.path)}
                          className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
                        >
                          {t('inspector.openLocale')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={t('inspector.linkedPrototypes')}
        icon={<Box size={14} />}
        open={sectionOpen.linked}
        onToggle={toggleLinked}
      >
        {linkedPrototypes.length === 0 ? (
          <div className="text-sm text-neutral-500 italic">{t('inspector.noLinkedPrototypes')}</div>
        ) : (
          <div className="space-y-2">
            {linkedPrototypes.slice(0, 24).map((link) => (
              <button
                key={`${link.key}:${link.field}`}
                onClick={() => void openPrototypeByKey(link.key)}
                className="flex w-full items-start justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-left hover:bg-neutral-900"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-neutral-200">{link.id}</div>
                  <div className="truncate text-[11px] text-neutral-500">{link.type} / {link.field}</div>
                </div>
                <ArrowUpRight size={14} className="shrink-0 text-neutral-500" />
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={t('inspector.spritePreview')}
        icon={<ImageIcon size={14} />}
        open={sectionOpen.sprite}
        onToggle={toggleSprite}
      >
        {spriteComponent ? (
          <div className="space-y-4">
            <div
              className="bg-neutral-950 border border-neutral-800 rounded-md p-4 flex items-center justify-center min-h-[160px] relative overflow-hidden checkerboard"
              onWheel={(event) => {
                if (!rsi?.previewDataUrl) return;
                event.preventDefault();
                setZoom((value) => clampZoom(value + (event.deltaY < 0 ? 0.5 : -0.5)));
              }}
            >
              <div className="w-full min-h-[120px] flex items-center justify-center text-center text-neutral-500 text-xs z-10">
                {rsi ? (
                  rsi.previewDataUrl ? (
                    <img
                      src={rsi.previewDataUrl}
                      alt={`${rsi.path}:${rsi.previewState ?? 'preview'}`}
                      className="max-h-32 max-w-full object-contain [image-rendering:pixelated]"
                      style={{ transform: `scale(${zoom})` }}
                      draggable={false}
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-2">
                      <ImageIcon size={32} className="opacity-50" />
                      <span>{t('inspector.noPngForState', { state: rsi.previewState ?? spriteComponent.state ?? 'unknown' })}</span>
                    </div>
                  )
                ) : (
                  <div className="text-red-400">{t('inspector.rsiNotFound')}</div>
                )}
              </div>
            </div>
            {rsi?.previewDataUrl && (
              <div className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-400">
                <button className="hover:text-neutral-100" onClick={() => setZoom((value) => clampZoom(value - 0.5))} title={t('inspector.zoomOut')}>
                  <ZoomOut size={15} />
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button className="hover:text-neutral-100" onClick={() => setZoom(4)} title={t('inspector.resetZoom')}>
                  <RotateCcw size={14} />
                </button>
                <button className="hover:text-neutral-100" onClick={() => setZoom((value) => clampZoom(value + 0.5))} title={t('inspector.zoomIn')}>
                  <ZoomIn size={15} />
                </button>
              </div>
            )}
            <div className="space-y-2 text-sm">
              <KeyValue label={t('inspector.sprite')} value={String(spriteComponent.sprite ?? '-')} title={String(spriteComponent.sprite ?? '-')} />
              <KeyValue label={t('inspector.state')} value={String(rsi?.previewState ?? spriteComponent.state ?? '-')} />
              {rsi && (
                <KeyValue label={t('inspector.rsi')} value={`${rsi.path} / ${rsi.stateCount} states`} title={rsi.path} />
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm text-neutral-500 italic">{t('inspector.noSpriteComponent')}</div>
        )}
      </Section>

      {spriteComponent?.layers && (
        <Section
          title={t('inspector.layers')}
          icon={<Layers size={14} />}
          open={sectionOpen.layers}
          onToggle={toggleLayers}
        >
          <div className="space-y-2">
            {spriteComponent.layers.map((layer: any, index: number) => (
              <div key={index} className="bg-neutral-950 border border-neutral-800 rounded-md p-2 text-xs">
                <div className="flex justify-between mb-1">
                  <span className="font-medium text-neutral-300">{t('inspector.layer', { index })}</span>
                  {layer.visible === false && <span className="text-neutral-500">{t('inspector.hidden')}</span>}
                </div>
                {layer.state && <div className="text-neutral-400">{t('inspector.state')}: <span className="text-neutral-300">{layer.state}</span></div>}
                {layer.sprite && <div className="text-neutral-400 truncate">{t('inspector.sprite')}: <span className="text-neutral-300">{layer.sprite}</span></div>}
                {layer.shader && <div className="text-neutral-400">{t('inspector.shader')}: <span className="text-neutral-300">{layer.shader}</span></div>}
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section
        title={t('inspector.inheritance')}
        open={sectionOpen.inheritance}
        onToggle={toggleInheritance}
      >
        <div className="text-sm text-neutral-300">
          {proto.parent ? (
            <div className="flex flex-col gap-1">
              <span className="text-blue-400">{text(proto.id)}</span>
              {(Array.isArray(proto.parent) ? proto.parent : [proto.parent]).map((parent, index) => (
                <div key={index} className="flex items-center gap-2 text-neutral-400 ml-4">
                  <span className="text-neutral-600">в†і</span>
                  <span>{text(parent)}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-neutral-500 italic">{t('inspector.noParent')}</span>
          )}
        </div>
      </Section>
    </aside>
  );
}

const Section = memo(function Section({
  title,
  icon,
  children,
  open = true,
  onToggle,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <section className="p-4 border-b border-neutral-800">
      <button
        onClick={onToggle}
        className="mb-3 flex w-full items-center gap-2 text-left text-xs font-semibold uppercase tracking-wider text-neutral-400 hover:text-neutral-200"
      >
        <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        {icon}
        <span>{title}</span>
      </button>
      {open && children}
    </section>
  );
});

const KeyValue = memo(function KeyValue({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-neutral-500">{label}</span>
      <span className="truncate text-right text-neutral-300" title={title ?? value}>{value}</span>
    </div>
  );
});

function text(value: unknown) {
  return value == null ? '' : String(value);
}

function clampZoom(value: number) {
  return Math.min(16, Math.max(0.5, value));
}
