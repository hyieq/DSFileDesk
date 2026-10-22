import { useEffect, useRef, useState, type ReactNode } from "react";
import { Play, ImageOff } from "lucide-react";
import type { Entry } from "./model";
import { getMedia, mediaKind } from "./media";
export default function MediaThumbnail({
  id,
  entry,
  large,
  fallback,
}: {
  id: string;
  entry: Entry;
  large: boolean;
  fallback: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const kind = mediaKind(entry);
  useEffect(() => {
    if (!kind || !ref.current) return;
    const observer = new IntersectionObserver(
      (items) => {
        if (items.some((item) => item.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [kind]);
  useEffect(() => {
    let disposed = false;
    setSource("");
    setError("");
    if (visible && kind)
      getMedia(id, entry)
        .then((result) => {
          if (!disposed) setSource(result.dataUrl);
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [
    visible,
    kind,
    id,
    entry.path,
    entry.additional?.time?.mtime,
    entry.additional?.size,
  ]);
  if (!kind) return fallback;
  return (
    <span
      ref={ref}
      className={`media-thumbnail ${large ? "large" : ""} ${!source && !error ? "loading" : ""}`}
      title={
        error
          ? (kind === "video" ? "NAS 暂无视频封面，请检查媒体索引。" : "") +
            error
          : kind === "video"
            ? "视频缩略图"
            : "图片缩略图"
      }
    >
      {source ? (
        <img
          src={source}
          alt=""
          draggable={false}
          onError={() => {
            setSource("");
            setError("无法解码此缩略图");
          }}
        />
      ) : error ? (
        <>
          <ImageOff size={large ? 26 : 18} />
          {large && <small>暂无缩略图</small>}
        </>
      ) : (
        fallback
      )}
      {kind === "video" && (
        <span className="video-badge">
          <Play size={large ? 13 : 8} fill="currentColor" />
          {large && "视频"}
        </span>
      )}
    </span>
  );
}
