import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUp,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  File,
  FileImage,
  FileText,
  Film,
  Folder,
  FolderPlus,
  HardDrive,
  LayoutGrid,
  List,
  LoaderCircle,
  MoreHorizontal,
  Music,
  PanelRightClose,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Server,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  X,
  Link,
  Pencil,
  Grip,
  LogOut,
  CheckCircle2,
} from "lucide-react";
import {
  Account,
  Entry,
  Transfer,
  blankAccount,
  parent,
  size,
  sortedEntries,
} from "./model";
import { clearMediaCache, mediaKind } from "./media";
import MediaThumbnail from "./MediaThumbnail";
import ImageViewer from "./ImageViewer";
import ThemeControl from "./ThemeControl";
import DirectoryTree from "./DirectoryTree";
import ThumbnailMenu from "./ThumbnailMenu";
import ChoiceMenu from "./ChoiceMenu";
import useMarquee from "./useMarquee";
import VideoViewer from "./VideoViewer";

import { restoreSession } from "./session";

const desktop = isTauri();
function FileIcon({ entry, large = false }: { entry: Entry; large?: boolean }) {
  if (entry.isdir)
    return <span className={`folder-icon ${large ? "large" : ""}`} />;
  const ext = entry.name.split(".").pop()?.toLowerCase();
  const Icon = ["png", "jpg", "jpeg", "webp", "svg"].includes(ext || "")
    ? FileImage
    : ["mp4", "mkv", "mov"].includes(ext || "")
      ? Film
      : ["mp3", "flac", "wav"].includes(ext || "")
        ? Music
        : ["pdf", "md", "txt", "docx"].includes(ext || "")
          ? FileText
          : File;
  return (
    <span className={`file-icon ${ext} ${large ? "large" : ""}`}>
      <Icon size={large ? 34 : 21} strokeWidth={1.5} />
      {large && <small>{ext?.toUpperCase()}</small>}
    </span>
  );
}
type Dialog = {
  type: "mkdir" | "rename" | "delete" | "properties" | "share";
  item?: Entry;
  value: string;
};
export default function App() {
  const [treeRevision, setTreeRevision] = useState(0);
  const [treeListing, setTreeListing] = useState<{
    id: string;
    path: string;
    entries: Entry[];
  } | null>(null);
  const [video, setVideo] = useState<Entry | null>(null);
  const [preview, setPreview] = useState<{
    id: string;
    path: string;
    files: Entry[];
  } | null>(null);
  const [mediaRevision, setMediaRevision] = useState(0);
  const [starting, setStarting] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [active, setActive] = useState("");
  const [connected, setConnected] = useState<string[]>([]);
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [shares, setShares] = useState<Entry[]>([]);
  const [history, setHistory] = useState(["/"]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [view, setView] = useState("grid");
  const [gridSize, setGridSize] = useState(
    () => localStorage.getItem("filedesk-grid-size") || "medium",
  );
  const [sort, setSort] = useState("name");
  const [asc, setAsc] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [editing, setEditing] = useState<Account>({ ...blankAccount });
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const [clipboard, setClipboard] = useState<{
    id: string;
    paths: string[];
    action: string;
  } | null>(null);
  const [addressEdit, setAddressEdit] = useState(false);
  const [address, setAddress] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [prepared, setPrepared] = useState<Record<string, string>>({});
  const [favorites, setFavorites] = useState<{ id: string; path: string }[]>(
    () => {
      try {
        return JSON.parse(localStorage.getItem("filedesk-favorites") || "[]");
      } catch {
        return [];
      }
    },
  );
  const request = useRef(0);
  const anchor = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const pathRef = useRef(path);
  pathRef.current = path;
  const account = accounts.find((a) => a.id === active);
  const online = !!active && connected.includes(active);
  const visible = sortedEntries(entries, query, sort, asc);
  const marquee = useMarquee(
    selected,
    setSelected,
    active + path + query + view,
  );
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (!(event.target as Element)?.closest?.(".context-menu"))
        setContext(null);
    };
    const close = () => setContext(null);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("click", dismiss, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("click", dismiss, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, []);
  function openEntry(entry: Entry) {
    if (entry.isdir) navigate(entry.path);
    else if (mediaKind(entry) === "image")
      setPreview({
        id: active,
        path: entry.path,
        files: visible.filter((e) => mediaKind(e) === "image"),
      });
    else if (mediaKind(entry) === "video") setVideo(entry);
    else setDialog({ type: "properties", item: entry, value: "" });
  }
  useEffect(() => {
    setPreview(null);
    setVideo(null);
    clearMediaCache();
  }, [active, online]);
  const picked = entries.filter((e) => selected.includes(e.path));
  const currentName = path === "/" ? "所有共享文件夹" : path.split("/").pop();
  const running = transfers.filter((t) => t.status === "running").length;
  const reloadAccounts = async () => {
    const items = desktop ? await invoke<Account[]>("accounts") : [];
    setAccounts(items);
    return items;
  };
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const items = desktop ? await invoke<Account[]>("accounts") : [];
        if (!alive) return;
        setAccounts(items);
        const restored = await restoreSession(
          items,
          localStorage.getItem("filedesk-last-account"),
          (account) =>
            invoke<string>("connect", { account, password: "", otp: "" }),
        );
        if (!alive) return;
        if (restored.connectedId) {
          setConnected((c) => [...new Set([...c, restored.connectedId!])]);
          switchAccount(restored.connectedId);
        } else {
          setActive(restored.account?.id || "");
          editAccount(restored.account || blankAccount);
          if (restored.error)
            setAccountError("自动登录失败，请重新登录：" + restored.error);
        }
      } catch (e) {
        if (alive) {
          editAccount(blankAccount);
          setAccountError("读取账号失败：" + String(e));
        }
      } finally {
        if (alive) setStarting(false);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    localStorage.setItem("filedesk-favorites", JSON.stringify(favorites));
  }, [favorites]);
  const read = useCallback(
    async (id: string, target: string) =>
      invoke<Entry[]>("list_files", { id, path: target }),
    [],
  );
  const refresh = useCallback(async () => {
    const n = ++request.current;
    if (!online) {
      setEntries([]);
      setTreeListing(null);
      setBusy(false);
      setError("");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await read(active, path);
      if (n === request.current) {
        setEntries(data);
        setTreeListing({ id: active, path, entries: data });
        setSelected([]);
      }
    } catch (e) {
      if (n === request.current) {
        setError(String(e));
        setEntries([]);
      }
    } finally {
      if (n === request.current) setBusy(false);
    }
  }, [active, path, read, online]);
  function refreshMedia() {
    setTreeRevision((v) => v + 1);
    clearMediaCache();
    setMediaRevision((v) => v + 1);
    void refresh();
  }
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    let alive = true;
    setShares([]);
    if (!online) return;
    read(active, "/")
      .then((data) => {
        if (alive) setShares(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active, read, online]);
  function navigate(target: string) {
    if (!target.startsWith("/")) target = "/" + target;
    target = target.replace(/\/+$/, "") || "/";
    setPath(target);
    setEntries([]);
    setSelected([]);
    setQuery("");
    setContext(null);
    setAddressEdit(false);
    const next = [...history.slice(0, historyIndex + 1), target];
    setHistory(next);
    setHistoryIndex(next.length - 1);
  }
  function switchAccount(id: string) {
    ++request.current;
    setActive(id);
    if (id) localStorage.setItem("filedesk-last-account", id);
    else localStorage.removeItem("filedesk-last-account");
    setShares([]);
    setTreeListing(null);
    setError("");
    setEntries([]);
    setPath("/");
    setHistory(["/"]);
    setHistoryIndex(0);
    setSelected([]);
    setQuery("");
    setClipboard(null);
  }
  async function runOperation(action: string, name = "", target = path) {
    if (busy) return;
    if (!online) {
      editAccount(account || blankAccount);
      return;
    }
    setBusy(true);
    setError("");
    const id = active,
      originalPath = path,
      selectedPaths =
        action === "copy" || action === "move"
          ? clipboard?.paths || []
          : selected;
    try {
      await invoke("operate", {
        id,
        action,
        paths: selectedPaths,
        destination: target,
        name,
      });
      setTreeRevision((v) => v + 1);
      setTreeListing(null);
      setDialog(null);
      setToast("操作已完成");
      if (action === "move") setClipboard(null);
      if (activeRef.current === id && pathRef.current === originalPath)
        await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function copySelection(action: string) {
    if (!selected.length) return;
    setClipboard({ id: active, paths: [...selected], action });
    setToast(
      `已${action === "move" ? "剪切" : "复制"} ${selected.length} 个项目`,
    );
    setContext(null);
  }
  function paste() {
    if (clipboard && clipboard.id === active && path !== "/")
      void runOperation(clipboard.action);
  }
  async function task(
    name: string,
    direction: "upload" | "download",
    fn: (id: string) => Promise<unknown>,
  ) {
    const id = crypto.randomUUID();
    setTransfers((t) => [
      { id, name, direction, done: 0, total: 0, status: "running" },
      ...t,
    ]);
    setTransferOpen(true);
    try {
      const result = await fn(id);
      setTransfers((t) =>
        t.map((x) => (x.id === id ? { ...x, status: "done" } : x)),
      );
      return result;
    } catch (e) {
      setTransfers((t) =>
        t.map((x) =>
          x.id === id ? { ...x, status: "error", error: String(e) } : x,
        ),
      );
      return null;
    }
  }
  async function uploadPaths(paths: string[]) {
    const id = activeRef.current,
      destination = pathRef.current;
    if (!id || !connected.includes(id)) {
      setToast("请先登录 NAS 后上传");
      return;
    }
    if (destination === "/") {
      setToast("请先进入一个共享文件夹");
      return;
    }
    await task(
      paths.length === 1
        ? paths[0].split(/[\\/]/).pop()!
        : `${paths.length} 个上传项目`,
      "upload",
      (taskId) => invoke("upload", { id, paths, destination, taskId }),
    );
    if (activeRef.current === id && pathRef.current === destination)
      await refresh();
  }
  const uploadRef = useRef(uploadPaths);
  uploadRef.current = uploadPaths;
  useEffect(() => {
    if (!desktop) return;
    let dead = false;
    const offs: (() => void)[] = [];
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over")
          setDragOver(true);
        else setDragOver(false);
        if (payload.type === "drop") void uploadRef.current(payload.paths);
      })
      .then((off) => {
        if (dead) off();
        else offs.push(off);
      });
    listen<Partial<Transfer> & { id: string }>("transfer-progress", (event) =>
      setTransfers((t) =>
        t.map((x) =>
          x.id === event.payload.id
            ? { ...x, ...event.payload, status: "running" }
            : x,
        ),
      ),
    ).then((off) => {
      if (dead) off();
      else offs.push(off);
    });
    return () => {
      dead = true;
      offs.forEach((off) => off());
    };
  }, []);
  async function chooseUpload(directory = false) {
    if (!online) {
      setToast("连接 NAS 后即可上传文件或文件夹");
      return;
    }
    const files = await open({ multiple: true, directory });
    if (files) await uploadPaths(Array.isArray(files) ? files : [files]);
  }
  async function downloadSelection() {
    if (!picked.length) return;
    if (!online) {
      setToast("请先登录 NAS 后下载");
      return;
    }
    const name =
      picked.length === 1 && !picked[0].isdir
        ? picked[0].name
        : `${picked.length === 1 ? picked[0].name : "FileDesk-下载"}.zip`;
    const destination = await save({ defaultPath: name });
    if (!destination) return;
    await task(name, "download", (taskId) =>
      invoke("download", { id: active, paths: selected, destination, taskId }),
    );
  }
  async function prepare() {
    if (picked.length !== 1 || picked[0].isdir) return;
    if (!online) {
      setToast("原生拖出需要连接 NAS 并先缓存文件");
      return;
    }
    const item = picked[0],
      key = active + item.path;
    const result = await task(item.name, "download", (taskId) =>
      invoke<string>("prepare_drag", {
        id: active,
        path: item.path,
        name: item.name,
        taskId,
      }),
    );
    if (typeof result === "string") {
      setPrepared((p) => ({ ...p, [key]: result }));
      setToast("文件已就绪，按住文件右侧的拖拽按钮，拖到资源管理器");
    }
  }
  async function share() {
    if (!online) {
      setToast("请连接 NAS 后创建分享链接");
      return;
    }
    try {
      const result = await invoke<{ links?: { url: string }[] }>("operate", {
        id: active,
        action: "share",
        paths: selected,
        destination: "",
        name: "",
      });
      setDialog({
        type: "share",
        value: result.links?.map((l) => l.url).join("\n") || "NAS 未返回链接",
      });
    } catch (e) {
      setError(String(e));
    }
  }
  function select(entry: Entry, index: number, event: React.MouseEvent) {
    if (event.shiftKey) {
      setSelected(
        visible
          .slice(
            Math.min(anchor.current, index),
            Math.max(anchor.current, index) + 1,
          )
          .map((e) => e.path),
      );
    } else if (event.ctrlKey || event.metaKey) {
      setSelected((s) =>
        s.includes(entry.path)
          ? s.filter((p) => p !== entry.path)
          : [...s, entry.path],
      );
      anchor.current = index;
    } else {
      setSelected([entry.path]);
      anchor.current = index;
    }
  }
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (
      preview ||
      video ||
      accountOpen ||
      dialog ||
      busy ||
      (e.target as HTMLElement).closest(
        "input,textarea,select,[contenteditable='true']",
      )
    )
      return;
    const cmd = e.ctrlKey || e.metaKey;
    if (e.key === "Backspace" && !cmd && !e.altKey) {
      e.preventDefault();
      if (path !== "/") navigate(parent(path));
      return;
    }
    if (cmd && e.key === "a") {
      e.preventDefault();
      setSelected(visible.map((e) => e.path));
    }
    if (cmd && e.key === "c") {
      e.preventDefault();
      copySelection("copy");
    }
    if (cmd && e.key === "x") {
      e.preventDefault();
      copySelection("move");
    }
    if (cmd && e.key === "v") {
      e.preventDefault();
      paste();
    }
    if (e.key === "F2" && picked.length === 1) {
      e.preventDefault();
      setDialog({ type: "rename", value: picked[0].name });
    }
    if (e.key === "Delete" && picked.length) {
      e.preventDefault();
      setDialog({ type: "delete", value: "" });
    }
    if (e.key === "F5") {
      e.preventDefault();
      refreshMedia();
    }
    if (e.key === "Enter" && picked.length === 1) {
      openEntry(picked[0]);
    }
    if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      navigate(parent(path));
    }
    if (cmd && e.key === "l") {
      e.preventDefault();
      setAddress(path);
      setAddressEdit(true);
    }
    if (e.key === "Escape") {
      setContext(null);
      setSelected([]);
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    if (!desktop) {
      setAccountError("浏览器是界面预览，请启动 Windows 桌面版连接 NAS。");
      return;
    }
    setConnecting(true);
    setAccountError("");
    try {
      const id = await invoke<string>("connect", {
        account: editing,
        password,
        otp,
      });
      await reloadAccounts();
      setConnected((c) => [...new Set([...c, id])]);
      switchAccount(id);
      setAccountOpen(false);
      setPassword("");
      setOtp("");
      setToast("已连接到 " + editing.name);
    } catch (e) {
      setAccountError(String(e));
    } finally {
      setConnecting(false);
    }
  }
  function editAccount(a: Account) {
    setEditing({ ...a });
    setPassword("");
    setOtp("");
    setAccountError("");
    setAccountOpen(true);
  }
  const favorite =
    online && favorites.some((f) => f.id === active && f.path === path);
  const menu = (
    <>
      <button
        disabled={!picked.length}
        onClick={() => {
          void downloadSelection();
          setContext(null);
        }}
      >
        <Download />
        下载<span>Ctrl + 保存</span>
      </button>
      <button disabled={!picked.length} onClick={() => copySelection("copy")}>
        <Copy />
        复制<span>Ctrl C</span>
      </button>
      <button disabled={!picked.length} onClick={() => copySelection("move")}>
        <Scissors />
        剪切<span>Ctrl X</span>
      </button>
      <button
        disabled={!clipboard || clipboard.id !== active || path === "/"}
        onClick={() => {
          paste();
          setContext(null);
        }}
      >
        <Copy />
        粘贴<span>Ctrl V</span>
      </button>
      <hr />
      <button
        disabled={picked.length !== 1}
        onClick={() => {
          setDialog({ type: "rename", value: picked[0].name });
          setContext(null);
        }}
      >
        <Pencil />
        重命名<span>F2</span>
      </button>
      <button
        disabled={picked.length !== 1 || picked[0]?.isdir}
        onClick={() => {
          void prepare();
          setContext(null);
        }}
      >
        <Grip />
        准备拖出到桌面
      </button>
      <button
        disabled={!picked.length}
        onClick={() => {
          void share();
          setContext(null);
        }}
      >
        <Link />
        创建分享链接
      </button>
      <button
        disabled={picked.length !== 1}
        onClick={() => {
          setDialog({ type: "properties", item: picked[0], value: "" });
          setContext(null);
        }}
      >
        <FileText />
        属性
      </button>
      <hr />
      <button
        className="danger-text"
        disabled={!picked.length}
        onClick={() => {
          setDialog({ type: "delete", value: "" });
          setContext(null);
        }}
      >
        <Trash2 />
        删除<span>Del</span>
      </button>
    </>
  );
  return (
    <div className="app" onClick={() => context && setContext(null)}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">
            <Folder size={23} />
          </span>
          <b>FileDesk</b>
          <span className="beta">BETA</span>
        </div>
        <div className="workspace-label">我的存储空间</div>
        <button
          disabled={starting}
          className={`account-card ${online ? "" : "disconnected"}`}
          title="账号管理"
          onClick={() => editAccount(account || blankAccount)}
        >
          <span className="server-badge">
            <Server size={23} />
            <i />
          </span>
          <span>
            <strong>{account?.name || "登录 Synology"}</strong>
            <small>
              {account
                ? `${account.username} · ${online ? "已连接" : "未连接"}`
                : "添加账号，连接你的 NAS"}
            </small>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="account-switch">
          <ChoiceMenu
            label="切换账号"
            heading="我的账号"
            disabled={starting}
            value={active}
            placeholder={accounts.length ? "选择账号" : "暂无账号"}
            triggerClass="account-choice-trigger"
            showIcon
            options={accounts.map((a) => ({
              value: a.id,
              label: a.name,
              hint: `${a.username} · ${connected.includes(a.id) ? "已连接" : "未连接"}`,
              icon: <Server size={16} />,
            }))}
            onChange={(id) => {
              const a = accounts.find((a) => a.id === id);
              if (a && !connected.includes(a.id)) editAccount(a);
              else switchAccount(id);
            }}
          />
          <button
            disabled={starting}
            title="添加账号"
            onClick={() => editAccount(blankAccount)}
          >
            <Plus size={17} />
          </button>
        </div>
        <section className="quick-access" aria-label="快速访问">
          <div className="section-label">
            <Star size={12} />
            快速访问
          </div>
          <div className="favorite-list">
            {favorites
              .filter((f) => f.id === active)
              .map((f) => (
                <div
                  key={f.path}
                  className={`favorite-row ${online && path === f.path ? "current" : ""}`}
                >
                  <button
                    className="favorite-link"
                    title={f.path}
                    disabled={!online}
                    aria-current={
                      online && path === f.path ? "page" : undefined
                    }
                    onClick={() => navigate(f.path)}
                  >
                    <Star size={15} />
                    <span>{f.path.split("/").pop() || "所有文件"}</span>
                  </button>
                  <button
                    className="favorite-remove"
                    title="从快速访问移除"
                    aria-label={`移除收藏：${f.path}`}
                    onClick={() =>
                      setFavorites((v) => v.filter((x) => x !== f))
                    }
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            {!favorites.some((f) => f.id === active) && (
              <p className="sidebar-hint">点击路径栏 ☆，固定常用文件夹</p>
            )}
          </div>
        </section>
        <nav aria-label="文件夹导航">
          <button
            className={online && path === "/" ? "nav-item active" : "nav-item"}
            disabled={!online}
            onClick={() => navigate("/")}
          >
            <HardDrive size={17} />
            所有文件<span>{shares.length}</span>
          </button>
          <div className="section-label">
            共享文件夹<span>{shares.length}</span>
          </div>
          <DirectoryTree
            key={`${active}:${treeRevision}`}
            id={active}
            path={path}
            roots={shares}
            listing={treeListing?.id === active ? treeListing : null}
            read={read}
            onNavigate={navigate}
          />
          {!shares.length && (
            <p className="sidebar-hint">
              {online ? "暂无共享文件夹" : "连接 NAS 后显示目录"}
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div>
            <ShieldCheck size={17} />
            <span>{"密码存储于系统凭据库"}</span>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span className="eyebrow">FILE STATION CLIENT</span>
            <h1>
              {currentName}
              <span>{account?.name || "未登录"}</span>
            </h1>
          </div>
          <div className="header-actions">
            <ThemeControl />
            <button
              className={`transfer-toggle ${transferOpen ? "on" : ""}`}
              onClick={() => setTransferOpen(!transferOpen)}
            >
              <ArrowDownToLine size={17} />
              传输{running > 0 && <b>{running}</b>}
            </button>
          </div>
        </header>
        <div className="navigation">
          <div className="history">
            <button
              title="后退"
              disabled={historyIndex === 0}
              onClick={() => {
                setHistoryIndex(historyIndex - 1);
                setPath(history[historyIndex - 1]);
                setQuery("");
              }}
            >
              <ArrowLeft />
            </button>
            <button
              title="前进"
              disabled={historyIndex === history.length - 1}
              onClick={() => {
                setHistoryIndex(historyIndex + 1);
                setPath(history[historyIndex + 1]);
                setQuery("");
              }}
            >
              <ArrowRight />
            </button>
            <button
              title="上一级 Alt+↑"
              disabled={!online || path === "/"}
              onClick={() => navigate(parent(path))}
            >
              <ArrowUp />
            </button>
          </div>
          <div
            className="breadcrumbs"
            onDoubleClick={() => {
              setAddress(path);
              setAddressEdit(true);
            }}
          >
            <HardDrive size={16} />
            {addressEdit ? (
              <input
                autoFocus
                aria-label="文件路径"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onBlur={() => setAddressEdit(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") navigate(address);
                  if (e.key === "Escape") setAddressEdit(false);
                }}
              />
            ) : (
              <>
                <button onClick={() => navigate("/")}>
                  {account?.name || "Synology"}
                </button>
                {path
                  .split("/")
                  .filter(Boolean)
                  .map((part, i, parts) => (
                    <span key={i}>
                      <ChevronRight size={13} />
                      <button
                        onClick={() =>
                          navigate("/" + parts.slice(0, i + 1).join("/"))
                        }
                      >
                        {part}
                      </button>
                    </span>
                  ))}
              </>
            )}
            <button
              className={`star ${favorite ? "saved" : ""}`}
              title="收藏当前目录"
              disabled={!online}
              onClick={() =>
                setFavorites((f) =>
                  favorite
                    ? f.filter((x) => !(x.id === active && x.path === path))
                    : [...f, { id: active, path }],
                )
              }
            >
              <Star size={17} />
            </button>
          </div>
          <label className="search">
            <Search size={17} />
            <input
              placeholder={`搜索 ${currentName}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            )}
          </label>
        </div>
        <div className="toolbar">
          <button
            className="primary"
            disabled={path === "/" || busy}
            onClick={() => void chooseUpload()}
          >
            <Upload />
            上传文件
          </button>
          <button
            className="upload-folder"
            title="上传文件夹"
            disabled={path === "/" || busy}
            onClick={() => void chooseUpload(true)}
          >
            <ChevronDown />
          </button>
          <button
            disabled={path === "/" || busy}
            onClick={() => setDialog({ type: "mkdir", value: "新建文件夹" })}
          >
            <FolderPlus />
            新建文件夹
          </button>
          <span className="divider" />
          <button
            disabled={!selected.length}
            onClick={() => void downloadSelection()}
          >
            <Download />
            下载
          </button>
          <button
            disabled={!selected.length}
            title="复制"
            onClick={() => copySelection("copy")}
          >
            <Copy />
          </button>
          <button
            disabled={!selected.length}
            title="剪切"
            onClick={() => copySelection("move")}
          >
            <Scissors />
          </button>
          <button
            disabled={!clipboard || clipboard.id !== active || path === "/"}
            title="粘贴"
            onClick={paste}
          >
            <FileText />
          </button>
          <button
            disabled={!selected.length}
            title="删除"
            onClick={() => setDialog({ type: "delete", value: "" })}
          >
            <Trash2 />
          </button>
          <button
            title="更多操作"
            onClick={(e) => {
              e.stopPropagation();
              setContext({
                x: Math.min(e.clientX, window.innerWidth - 250),
                y: e.clientY + 16,
              });
            }}
          >
            <MoreHorizontal />
          </button>
          <div className="toolbar-right">
            <ChoiceMenu
              label="排序"
              heading="文件排序"
              value={sort}
              onChange={setSort}
              triggerClass="sort-choice-trigger"
              options={[
                {
                  value: "name",
                  label: "名称排序",
                  hint: "按文件与文件夹名称排列",
                  icon: <FileText size={16} />,
                },
                {
                  value: "time",
                  label: "修改时间",
                  hint: "按最后修改时间排列",
                  icon: <RefreshCw size={16} />,
                },
                {
                  value: "size",
                  label: "文件大小",
                  hint: "按文件占用空间排列",
                  icon: <HardDrive size={16} />,
                },
              ]}
            />
            <button title="切换升降序" onClick={() => setAsc(!asc)}>
              <ArrowUp className={asc ? "" : "rotate"} />
            </button>
            <div className="view-switch">
              {view === "grid" && (
                <ThumbnailMenu
                  value={gridSize}
                  onChange={(value) => {
                    setGridSize(value);
                    localStorage.setItem("filedesk-grid-size", value);
                  }}
                />
              )}
              <button
                title="网格视图"
                className={view === "grid" ? "selected" : ""}
                onClick={() => setView("grid")}
              >
                <LayoutGrid />
              </button>
              <button
                title="列表视图"
                className={view === "list" ? "selected" : ""}
                onClick={() => setView("list")}
              >
                <List />
              </button>
            </div>
          </div>
        </div>
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => void refresh()}>重试</button>
            <button onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        <div className="content-wrap">
          <section
            ref={marquee.ref}
            tabIndex={-1}
            onPointerDown={marquee.onPointerDown}
            onClickCapture={(e) => {
              if (marquee.suppressClick.current) {
                e.stopPropagation();
                e.preventDefault();
              }
            }}
            className={`file-area ${dragOver ? "drag-over" : ""}`}
            onContextMenu={(e) => {
              e.preventDefault();
              setContext({
                x: Math.min(e.clientX, window.innerWidth - 250),
                y: Math.min(e.clientY, window.innerHeight - 400),
              });
            }}
          >
            <div className="file-section-heading">
              <span>
                {query ? "搜索结果" : "文件与文件夹"}
                <small>{visible.length}</small>
              </span>
              <button title="刷新 F5" onClick={refreshMedia}>
                <RefreshCw className={busy ? "spin" : ""} size={15} />
              </button>
            </div>
            {view === "list" && (
              <div className="list-heading">
                <span>名称</span>
                <span>修改时间</span>
                <span>类型</span>
                <span>大小</span>
              </div>
            )}
            {marquee.box && <div className="marquee-box" style={marquee.box} />}
            <div
              className={
                view === "grid" ? `file-grid grid-${gridSize}` : "file-list"
              }
            >
              {visible.map((entry, index) => (
                <div
                  key={entry.path}
                  data-file-path={entry.path}
                  role="button"
                  tabIndex={0}
                  aria-label={entry.name}
                  aria-selected={selected.includes(entry.path)}
                  className={`file-entry ${selected.includes(entry.path) ? "selected" : ""} ${clipboard?.action === "move" && clipboard.paths.includes(entry.path) ? "cut" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    select(entry, index, e);
                  }}
                  onDoubleClick={() => openEntry(entry)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!selected.includes(entry.path))
                      setSelected([entry.path]);
                    setContext({
                      x: Math.min(e.clientX, window.innerWidth - 250),
                      y: Math.min(e.clientY, window.innerHeight - 400),
                    });
                  }}
                >
                  <span className="selection-check">
                    {selected.includes(entry.path) && <Check size={12} />}
                  </span>
                  <MediaThumbnail
                    key={`${active}:${entry.path}:${mediaRevision}`}
                    id={active}
                    entry={entry}
                    large={view === "grid"}
                    fallback={
                      <FileIcon entry={entry} large={view === "grid"} />
                    }
                  />
                  <span className="file-name" title={entry.name}>
                    {entry.name}
                  </span>
                  {view === "grid" ? (
                    <span className="file-meta">
                      {entry.isdir ? "文件夹" : size(entry.additional?.size)}
                    </span>
                  ) : (
                    <>
                      <span className="file-date">
                        {entry.additional?.time?.mtime
                          ? new Date(
                              entry.additional.time.mtime * 1000,
                            ).toLocaleDateString("zh-CN")
                          : "—"}
                      </span>
                      <span className="file-type">
                        {entry.isdir
                          ? "文件夹"
                          : entry.name.split(".").pop()?.toUpperCase() +
                            " 文件"}
                      </span>
                      <span className="file-size">
                        {entry.isdir ? "—" : size(entry.additional?.size)}
                      </span>
                    </>
                  )}
                  {prepared[active + entry.path] && (
                    <button
                      className="drag-ready"
                      title="按住并拖到资源管理器"
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        void invoke("native_drag", {
                          paths: [prepared[active + entry.path]],
                        }).catch((e) => setError(String(e)));
                      }}
                    >
                      <Grip size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {!visible.length && !busy && online && (
              <div className="empty">
                <Folder size={52} strokeWidth={1} />
                <h3>{query ? "没有找到匹配的文件" : "这里还没有文件"}</h3>
                <p>
                  {query
                    ? "试试其他关键词"
                    : "将文件或文件夹拖到这里，轻松上传到 NAS"}
                </p>
                {!query && path !== "/" && (
                  <button
                    className="primary"
                    onClick={() => void chooseUpload()}
                  >
                    <Upload size={16} />
                    上传文件
                  </button>
                )}
              </div>
            )}
            {starting && !online && (
              <div className="empty" role="status">
                <LoaderCircle className="spin" size={32} />
                <h3>正在自动登录…</h3>
                <p>正在恢复上次使用的账号</p>
              </div>
            )}
            {!starting && !online && !busy && (
              <div className="empty">
                <Server size={40} />
                <h3>
                  {accounts.length
                    ? "登录后浏览 NAS 文件"
                    : "连接你的第一台 NAS"}
                </h3>
                <p>
                  {accounts.length
                    ? "点击左上角账号卡片登录，文件将在连接后显示。"
                    : "点击左上角账号卡片添加账号，开始管理文件。"}
                </p>
              </div>
            )}
            {busy && !entries.length && (
              <div className="empty">
                <LoaderCircle className="spin" />
                <p>正在读取文件…</p>
              </div>
            )}
            {dragOver && (
              <div className="drop-overlay">
                <Upload size={42} />
                <h2>松开即可上传</h2>
                <p>上传到 {path}</p>
              </div>
            )}
          </section>
          {transferOpen && (
            <aside className="transfer-panel">
              <div className="panel-heading">
                <h3>
                  传输任务 <small>{transfers.length}</small>
                </h3>
                <button
                  title="关闭传输面板"
                  onClick={() => setTransferOpen(false)}
                >
                  <PanelRightClose size={18} />
                </button>
              </div>
              <p className="panel-subtitle">文件传输状态 · 当前会话</p>
              {!transfers.length ? (
                <div className="transfer-empty">
                  <ArrowDownToLine size={35} />
                  <p>所有传输，都在这里</p>
                  <small>上传或下载文件后可查看进度</small>
                </div>
              ) : (
                transfers.map((t) => (
                  <div className="transfer-item" key={t.id}>
                    <span className="transfer-icon">
                      {t.direction === "upload" ? (
                        <ArrowUpFromLine size={19} />
                      ) : (
                        <ArrowDownToLine size={19} />
                      )}
                    </span>
                    <div>
                      <strong title={t.name}>{t.name}</strong>
                      <p>
                        {t.status === "done"
                          ? "已完成"
                          : t.status === "error"
                            ? t.error
                            : `${size(t.done)} / ${t.total ? size(t.total) : "计算中"}`}
                      </p>
                      {t.status === "running" && (
                        <div className="progress">
                          <i
                            style={{
                              width: t.total
                                ? `${Math.min(99, (t.done / t.total) * 100)}%`
                                : "20%",
                            }}
                          />
                        </div>
                      )}
                    </div>
                    {t.status === "done" ? (
                      <CheckCircle2 size={17} className="success" />
                    ) : t.status === "running" ? (
                      <button
                        title="取消传输"
                        onClick={() =>
                          void invoke("cancel_transfer", { taskId: t.id })
                        }
                      >
                        <X size={15} />
                      </button>
                    ) : (
                      <X size={16} className="danger-text" />
                    )}
                  </div>
                ))
              )}
              {transfers.some((t) => t.status !== "running") && (
                <button
                  className="clear-tasks"
                  onClick={() =>
                    setTransfers((t) => t.filter((x) => x.status === "running"))
                  }
                >
                  清除已结束任务
                </button>
              )}
              <div className="transfer-tip">
                <ShieldCheck size={17} />
                <span>
                  同名文件不会被自动覆盖。拖出前请先通过右键菜单准备文件。
                </span>
              </div>
            </aside>
          )}
        </div>
        <footer>
          <span>
            {entries.length} 个项目
            {selected.length > 0 && (
              <>
                {" "}
                <i />
                已选择 {selected.length} 项
              </>
            )}
          </span>
          <span>
            {clipboard &&
              `${clipboard.paths.length} 项待${clipboard.action === "move" ? "移动" : "复制"} · Ctrl V 粘贴`}
            {online && <span className="footer-dot" />}
            {account?.address || "尚未连接 NAS"}
            <span className="footer-tag">DSM 7.2</span>
          </span>
        </footer>
      </main>
      {context && (
        <div
          className="context-menu"
          style={{ left: context.x, top: Math.max(10, context.y) }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu}
        </div>
      )}
      {toast && (
        <div className="toast">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
      {video && (
        <VideoViewer id={active} entry={video} onClose={() => setVideo(null)} />
      )}
      {preview && (
        <ImageViewer
          id={preview.id}
          files={preview.files}
          initialPath={preview.path}
          onClose={() => setPreview(null)}
        />
      )}
      {accountOpen && (
        <div className="modal-backdrop">
          <div className="account-modal">
            <div className="modal-heading">
              <div>
                <span className="eyebrow">YOUR CONNECTIONS</span>
                <h2>连接你的存储空间</h2>
              </div>
              <button
                disabled={connecting}
                aria-label="关闭账号管理"
                onClick={() => setAccountOpen(false)}
              >
                <X />
              </button>
            </div>
            <div className="account-modal-body">
              <aside>
                <b>我的账号</b>
                {accounts.map((a) => (
                  <div
                    className={`saved-account ${editing.id === a.id ? "selected" : ""}`}
                    key={a.id}
                  >
                    <button
                      onClick={() => {
                        if (!connecting) editAccount(a);
                      }}
                    >
                      <Server size={18} />
                      <span>
                        {a.name}
                        <small>{a.username}</small>
                      </span>
                      {connected.includes(a.id) && <i />}
                    </button>
                  </div>
                ))}
                <button
                  className="add-account"
                  disabled={connecting}
                  onClick={() => editAccount(blankAccount)}
                >
                  <Plus size={17} />
                  添加账号
                </button>
                <p>每个账号拥有独立会话。可同时连接同一台或不同 NAS。</p>
              </aside>
              <form onSubmit={login}>
                <div className="form-tabs">
                  <button
                    type="button"
                    className={editing.mode === "direct" ? "selected" : ""}
                    onClick={() => setEditing({ ...editing, mode: "direct" })}
                  >
                    IP / 域名
                  </button>
                  <button
                    type="button"
                    className={
                      editing.mode === "quickconnect" ? "selected" : ""
                    }
                    onClick={() =>
                      setEditing({ ...editing, mode: "quickconnect" })
                    }
                  >
                    QuickConnect <small>实验性</small>
                  </button>
                </div>
                <label>
                  账号名称
                  <input
                    required
                    placeholder="例如：家里的 NAS"
                    value={editing.name}
                    onChange={(e) =>
                      setEditing({ ...editing, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  {editing.mode === "direct" ? "NAS 地址" : "QuickConnect ID"}
                  <input
                    required
                    placeholder={
                      editing.mode === "direct"
                        ? "https://192.168.1.10:5001"
                        : "你的 QuickConnect ID"
                    }
                    value={editing.address}
                    onChange={(e) =>
                      setEditing({ ...editing, address: e.target.value })
                    }
                  />
                </label>
                {editing.mode === "quickconnect" && (
                  <>
                    <p className="form-note">
                      自动发现并验证 HTTPS
                      连接。第三方连接可能受中继和证书限制。
                    </p>
                    <label>
                      备用直连地址（可选）
                      <input
                        placeholder="https://nas.example.com:5001"
                        value={editing.fallback}
                        onChange={(e) =>
                          setEditing({ ...editing, fallback: e.target.value })
                        }
                      />
                    </label>
                  </>
                )}
                <div className="form-row">
                  <label>
                    用户名
                    <input
                      required
                      autoComplete="username"
                      value={editing.username}
                      onChange={(e) =>
                        setEditing({ ...editing, username: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    密码
                    <input
                      type="password"
                      autoComplete="current-password"
                      placeholder={
                        editing.id ? "留空使用已保存密码" : "DSM 登录密码"
                      }
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                </div>
                <label>
                  双重验证码（启用 2FA 时填写）
                  <input
                    value={otp}
                    inputMode="numeric"
                    placeholder="6 位动态验证码"
                    onChange={(e) => setOtp(e.target.value)}
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={editing.remember}
                    onChange={(e) =>
                      setEditing({ ...editing, remember: e.target.checked })
                    }
                  />
                  使用系统凭据库记住密码
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={editing.insecure}
                    onChange={(e) =>
                      setEditing({ ...editing, insecure: e.target.checked })
                    }
                  />
                  信任无效 / 自签名证书（仅限可信 NAS）
                </label>
                {editing.insecure && (
                  <p className="form-note warning">
                    此账号将跳过 TLS 证书校验。
                  </p>
                )}
                {accountError && (
                  <div className="form-error">{accountError}</div>
                )}
                <div className="form-actions">
                  {editing.id && (
                    <>
                      <button
                        type="button"
                        disabled={connecting}
                        title="移除此账号与保存的凭据"
                        onClick={async () => {
                          try {
                            await invoke("remove_account", { id: editing.id });
                            if (active === editing.id) switchAccount("");
                            setConnected((c) =>
                              c.filter((x) => x !== editing.id),
                            );
                            const remaining = await reloadAccounts();
                            const next =
                              remaining.find(
                                (a) => a.id === active && a.id !== editing.id,
                              ) || remaining[0];
                            if (active === editing.id)
                              switchAccount(next?.id || "");
                            editAccount(next || blankAccount);
                          } catch (e) {
                            setAccountError(String(e));
                          }
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                      {connected.includes(editing.id) && (
                        <button
                          type="button"
                          disabled={connecting}
                          title="断开连接"
                          onClick={async () => {
                            try {
                              await invoke("disconnect", { id: editing.id });
                              setConnected((c) =>
                                c.filter((x) => x !== editing.id),
                              );
                              if (active === editing.id)
                                switchAccount(editing.id);
                            } catch (e) {
                              setAccountError(String(e));
                            }
                          }}
                        >
                          <LogOut size={16} />
                        </button>
                      )}
                    </>
                  )}
                  <button
                    className="primary"
                    type="submit"
                    disabled={connecting}
                  >
                    {connecting ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <Link size={17} />
                    )}{" "}
                    {connecting ? "正在连接…" : "连接 NAS"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
      {dialog && (
        <div className="modal-backdrop">
          <form
            className="small-modal"
            onSubmit={(e) => {
              e.preventDefault();
              void runOperation(dialog.type, dialog.value);
            }}
          >
            <div className="modal-heading">
              <h2>
                {
                  {
                    mkdir: "新建文件夹",
                    rename: "重命名",
                    delete: "删除所选项目",
                    properties: "文件属性",
                    share: "分享链接",
                  }[dialog.type]
                }
              </h2>
              <button type="button" onClick={() => setDialog(null)}>
                <X size={20} />
              </button>
            </div>
            {dialog.type === "delete" ? (
              <p>
                确定删除所选的 {selected.length} 个项目？是否进入回收站取决于
                NAS 共享文件夹的设置。
              </p>
            ) : dialog.type === "properties" ? (
              <div className="properties">
                <FileIcon entry={dialog.item!} large />
                <h3>{dialog.item?.name}</h3>
                <dl>
                  <dt>路径</dt>
                  <dd>{dialog.item?.path}</dd>
                  <dt>类型</dt>
                  <dd>{dialog.item?.isdir ? "文件夹" : "文件"}</dd>
                  <dt>大小</dt>
                  <dd>
                    {dialog.item?.isdir
                      ? "—"
                      : size(dialog.item?.additional?.size)}
                  </dd>
                  <dt>修改时间</dt>
                  <dd>
                    {dialog.item?.additional?.time?.mtime
                      ? new Date(
                          dialog.item.additional.time.mtime * 1000,
                        ).toLocaleString("zh-CN")
                      : "—"}
                  </dd>
                </dl>
              </div>
            ) : dialog.type === "share" ? (
              <textarea
                readOnly
                value={dialog.value}
                onFocus={(e) => e.target.select()}
              />
            ) : (
              <input
                autoFocus
                required
                value={dialog.value}
                onChange={(e) =>
                  setDialog({ ...dialog, value: e.target.value })
                }
                onFocus={(e) => e.target.select()}
              />
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => setDialog(null)}>
                {["properties", "share"].includes(dialog.type)
                  ? "关闭"
                  : "取消"}
              </button>
              {!["properties", "share"].includes(dialog.type) && (
                <button
                  type="submit"
                  disabled={busy}
                  className={dialog.type === "delete" ? "danger" : "primary"}
                >
                  {busy
                    ? "处理中…"
                    : dialog.type === "delete"
                      ? "确认删除"
                      : "确定"}
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
