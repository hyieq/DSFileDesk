import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Pause, Play, Volume2, X, Film, Maximize } from "lucide-react";
import type { Entry } from "./model";

type Status = {
  time: number;
  duration: number;
  playing: boolean;
  state: number;
  seekable: boolean;
};
const empty: Status = {
  time: 0,
  duration: 0,
  playing: false,
  state: 0,
  seekable: false,
};
function time(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ":" : ""}${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
export default function VideoViewer({
  id,
  entry,
  onClose,
}: {
  id: string;
  entry: Entry;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLDivElement>(null);
  const owner = useRef(crypto.randomUUID());
  const [status, setStatus] = useState(empty),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [volume, setVolume] = useState(80);
  const live = useRef(status);
  live.current = status;
  const unavailable = !isTauri();
  const bounds = () => {
    const r = stage.current!.getBoundingClientRect(),
      d = window.devicePixelRatio;
    return {
      x: Math.round(r.x * d),
      y: Math.round(r.y * d),
      width: Math.round(r.width * d),
      height: Math.round(r.height * d),
    };
  };
  const command = async (action: string, value?: number) => {
    try {
      return await invoke<Status | null>("video_command", {
        owner: owner.current,
        action,
        value,
      });
    } catch (e) {
      setError(String(e));
      return null;
    }
  };
  useEffect(() => {
    const focused = document.activeElement as HTMLElement;
    dialog.current?.focus();
    if (unavailable) return () => focused?.focus();
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const sessionOwner = crypto.randomUUID();
    owner.current = sessionOwner;
    const poll = async () => {
      try {
        const s = await invoke<Status | null>("video_command", {
          owner: sessionOwner,
          action: "status",
        });
        if (!disposed && s) {
          setStatus(s);
          if (s.state === 7)
            setError(
              "视频读取或解码失败，请检查 NAS 连接、文件权限及视频是否损坏。",
            );
        }
      } catch (e) {
        if (!disposed) setError(String(e));
      }
      if (!disposed) timer = setTimeout(poll, 400);
    };
    const resize = () => {
      if (!disposed)
        void invoke("video_command", {
          owner: sessionOwner,
          action: "bounds",
          bounds: bounds(),
        }).catch((e) => setError(String(e)));
    };
    const observer = new ResizeObserver(resize);
    void invoke("video_open", {
      id,
      path: entry.path,
      bounds: bounds(),
      owner: sessionOwner,
    })
      .then(async () => {
        if (disposed) {
          await invoke("video_command", {
            owner: sessionOwner,
            action: "close",
          });
          return;
        }
        setReady(true);
        await command("volume", 80);
        observer.observe(stage.current!);
        window.addEventListener("resize", resize);
        resize();
        void poll();
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      if (document.fullscreenElement) void document.exitFullscreen();
      clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      void invoke("video_command", {
        owner: sessionOwner,
        action: "close",
      }).catch(() => {});
      focused?.focus();
    };
  }, [id, entry.path, unavailable]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if ((e.target as HTMLElement).matches("input")) return;
      if (e.key === " ") {
        e.preventDefault();
        if (ready) void command("pause", live.current.playing ? 1 : 0);
      }
      if (["ArrowLeft", "ArrowRight"].includes(e.key) && ready) {
        e.preventDefault();
        void command(
          "seek",
          Math.max(
            0,
            live.current.time + (e.key === "ArrowRight" ? 10000 : -10000),
          ),
        );
      }
      if (e.key === "Tab") {
        const nodes = Array.from(
          dialog.current!.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled)",
          ),
        );
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialog.current)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [ready, onClose]);
  return (
    <div
      className="video-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="视频播放器"
      ref={dialog}
      tabIndex={-1}
    >
      <div className="video-header">
        <Film size={20} />
        <strong>{entry.name}</strong>
        <small>LibVLC</small>
        <button title="关闭播放器 Esc" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div className="video-stage" ref={stage}>
        {unavailable ? (
          <div>
            <Film size={52} />
            <p>请在桌面客户端登录 NAS 后播放视频。</p>
          </div>
        ) : !ready ? (
          <p>{error || "正在连接视频…"}</p>
        ) : null}
      </div>
      {error && ready && (
        <div className="video-error" role="alert">
          {error}
        </div>
      )}
      <div className="video-controls">
        <button
          title={status.playing ? "暂停（空格）" : "播放（空格）"}
          disabled={!ready}
          onClick={() => void command("pause", status.playing ? 1 : 0)}
        >
          {status.playing ? <Pause /> : <Play />}
        </button>
        <span>{time(status.time)}</span>
        <input
          className="video-seek"
          aria-label="播放进度"
          type="range"
          min={0}
          max={Math.max(1, status.duration)}
          value={Math.max(0, status.time)}
          disabled={!ready || !status.seekable}
          onChange={(e) => {
            const t = Number(e.target.value);
            setStatus((s) => ({ ...s, time: t }));
            void command("seek", t);
          }}
        />
        <span>{time(status.duration)}</span>
        <Volume2 size={18} />
        <input
          aria-label="音量"
          type="range"
          min={0}
          max={100}
          value={volume}
          style={{ width: 90 }}
          onChange={(e) => {
            setVolume(Number(e.target.value));
            if (ready) void command("volume", Number(e.target.value));
          }}
        />
        <small>
          {status.state === 3
            ? "播放中"
            : status.state === 4
              ? "已暂停"
              : status.state === 6
                ? "播放结束"
                : ready
                  ? "缓冲中"
                  : "就绪"}
        </small>
        <button
          title="全屏"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void dialog.current?.requestFullscreen();
          }}
        >
          <Maximize size={18} />
        </button>
      </div>
    </div>
  );
}
