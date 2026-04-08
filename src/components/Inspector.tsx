import { useProjectStore } from '../store/projectStore';
import { useEffect, useState } from 'react';
import { AlertTriangle, Info, XCircle, Layers, Image as ImageIcon, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';

export default function Inspector() {
  const detail = useProjectStore((state) => state.selectedPrototype);
  const proto = detail?.prototype ?? null;
  const resolvedProto = detail?.resolved;
  const protoIssues = detail?.issues ?? [];
  const spriteComponent = resolvedProto?.components?.find?.((component: any) => component?.type === 'Sprite');
  const rsi = detail?.rsi;
  const [zoom, setZoom] = useState(4);

  useEffect(() => {
    setZoom(4);
  }, [proto?._key, rsi?.previewState, rsi?.path]);

  if (!proto) {
    return (
      <div className="w-80 border-l border-neutral-800 bg-neutral-900/50 flex flex-col shrink-0">
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">No prototype selected</div>
      </div>
    );
  }

  return (
    <div className="w-80 border-l border-neutral-800 bg-neutral-900/50 flex flex-col shrink-0 overflow-y-auto custom-scrollbar">
      <div className="p-4 border-b border-neutral-800">
        <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3">Validation</h3>
        {protoIssues.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-500">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            No issues found
          </div>
        ) : (
          <div className="space-y-2">
            {protoIssues.map((issue, index) => (
              <div key={index} className={`flex gap-2 text-sm p-2 rounded-md ${
                issue.level === 'error' ? 'bg-red-500/10 text-red-400' :
                issue.level === 'warning' ? 'bg-yellow-500/10 text-yellow-400' :
                'bg-blue-500/10 text-blue-400'
              }`}>
                {issue.level === 'error' && <XCircle size={16} className="shrink-0 mt-0.5" />}
                {issue.level === 'warning' && <AlertTriangle size={16} className="shrink-0 mt-0.5" />}
                {issue.level === 'info' && <Info size={16} className="shrink-0 mt-0.5" />}
                <div><span className="font-medium">{issue.field}: </span>{issue.message}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="p-4 border-b border-neutral-800">
        <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3 flex items-center gap-2">
          <ImageIcon size={14} />
          Sprite Preview
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
                      <span>No PNG for state {rsi.previewState ?? spriteComponent.state ?? 'unknown'}</span>
                    </div>
                  )
                ) : (
                  <div className="text-red-400">RSI not found</div>
                )}
              </div>
            </div>
            {rsi?.previewDataUrl && (
              <div className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-400">
                <button className="hover:text-neutral-100" onClick={() => setZoom((value) => clampZoom(value - 0.5))} title="Zoom out">
                  <ZoomOut size={15} />
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button className="hover:text-neutral-100" onClick={() => setZoom(4)} title="Reset zoom">
                  <RotateCcw size={14} />
                </button>
                <button className="hover:text-neutral-100" onClick={() => setZoom((value) => clampZoom(value + 0.5))} title="Zoom in">
                  <ZoomIn size={15} />
                </button>
              </div>
            )}
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-500">Sprite</span>
                <span className="text-neutral-300 truncate ml-2" title={spriteComponent.sprite}>{spriteComponent.sprite}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">State</span>
                <span className="text-neutral-300">{rsi?.previewState ?? spriteComponent.state ?? '-'}</span>
              </div>
              {rsi && (
                <div className="flex justify-between">
                  <span className="text-neutral-500">RSI</span>
                  <span className="text-neutral-300 truncate ml-2" title={rsi.path}>{rsi.path} / {rsi.stateCount} states</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm text-neutral-500 italic">No Sprite component found.</div>
        )}
      </div>

      {spriteComponent?.layers && (
        <div className="p-4">
          <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Layers size={14} />
            Layers
          </h3>
          <div className="space-y-2">
            {spriteComponent.layers.map((layer: any, index: number) => (
              <div key={index} className="bg-neutral-950 border border-neutral-800 rounded-md p-2 text-xs">
                <div className="flex justify-between mb-1">
                  <span className="font-medium text-neutral-300">Layer {index}</span>
                  {layer.visible === false && <span className="text-neutral-500">Hidden</span>}
                </div>
                {layer.state && <div className="text-neutral-400">State: <span className="text-neutral-300">{layer.state}</span></div>}
                {layer.sprite && <div className="text-neutral-400 truncate">Sprite: <span className="text-neutral-300">{layer.sprite}</span></div>}
                {layer.shader && <div className="text-neutral-400">Shader: <span className="text-neutral-300">{layer.shader}</span></div>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="p-4 border-t border-neutral-800 mt-auto">
        <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3">Inheritance</h3>
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
            <span className="text-neutral-500 italic">No parent</span>
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
