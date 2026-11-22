import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { X } from 'lucide-react';
import type { ResourceEntry } from '../lib/api';
import { insertionIndexForTabPointer } from '../lib/tabs';

interface Props {
  tabs: readonly ResourceEntry[];
  activePath: string | null;
  dirtyPaths: readonly string[];
  disabled: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (path: string, index: number) => void;
  renderIcon: (kind: ResourceEntry['kind']) => React.ReactNode;
  closeLabel: (path: string) => string;
  label: string;
}

interface PendingDrag {
  path: string;
  pointerId: number;
  startX: number;
  targetIndex: number;
  active: boolean;
}

const THRESHOLD_PX = 8;

/** Pointer-drag tab ordering from Electron, without HTML file-drop interception. */
export default function ResourceTabStrip({
  tabs, activePath, dirtyPaths, disabled, onSelect, onClose, onReorder,
  renderIcon, closeLabel, label,
}: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const tabNodes = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<PendingDrag | null>(null);
  const suppressClick = useRef<string | null>(null);
  const [dragView, setDragView] = useState<{ path: string; targetIndex: number } | null>(null);
  const dirty = new Set(dirtyPaths);

  function cancelDrag() {
    drag.current = null;
    setDragView(null);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  function pointerDown(event: ReactPointerEvent<HTMLButtonElement>, tab: ResourceEntry) {
    if (disabled || event.button !== 0) return;
    drag.current = {
      path: tab.path, pointerId: event.pointerId, startX: event.clientX,
      targetIndex: tabs.findIndex((item) => item.path === tab.path), active: false,
    };
  }

  useEffect(() => {
    function move(event: PointerEvent) {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      if (!state.active && Math.abs(event.clientX - state.startX) < THRESHOLD_PX) return;
      state.active = true;
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';

      const scroller = scroll.current;
      if (scroller) {
        const bounds = scroller.getBoundingClientRect();
        if (event.clientX < bounds.left + 40) scroller.scrollLeft -= 18;
        else if (event.clientX > bounds.right - 40) scroller.scrollLeft += 18;
      }
      const centers = tabs
        .filter((tab) => tab.path !== state.path)
        .map((tab) => {
          const rect = tabNodes.current.get(tab.path)?.getBoundingClientRect();
          return rect ? { path: tab.path, center: (rect.left + rect.right) / 2 } : null;
        })
        .filter((entry): entry is { path: string; center: number } => Boolean(entry));
      state.targetIndex = insertionIndexForTabPointer(event.clientX, centers);
      setDragView({ path: state.path, targetIndex: state.targetIndex });
    }

    function release(event: PointerEvent) {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      if (state.active) {
        suppressClick.current = state.path;
        if (!disabled) onReorder(state.path, state.targetIndex);
        window.setTimeout(() => {
          if (suppressClick.current === state.path) suppressClick.current = null;
        }, 0);
      }
      cancelDrag();
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [tabs, onReorder, disabled]);

  const draggedIndex = dragView ? tabs.findIndex((tab) => tab.path === dragView.path) : -1;
  return <div ref={scroll} className="tab-strip" role="tablist" aria-label={label}
    onWheel={(event) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.currentTarget.scrollLeft += event.deltaY;
      }
    }}>
    {tabs.map((tab, index) => {
      const isDragging = dragView?.path === tab.path;
      const isTarget = dragView && !isDragging && (
        draggedIndex < dragView.targetIndex
          ? index === dragView.targetIndex
          : index === dragView.targetIndex);
      return <div key={tab.path}
        ref={(node) => {
          if (node) tabNodes.current.set(tab.path, node);
          else tabNodes.current.delete(tab.path);
        }}
        className={'tab' + (activePath === tab.path ? ' active' : '')
          + (isDragging ? ' tab-dragging' : '') + (isTarget ? ' tab-drop-target' : '')}>
        <button type="button" role="tab" title={tab.path}
          aria-selected={activePath === tab.path}
          className="tab-focus" disabled={disabled}
          onPointerDown={(event) => pointerDown(event, tab)}
          onClick={() => {
            if (suppressClick.current === tab.path) {
              suppressClick.current = null;
              return;
            }
            onSelect(tab.path);
          }}>
          {renderIcon(tab.kind)}
          <span>{tab.path.split('/').at(-1)}{dirty.has(tab.path) ? ' ●' : ''}</span>
        </button>
        <button className="tab-close" type="button"
          aria-label={closeLabel(tab.path)} disabled={disabled}
          onClick={() => onClose(tab.path)}>
          <X size={13}/>
        </button>
      </div>;
    })}
  </div>;
}
