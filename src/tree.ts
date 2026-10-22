import type { Entry } from "./model";

export function directoryChain(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, i) => "/" + parts.slice(0, i + 1).join("/"));
}

export function childDirectories(path: string, entries: Entry[]): Entry[] {
  return entries
    .filter(
      (e) =>
        e.isdir && (e.path.slice(0, e.path.lastIndexOf("/")) || "/") === path,
    )
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}
