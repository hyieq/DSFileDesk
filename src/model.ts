export type Account = {
  id: string;
  name: string;
  address: string;
  username: string;
  mode: string;
  fallback: string;
  insecure: boolean;
  remember: boolean;
};
export type Entry = {
  name: string;
  path: string;
  isdir: boolean;
  additional?: { size?: number; time?: { mtime?: number }; type?: string };
};
export type Transfer = {
  id: string;
  name: string;
  direction: "upload" | "download";
  done: number;
  total: number;
  status: "running" | "done" | "error";
  error?: string;
};
export const blankAccount: Account = {
  id: "",
  name: "",
  address: "",
  username: "",
  mode: "direct",
  fallback: "",
  insecure: false,
  remember: true,
};
export function size(bytes = 0): string {
  if (bytes === 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}
export function parent(path: string) {
  return path.split("/").slice(0, -1).join("/") || "/";
}
export function sortedEntries(
  entries: Entry[],
  query: string,
  sort: string,
  ascending: boolean,
) {
  return entries
    .filter((e) =>
      e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    )
    .sort((a, b) => {
      if (a.isdir !== b.isdir) return a.isdir ? -1 : 1;
      const n =
        sort === "size"
          ? (a.additional?.size || 0) - (b.additional?.size || 0)
          : sort === "time"
            ? (a.additional?.time?.mtime || 0) -
              (b.additional?.time?.mtime || 0)
            : a.name.localeCompare(b.name, "zh-CN", { numeric: true });
      return n * (ascending ? 1 : -1);
    });
}
