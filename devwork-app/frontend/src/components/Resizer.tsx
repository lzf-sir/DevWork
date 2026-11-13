/**
 * 左右栏拖拽调宽。
 *
 * 约束来自设计 §9.18：左栏 180~260px，右栏 260~720px（原 420 上限因文件预览需要版面放宽）。
 * 具体 min/max 由调用方（Sidebar / WorkbenchPanel / AssetChatDock）传入。宽度写进 localStorage，
 * 用户下次打开还是自己的习惯；拖拽期间给 body 加 .resizing，避免误选中文本。
 *
 * 用 Pointer Events 而不是 mouse 事件：触摸板 / 触屏 / 笔输入走同一套逻辑。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

export type DragEdge = 'left' | 'right';

export interface PanelWidthOptions {
  storageKey: string;
  initial: number;
  min: number;
  max: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStored(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw === null ? NaN : Number(raw);
    if (Number.isFinite(parsed)) return clamp(parsed, min, max);
  } catch {
    /* 隐私模式下 localStorage 不可用，用默认宽度即可。 */
  }
  return clamp(fallback, min, max);
}

export function usePanelWidth(options: PanelWidthOptions): {
  width: number;
  dragging: boolean;
  beginDrag: (event: React.PointerEvent<HTMLDivElement>, edge: DragEdge) => void;
  reset: () => void;
} {
  const { storageKey, initial, min, max } = options;
  const [width, setWidthState] = useState<number>(() => readStored(storageKey, initial, min, max));
  const [dragging, setDragging] = useState<boolean>(false);
  const startRef = useRef<{ x: number; width: number; edge: DragEdge } | null>(null);

  const setWidth = useCallback(
    (next: number) => {
      const value = clamp(next, min, max);
      setWidthState(value);
      try {
        localStorage.setItem(storageKey, String(value));
      } catch {
        /* 存不进去不影响本次会话。 */
      }
    },
    [max, min, storageKey],
  );

  const beginDrag = useCallback((event: React.PointerEvent<HTMLDivElement>, edge: DragEdge) => {
    event.preventDefault();
    startRef.current = { x: event.clientX, width, edge };
    setDragging(true);
    document.body.classList.add('resizing');
  }, [width]);

  /* 拖拽期间的 move/up 挂在 window 上：指针移出 6px 手柄也不会中断。 */
  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (event: PointerEvent): void => {
      const start = startRef.current;
      if (!start) return;
      /* 左栏手柄在右边界（右移变宽）；右栏手柄在左边界（左移变宽）。 */
      const direction = start.edge === 'left' ? -1 : 1;
      setWidth(start.width + (event.clientX - start.x) * direction);
    };
    const onUp = (): void => {
      startRef.current = null;
      setDragging(false);
      document.body.classList.remove('resizing');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('resizing');
    };
  }, [dragging, setWidth]);

  const reset = useCallback(() => setWidth(initial), [initial, setWidth]);

  return { width, dragging, beginDrag, reset };
}

interface ResizerProps {
  edge: DragEdge;
  dragging: boolean;
  onBegin: (event: React.PointerEvent<HTMLDivElement>, edge: DragEdge) => void;
  onReset: () => void;
}

/** 6px 拖拽手柄；默认透明，hover / 拖拽时高亮，双击复位。 */
export function Resizer({ edge, dragging, onBegin, onReset }: ResizerProps): React.ReactElement {
  return (
    <div
      className={`resizer ${edge === 'right' ? 'side-r' : 'edge-l'}${dragging ? ' on' : ''}`}
      role="separator"
      aria-orientation="vertical"
      title="拖拽调整宽度，双击复位"
      onPointerDown={(event) => onBegin(event, edge)}
      onDoubleClick={(event) => {
        event.preventDefault();
        onReset();
      }}
    />
  );
}
