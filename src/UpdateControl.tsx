import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CheckCircle2, Download, LoaderCircle, RefreshCw } from "lucide-react";
import { version } from "../package.json";
import { size } from "./model";

type UpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  size: number;
  notes: string;
};
type Phase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "current";
export function useAppUpdate() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  useEffect(() => {
    if (!isTauri()) return;
    let dead = false;
    let off: (() => void) | undefined;
    listen<{ done: number; total: number }>("update-progress", (event) =>
      setProgress(event.payload),
    ).then((unlisten) => {
      if (dead) unlisten();
      else off = unlisten;
    });
    return () => {
      dead = true;
      off?.();
    };
  }, []);
  async function check() {
    setError("");
    if (!isTauri()) {
      setError("请在 Windows 客户端中检查更新");
      return;
    }
    setPhase("checking");
    setInfo(null);
    try {
      const info = await invoke<UpdateInfo>("check_update");
      setInfo(info);
      setPhase(info.available ? "available" : "current");
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  }
  async function download() {
    setError("");
    setProgress({ done: 0, total: info?.size || 0 });
    setPhase("downloading");
    try {
      await invoke("download_update");
      setPhase("ready");
    } catch (e) {
      setError(String(e));
      setPhase("available");
    }
  }
  async function install() {
    setError("");
    setPhase("installing");
    try {
      await invoke("install_update");
    } catch (e) {
      setError(String(e));
      setPhase("ready");
    }
  }
  return { phase, info, error, progress, check, download, install };
}
export default function UpdateControl({
  update,
  transfersRunning,
}: {
  update: ReturnType<typeof useAppUpdate>;
  transfersRunning: boolean;
}) {
  const { phase, info, error, progress, check, download, install } = update;
  const pending = ["checking", "downloading", "installing"].includes(phase);
  const label =
    phase === "checking"
      ? "正在检查…"
      : phase === "available"
        ? "下载更新"
        : phase === "downloading"
          ? "正在下载…"
          : phase === "ready"
            ? "安装更新"
            : phase === "installing"
              ? "正在启动安装…"
              : "检查更新";
  return (
    <section className="app-update" aria-label="应用更新">
      <div className="update-version">
        FileDesk <span>v{version}</span>
      </div>
      {info?.available && (
        <p className="update-available">发现新版本 v{info.latestVersion}</p>
      )}
      {phase === "current" && (
        <p className="update-current">
          <CheckCircle2 size={12} />
          已是最新版本
        </p>
      )}
      <button
        className="check-update-button"
        disabled={pending || (phase === "ready" && transfersRunning)}
        onClick={() =>
          void (phase === "available"
            ? download()
            : phase === "ready"
              ? install()
              : check())
        }
      >
        {pending ? (
          <LoaderCircle className="spin" size={15} />
        ) : phase === "available" ? (
          <Download size={15} />
        ) : (
          <RefreshCw size={15} />
        )}
        {label}
      </button>
      {phase === "downloading" && (
        <div role="status" className="update-download-progress">
          <progress max={progress.total || 1} value={progress.done} />
          <span>
            {size(progress.done)} / {size(progress.total)}
          </span>
        </div>
      )}
      {phase === "ready" && (
        <p className="update-hint">
          {transfersRunning
            ? "请等待文件传输完成后安装"
            : "已校验安装包，安装时将关闭客户端"}
        </p>
      )}
      {info?.available && info.notes && (
        <details className="update-notes">
          <summary>更新说明</summary>
          <p>{info.notes}</p>
        </details>
      )}
      {error && (
        <p className="update-error" role="alert">
          {error}
        </p>
      )}
      {["available", "ready"].includes(phase) && (
        <button className="recheck-update" onClick={() => void check()}>
          重新检查
        </button>
      )}
    </section>
  );
}
