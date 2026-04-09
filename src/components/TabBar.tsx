import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { X } from 'lucide-react';
import { EditorResourceTab } from '../types';

interface TabBarProps {
  tabs: EditorResourceTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (tabId: string, targetIndex: number) => void;
  emptyText: string;
}

interface DragState {
  tabId: string;
  pointerId: number;
  startX: number;
  currentX: number;
  startIndex: number;
  active: boolean;
}

const DRAG_THRESHOLD = 8;

const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onReorder,
  emptyText,
}: TabBarProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const suppressedClickTabIdRef = useRef<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const draggedIndex = drag ? tabs.findIndex((tab) => tab.id === drag.tabId) : -1;
  const targetIndex = useMemo(() => {
    if (!drag || !drag.active) return -1;
    const draggedElement = tabRefs.current[drag.tabId];
    if (!draggedElement) return drag.startIndex;
    const draggedWidth = draggedElement.offsetWidth;
    const draggedCenter = draggedElement.offsetLeft + draggedWidth / 2 + (drag.currentX - drag.startX);
    let nextIndex = drag.startIndex;
    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index];
      if (tab.id === drag.tabId) continue;
      const element = tabRefs.current[tab.id];
      if (!element) continue;
      const center = element.offsetLeft + element.offsetWidth / 2;
      if (draggedCenter > center) nextIndex = index;
      if (draggedCenter < center && index < drag.startIndex) {
        nextIndex = index;
        break;
      }
    }
    return nextIndex;
  }, [drag, tabs]);

  useEffect(() => {
    if (!drag) return;

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      const nextX = event.clientX;
      setDrag((current) => {
        if (!current || current.pointerId !== event.pointerId) return current;
        const delta = Math.abs(nextX - current.startX);
        return {
          ...current,
          currentX: nextX,
          active: current.active || delta >= DRAG_THRESHOLD,
        };
      });

      const scroller = scrollRef.current;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const edge = 48;
        if (nextX < rect.left + edge) {
          scroller.scrollLeft -= 18;
        } else if (nextX > rect.right - edge) {
          scroller.scrollLeft += 18;
        }
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      const shouldReorder = drag.active && targetIndex >= 0 && targetIndex !== drag.startIndex;
      if (shouldReorder) onReorder(drag.tabId, targetIndex);
      if (drag.active) {
        suppressedClickTabIdRef.current = drag.tabId;
        window.setTimeout(() => {
          if (suppressedClickTabIdRef.current === drag.tabId) {
            suppressedClickTabIdRef.current = null;
          }
        }, 0);
      }
      setDrag(null);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [drag, onReorder, targetIndex]);

  useEffect(() => {
    if (!drag?.active) return;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [drag?.active]);

  return (
    <div
      ref={scrollRef}
      className="flex h-full items-end gap-1 overflow-x-auto px-1 custom-scrollbar"
      onWheel={(event) => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          event.currentTarget.scrollLeft += event.deltaY;
        }
      }}
    >
      {tabs.length === 0 ? (
        <div className="flex h-full items-center px-2 text-xs text-neutral-600">{emptyText}</div>
      ) : tabs.map((tab, index) => {
        const isDragged = drag?.tabId === tab.id && drag.active;
        const shouldShift = drag?.active && targetIndex >= 0 && draggedIndex >= 0 && drag.tabId !== tab.id
          ? draggedIndex < targetIndex
            ? index > draggedIndex && index <= targetIndex
            : index >= targetIndex && index < draggedIndex
          : false;

        const transform = isDragged
          ? `translateX(${drag.currentX - drag.startX}px)`
          : shouldShift
            ? `translateX(${draggedIndex < targetIndex ? '-100%' : '100%'})`
            : undefined;

        return (
          <TabItem
            key={tab.id}
            tab={tab}
            active={activeTabId === tab.id}
            dragged={isDragged}
            transform={transform}
            setRef={(node) => { tabRefs.current[tab.id] = node; }}
            onActivate={() => {
              if (suppressedClickTabIdRef.current === tab.id) {
                suppressedClickTabIdRef.current = null;
                return;
              }
              onActivate(tab.id);
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              setDrag({
                tabId: tab.id,
                pointerId: event.pointerId,
                startX: event.clientX,
                currentX: event.clientX,
                startIndex: index,
                active: false,
              });
            }}
            onClose={() => onClose(tab.id)}
          />
        );
      })}
    </div>
  );
});

const TabItem = memo(function TabItem({
  tab,
  active,
  dragged,
  transform,
  setRef,
  onActivate,
  onPointerDown,
  onClose,
}: {
  tab: EditorResourceTab;
  active: boolean;
  dragged: boolean;
  transform?: string;
  setRef: (node: HTMLButtonElement | null) => void;
  onActivate: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onClose: () => void;
}) {
  return (
    <button
      ref={setRef}
      onClick={onActivate}
      onPointerDown={onPointerDown}
      title={tab.subtitle || tab.title}
      className={`group mt-1 flex h-9 min-w-0 max-w-[280px] items-center gap-2 rounded-t-lg border border-b-0 px-3 text-left transition-[background-color,color,transform] duration-150 ${
        active
          ? 'border-neutral-700 bg-neutral-900 text-neutral-100'
          : 'border-transparent bg-neutral-950 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
      } ${dragged ? 'z-20 shadow-lg' : ''}`}
      style={{ transform }}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${tab.kind === 'prototype' ? 'bg-blue-400/80' : 'bg-emerald-400/80'}`} />
      <span className="min-w-0 flex-1 truncate text-sm">{tab.title}</span>
      {tab.dirty && <span className="shrink-0 text-[10px] text-amber-400">*</span>}
      <span
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="shrink-0 rounded p-0.5 text-neutral-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-neutral-800 hover:text-neutral-200"
      >
        <X size={12} />
      </span>
    </button>
  );
});

export default TabBar;
