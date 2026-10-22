import { invoke } from "@tauri-apps/api/core";
import type { Entry } from "./model";
export const imageExtensions = new Set(
  "jpg jpeg jpe png gif webp bmp avif heic heif tif tiff arw cr2 cr3 nef dng raw raf orf rw2 svg".split(
    " ",
  ),
);
const videoExtensions = new Set(
  "mp4 mkv mov avi webm m4v wmv flv mpg mpeg mts m2ts ts 3gp ogv hevc rm rmvb".split(
    " ",
  ),
);
export function mediaKind(entry: Entry) {
  if (entry.isdir) return null;
  const ext = entry.name.split(".").pop()?.toLowerCase() || "";
  return imageExtensions.has(ext)
    ? "image"
    : videoExtensions.has(ext)
      ? "video"
      : null;
}
export type MediaResult = { dataUrl: string; original: boolean };
const cache = new Map<string, MediaResult>();
let cacheBytes = 0;
let generation = 0;
const pending = new Map<string, Promise<MediaResult>>();
export function clearMediaCache() {
  generation++;
  cache.clear();
  pending.clear();
  cacheBytes = 0;
}
export function getMedia(
  id: string,
  entry: Entry,
  preview = false,
): Promise<MediaResult> {
  const key = JSON.stringify([
    generation,
    id,
    entry.path,
    entry.additional?.time?.mtime,
    entry.additional?.size,
    preview,
  ]);
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return Promise.resolve(existing);
  }
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const epoch = generation;
  const task = invoke<MediaResult>("load_media", {
    id,
    path: entry.path,
    preview,
  })
    .then((result) => {
      // Only thumbnails are retained. Closing the viewer releases the original image.
      if (!preview && epoch === generation) {
        while (
          cache.size >= 80 ||
          cacheBytes + result.dataUrl.length > 20 * 1024 * 1024
        ) {
          const oldest = cache.keys().next().value;
          if (!oldest) break;
          cacheBytes -= cache.get(oldest)!.dataUrl.length;
          cache.delete(oldest);
        }
        cache.set(key, result);
        cacheBytes += result.dataUrl.length;
      }
      return result;
    })
    .finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
