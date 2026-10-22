import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, FolderOpen, LoaderCircle } from "lucide-react";
import type { Entry } from "./model";
import { childDirectories, directoryChain } from "./tree";

type Listing = { path: string; entries: Entry[] };
type Node = { children?: Entry[]; loading?: boolean; error?: string };
export default function DirectoryTree({
  id,
  path,
  roots,
  listing,
  read,
  onNavigate,
}: {
  id: string;
  path: string;
  roots: Entry[];
  listing: Listing | null;
  read: (id: string, path: string) => Promise<Entry[]>;
  onNavigate: (path: string) => void;
}) {
  const [nodes, setNodes] = useState<Record<string, Node>>({});
  const cache = useRef<Record<string, Node>>({});
  const versions = useRef<Record<string, number>>({});
  const epoch = useRef(0);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(directoryChain(path)),
  );
  const tree = useRef<HTMLDivElement>(null);
  const reveal = useRef<string | null>(path);
  useEffect(
    () => () => {
      epoch.current++;
      cache.current = {};
    },
    [],
  );
  const load = useCallback(
    async (target: string, force = false) => {
      if (
        !force &&
        (cache.current[target]?.children || cache.current[target]?.loading)
      )
        return;
      const generation = epoch.current;
      const version = (versions.current[target] =
        (versions.current[target] || 0) + 1);
      const update = (node: Node) => {
        cache.current[target] = node;
        setNodes((v) => ({ ...v, [target]: node }));
      };
      update({ loading: true });
      try {
        const entries = await read(id, target);
        if (
          epoch.current === generation &&
          versions.current[target] === version
        )
          update({ children: childDirectories(target, entries) });
      } catch (e) {
        if (
          epoch.current === generation &&
          versions.current[target] === version
        )
          update({ error: String(e) });
      }
    },
    [id, read],
  );
  useEffect(() => {
    const chain = directoryChain(path);
    reveal.current = path;
    setExpanded((previous) => new Set([...previous, ...chain]));
    chain.forEach((p) => void load(p));
  }, [path, load]);
  useEffect(() => {
    if (!listing) return;
    versions.current[listing.path] = (versions.current[listing.path] || 0) + 1;
    const node = { children: childDirectories(listing.path, listing.entries) };
    cache.current[listing.path] = node;
    setNodes((v) => ({ ...v, [listing.path]: node }));
  }, [listing]);
  useEffect(() => {
    if (reveal.current !== path) return;
    const current = tree.current?.querySelector<HTMLElement>(
      '[aria-current="page"]',
    );
    if (current) {
      reveal.current = null;
      const scroller = tree.current?.closest("nav");
      if (scroller) {
        const a = current.getBoundingClientRect(),
          b = scroller.getBoundingClientRect();
        if (a.top < b.top || a.bottom > b.bottom)
          current.scrollIntoView({ block: "nearest" });
      }
    }
  }, [path, nodes]);
  function branch(entry: Entry, depth: number) {
    const node = nodes[entry.path],
      open = expanded.has(entry.path),
      active = entry.path === path;
    const expandable = !node?.children || node.children.length > 0;
    return (
      <div
        key={entry.path}
        role="treeitem"
        aria-label={entry.name}
        aria-level={depth + 1}
        aria-selected={active}
        aria-expanded={expandable ? open : undefined}
      >
        <div
          className={`directory-row ${active ? "current" : ""}`}
          style={{ paddingLeft: 8 + depth * 18 }}
        >
          <button
            className="directory-toggle"
            aria-label={`${open ? "收起" : "展开"} ${entry.path}`}
            disabled={!expandable}
            onClick={() => {
              setExpanded((old) => {
                const next = new Set(old);
                if (open) next.delete(entry.path);
                else next.add(entry.path);
                return next;
              });
              if (!open) void load(entry.path);
            }}
          >
            {node?.loading ? (
              <LoaderCircle size={12} className="spin" />
            ) : (
              <ChevronRight size={12} className={open ? "expanded" : ""} />
            )}
          </button>
          <button
            className="directory-label"
            title={entry.path}
            aria-current={active ? "page" : undefined}
            onClick={() => onNavigate(entry.path)}
          >
            {open ? <FolderOpen size={17} /> : <Folder size={17} />}
            <span>{entry.name}</span>
          </button>
        </div>
        {open && (
          <div role="group">
            {node?.error ? (
              <button
                className="directory-feedback"
                style={{ paddingLeft: 30 + depth * 18 }}
                title={node.error}
                onClick={() => void load(entry.path, true)}
              >
                加载失败，点击重试
              </button>
            ) : node?.children?.length === 0 ? (
              <div
                className="directory-feedback"
                style={{ paddingLeft: 30 + depth * 18 }}
              >
                无子文件夹
              </div>
            ) : (
              node?.children?.map((child) => branch(child, depth + 1))
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      ref={tree}
      role="tree"
      aria-label="共享文件夹目录树"
      className="directory-tree"
    >
      {childDirectories("/", roots).map((e) => branch(e, 0))}
    </div>
  );
}
