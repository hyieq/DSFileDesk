import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  X,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Maximize,
  LoaderCircle,
  ImageOff,
} from "lucide-react";
import type { Entry } from "./model";
import { getMedia, type MediaResult } from "./media";
export default function ImageViewer({
  id,
  files,
  initialPath,
  onClose,
}: {
  id: string;
  files: Entry[];
  initialPath: string;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(
    Math.max(
      0,
      files.findIndex((e) => e.path === initialPath),
    ),
  );
  const [media, setMedia] = useState<MediaResult | null>(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dimensions, setDimensions] = useState("");
  const [retry, setRetry] = useState(0);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(
    null,
  );
  const root = useRef<HTMLDivElement>(null);
  const entry = files[index];
  const reset = () => {
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
  };
  const change = (delta: number) =>
    setIndex((i) => Math.max(0, Math.min(files.length - 1, i + delta)));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    let disposed = false;
    setMedia(null);
    setError("");
    setDimensions("");
    reset();
    getMedia(id, entry, true)
      .then((result) => {
        if (!disposed) setMedia(result);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [id, entry.path, retry]);
  function keydown(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      change(1);
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      change(-1);
    }
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      setZoom((z) => Math.min(5, z + 0.25));
    }
    if (e.key === "-") {
      e.preventDefault();
      setZoom((z) => Math.max(0.25, z - 0.25));
    }
    if (e.key === "0") {
      e.preventDefault();
      reset();
    }
    if (e.key === "Tab") {
      const controls = Array.from(
        root.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) || [],
      );
      const first = controls[0],
        last = controls[controls.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === root.current)
      ) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }
  return (
    <div
      ref={root}
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="图片浏览器"
      tabIndex={-1}
      onKeyDown={keydown}
    >
      <div className="viewer-header">
        <div>
          <strong>{entry.name}</strong>
          <span>
            {index + 1} / {files.length} 张图片
            {dimensions && ` · ${dimensions}`}
          </span>
        </div>
        <div className="viewer-tools">
          <button
            title="缩小 (-)"
            disabled={!media || zoom <= 0.25}
            onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
          >
            <ZoomOut size={18} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            title="放大 (+)"
            disabled={!media || zoom >= 5}
            onClick={() => setZoom((z) => Math.min(5, z + 0.25))}
          >
            <ZoomIn size={18} />
          </button>
          <i />
          <button title="适应窗口 (0)" disabled={!media} onClick={reset}>
            <Maximize size={18} />
          </button>
          <button
            title="向右旋转"
            disabled={!media}
            onClick={() => {
              setRotation((r) => r + 90);
              setPan({ x: 0, y: 0 });
            }}
          >
            <RotateCw size={18} />
          </button>
          <i />
          <button
            title="关闭预览 (Esc)"
            className="viewer-close"
            onClick={onClose}
          >
            <X size={21} />
          </button>
        </div>
      </div>
      <div
        className={`viewer-stage ${zoom > 1 ? "zoomed" : ""}`}
        onWheel={(e) =>
          setZoom((z) =>
            Math.max(0.25, Math.min(5, z + (e.deltaY < 0 ? 0.15 : -0.15))),
          )
        }
        onDoubleClick={() => {
          setZoom((z) => (z === 1 ? 2 : 1));
          setPan({ x: 0, y: 0 });
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !media) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        }}
        onPointerMove={(e) => {
          if (drag.current)
            setPan({
              x: drag.current.px + e.clientX - drag.current.x,
              y: drag.current.py + e.clientY - drag.current.y,
            });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {media ? (
          <img
            key={entry.path}
            src={media.dataUrl}
            alt={entry.name}
            draggable={false}
            style={{
              transform: `translate(${pan.x}px,${pan.y}px) rotate(${rotation}deg) scale(${zoom})`,
              maxWidth: rotation % 180 ? "calc(100vh - 180px)" : "100%",
              maxHeight: rotation % 180 ? "calc(100vw - 160px)" : "100%",
            }}
            onLoad={(e) =>
              setDimensions(
                `${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`,
              )
            }
            onError={() => {
              setMedia(null);
              setError(
                "浏览器不支持此图片编码，请下载后使用本地图片应用打开。",
              );
            }}
          />
        ) : error ? (
          <div className="viewer-empty">
            <ImageOff size={38} />
            <h3>暂时无法预览</h3>
            <p>{error}</p>
            <button onClick={() => setRetry((r) => r + 1)}>重新加载</button>
          </div>
        ) : (
          <div className="viewer-empty">
            <LoaderCircle className="spin" size={30} />
            <p>正在读取图片…</p>
          </div>
        )}
      </div>
      <button
        className="viewer-previous"
        title="上一张 (←)"
        disabled={index === 0}
        onClick={() => change(-1)}
      >
        <ChevronLeft size={25} />
      </button>
      <button
        className="viewer-next"
        title="下一张 (→)"
        disabled={index === files.length - 1}
        onClick={() => change(1)}
      >
        <ChevronRight size={25} />
      </button>
      <div className="viewer-footer">
        <span>
          {media && !media.original
            ? "兼容预览 · NAS 生成的缩略图"
            : "原图预览"}
        </span>
        <span>← → 切换图片 · 滚轮缩放 · 拖动平移 · Esc 关闭</span>
      </div>
    </div>
  );
}
