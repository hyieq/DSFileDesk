import { useEffect, useRef, useState, type PointerEvent } from "react";

export function intersects(
  a: DOMRect | { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

export default function useMarquee(
  selected: string[],
  onSelect: (paths: string[]) => void,
  resetKey: string,
) {
  const ref = useRef<HTMLElement>(null);
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const cleanup = useRef(() => {});
  useEffect(() => () => cleanup.current(), [resetKey]);
  function onPointerDown(e: PointerEvent<HTMLElement>) {
    if (
      e.button !== 0 ||
      (e.target as HTMLElement).closest(
        ".file-entry,button,input,select,.list-heading",
      )
    )
      return;
    const pane = ref.current!;
    const bounds = pane.getBoundingClientRect();
    if (e.clientX - bounds.left >= pane.clientWidth) return;
    cleanup.current();
    pane.focus({ preventScroll: true });
    const start = {
      x: e.clientX - bounds.left + pane.scrollLeft,
      y: e.clientY - bounds.top + pane.scrollTop,
    };
    const base = e.ctrlKey || e.metaKey || e.shiftKey ? [...selected] : [];
    let x = e.clientX,
      y = e.clientY,
      moved = false,
      frame = 0;
    let finished = false;
    pane.setPointerCapture(e.pointerId);
    const draw = () => {
      const r = pane.getBoundingClientRect();
      if (moved)
        pane.scrollTop += y < r.top + 35 ? -12 : y > r.bottom - 35 ? 12 : 0;
      const end = {
        x: Math.max(0, Math.min(r.width, x - r.left)) + pane.scrollLeft,
        y: Math.max(0, Math.min(r.height, y - r.top)) + pane.scrollTop,
      };
      if (Math.hypot(end.x - start.x, end.y - start.y) > 4) moved = true;
      if (moved) {
        const b = {
          left: Math.min(start.x, end.x),
          top: Math.min(start.y, end.y),
          right: Math.max(start.x, end.x),
          bottom: Math.max(start.y, end.y),
        };
        setBox({
          left: b.left,
          top: b.top,
          width: b.right - b.left,
          height: b.bottom - b.top,
        });
        const hits = Array.from(
          pane.querySelectorAll<HTMLElement>("[data-file-path]"),
        )
          .filter((el) => {
            const q = el.getBoundingClientRect();
            return intersects(
              {
                left: q.left - r.left + pane.scrollLeft,
                right: q.right - r.left + pane.scrollLeft,
                top: q.top - r.top + pane.scrollTop,
                bottom: q.bottom - r.top + pane.scrollTop,
              },
              b,
            );
          })
          .map((el) => el.dataset.filePath!);
        onSelect([...new Set([...base, ...hits])]);
      }
      frame = requestAnimationFrame(draw);
    };
    const move = (event: globalThis.PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup.current = () => {};
      cancelAnimationFrame(frame);
      pane.removeEventListener("pointermove", move);
      pane.removeEventListener("pointerup", finish);
      pane.removeEventListener("pointercancel", finish);
      pane.removeEventListener("lostpointercapture", finish);
      window.removeEventListener("blur", finish);
      if (pane.hasPointerCapture(e.pointerId))
        pane.releasePointerCapture(e.pointerId);
      setBox(null);
      if (moved) {
        suppressClick.current = true;
        setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      } else onSelect(base);
    };
    cleanup.current = finish;
    pane.addEventListener("pointermove", move);
    pane.addEventListener("pointerup", finish);
    pane.addEventListener("pointercancel", finish);
    pane.addEventListener("lostpointercapture", finish);
    window.addEventListener("blur", finish);
    frame = requestAnimationFrame(draw);
    e.preventDefault();
  }
  return { ref, box, onPointerDown, suppressClick };
}
