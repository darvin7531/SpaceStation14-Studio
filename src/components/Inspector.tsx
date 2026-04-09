import { useProjectStore } from '../store/projectStore';
import { useEffect, useMemo, useState } from 'react';
import { Layers, Image as ImageIcon, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import IssueCard from './IssueCard';
import { useI18n } from '../i18n';

export default function Inspector() {
  const { t } = useI18n();
  const activeTabId = useProjectStore((state) => state.activeTabId);
  const tabsById = useProjectStore((state) => state.tabsById);
  const activeTab = useMemo(() => activeTabId ? tabsById[activeTabId] ?? null : null, [activeTabId, tabsById]);
  const detail = activeTab?.kind === 'prototype' ? activeTab.detail : null;
  const selectedRsi = activeTab?.kind === 'rsi' ? activeTab.detail : null;
  const proto = detail?.prototype ?? null;
  const resolvedProto = detail?.resolved;
  const protoIssues = detail?.issues ?? [];
  const spriteComponent = resolvedProto?.components?.find?.((component: any) => component?.type === 'Sprite');
  const rsi = detail?.rsi;
  const [zoom, setZoom] = useState(4);

  useEffect(() => {
    setZoom(4);
  }, [proto?._key, rsi?.previewState, rsi?.path]);

  if (selectedRsi && !proto) {
    return (
      <div className="w-80 border-l border-neutral-800 bg-neutral-900/50 flex flex-col shrink-0 overflow-y-auto custom-scrollbar">
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
        <div className="p-4 space-y-3 text-sm text-neutral-300">
          <div className="flex justify-between gap-3">
            <span className="text-neutral-500">{t('inspector.path')}</span>
            <span className="truncate text-right" title={selectedRsi.path}>{selectedRsi.path}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-neutral-500">{t('inspector.size')}</span>
            <span>{selectedRsi.meta.size.x} x {selectedRsi.meta.size.y}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-neutral-500">{t('inspector.states')}</span>
            <span>{selectedRsi.states.length}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-neutral-500">{t('common.license')}</span>
            <span className="truncate text-right">{selectedRsi.meta.license}</span>
          </div>
        </div>
      </div>
    );
  }

  if (!proto) {
    return (
      <div className="w-80 border-l border-neutral-800 bg-neutral-900/50 flex flex-col shrink-0">
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">{t('inspector.noPrototypeSelected')}</div>
      </div>
    );
  }

  return (
    <div className="w-80 border-l border-neutral-800 bg-neutral-900/50 flex flex-col shrink-0 overflow-y-auto custom-scrollbar">
      <div className="p-4 border-b border-neutral-800">
        <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3">{t('inspector.validation')}</h3>
        {protoIssues.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-500">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            {t('inspector.noIssues')}
          </div>
        ) : (
          <div className="space-y-2">
            {protoIssues.map((issue, index) => (
              <div key={index}>
                <IssueCard issue={issue} compact />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="p-4 border-b border-neutral-800">
        <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3 flex items-center gap-2">
          <ImageIcon size={14} />
          {t('inspector.spritePreview')}
        </h3>
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
              <div className="flex justify-between">
                <span className="text-neutral-500">{t('inspector.sprite')}</span>
                <span className="text-neutral-300 truncate ml-2" title={spriteComponent.sprite}>{spriteComponent.sprite}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">{t('inspector.state')}</span>
                <span className="text-neutral-300">{rsi?.previewState ?? spriteComponent.state ?? '-'}</span>
              </div>
              {rsi && (
                <div className="flex justify-between">
                  <span className="text-neutral-500">{t('inspector.rsi')}</span>
                  <span className="text-neutral-300 truncate ml-2" title={rsi.path}>{rsi.path} / {rsi.stateCount} states</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm text-neutral-500 italic">{t('inspector.noSpriteComponent')}</div>
        )}
      </div>

      {spriteComponent?.layers && (
        <div className="p-4">
          <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Layers size={14} />
            {t('inspector.layers')}
          </h3>
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
        </div>
      )}

      <div className="p-4 border-t border-neutral-800 mt-auto">
        <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3">{t('inspector.inheritance')}</h3>
        <div className="text-sm text-neutral-300">
          {proto.parent ? (
            <div className="flex flex-col gap-1">
              <span className="text-blue-400">{text(proto.id)}</span>
              {(Array.isArray(proto.parent) ? proto.parent : [proto.parent]).map((parent, index) => (
                <div key={index} className="flex items-center gap-2 text-neutral-400 ml-4">
                  <span className="text-neutral-600">↳</span>
                  <span>{text(parent)}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-neutral-500 italic">{t('inspector.noParent')}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function text(value: unknown) {
  return value == null ? '' : String(value);
}

function clampZoom(value: number) {
  return Math.min(16, Math.max(0.5, value));
}
