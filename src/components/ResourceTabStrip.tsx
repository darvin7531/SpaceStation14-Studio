import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { ResourceEntry } from '../lib/api';
import { insertionIndexForTabPointer, tabId, type EditorTab } from '../lib/tabs';

interface Props {
  tabs: readonly EditorTab[];
  activePath: string | null;
  dirtyPaths: readonly string[];
  disabled: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (path: string, index: number) => void;
  renderIcon: (kind: ResourceEntry['kind']) => ReactNode;
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
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const [dragView, setDragView] = useState<{ path: string; targetIndex: number } | null>(null);
  const dirty = new Set(dirtyPaths);

  function cancelDrag() {
    drag.current = null;
    setDragView(null);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  function pointerDown(event: ReactPointerEvent<HTMLButtonElement>, tab: EditorTab) {
    if (disabled || event.button !== 0) return;
    drag.current = {
      path: tabId(tab), pointerId: event.pointerId, startX: event.clientX,
      targetIndex: tabs.findIndex((item) => tabId(item) === tabId(tab)), active: false,
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
        .filter((tab) => tabId(tab) !== state.path)
        .map((tab) => {
          const rect = tabNodes.current.get(tabId(tab))?.getBoundingClientRect();
          return rect ? { path: tabId(tab), center: (rect.left + rect.right) / 2 } : null;
        })
        .filter((entry): entry is { path: string; center: number } => Boolean(entry));
      if (centers.length > 0) {
        state.targetIndex = insertionIndexForTabPointer(event.clientX, centers);
      }
      setDragView({ path: state.path, targetIndex: state.targetIndex });
    }

    function release(event: PointerEvent) {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      if (state.active) {
        suppressClick.current = state.path;
        if (!disabled) onReorderRef.current(state.path, state.targetIndex);
        window.setTimeout(() => {
          if (suppressClick.current === state.path) suppressClick.current = null;
        }, 0);
      }
      cancelDrag();
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', cancelDrag);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', cancelDrag);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [tabs, disabled]);

  const draggedIndex = dragView ? tabs.findIndex((tab) => tabId(tab) === dragView.path) : -1;
  return <div ref={scroll} className="tab-strip" role="tablist" aria-label={label}
    onWheel={(event) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.currentTarget.scrollLeft += event.deltaY;
      }
    }}>
    {tabs.map((tab, index) => {
      const isDragging = dragView?.path === tabId(tab);
      const isTarget = Boolean(dragView && !isDragging && index === dragView.targetIndex);
      const targetPosition = isTarget
        ? (draggedIndex < dragView!.targetIndex ? ' tab-drop-after' : ' tab-drop-before')
        : '';
      return <div key={tabId(tab)}
        ref={(node) => {
          if (node) tabNodes.current.set(tabId(tab), node);
          else tabNodes.current.delete(tabId(tab));
        }}
        className={'tab' + (activePath === tabId(tab) ? ' active' : '')
          + (isDragging ? ' tab-dragging' : '') + targetPosition}>
        <button type="button" role="tab" title={tab.path}
          aria-selected={activePath === tabId(tab)}
          className="tab-focus" disabled={disabled}
          onPointerDown={(event) => pointerDown(event, tab)}
          onClick={() => {
            if (suppressClick.current === tabId(tab)) {
              suppressClick.current = null;
              return;
            }
            onSelect(tabId(tab));
          }}>
          {renderIcon(tab.kind)}
          <span>{tab.prototype ? tab.prototype.kind + ':' + tab.prototype.id : tab.path.split('/').at(-1)}{dirty.has(tab.path) ? ' ●' : ''}</span>
        </button>
        <button className="tab-close" type="button"
          aria-label={closeLabel(tab.path)} disabled={disabled}
          onClick={() => onClose(tabId(tab))}>
          <X size={13}/>
        </button>
      </div>;
    })}
  </div>;
}
