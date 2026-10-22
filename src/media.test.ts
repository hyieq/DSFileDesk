import { expect, test, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { clearMediaCache, getMedia, mediaKind } from "./media";
const entry = {
  name: "照片.JPG",
  path: "/photo/照片.JPG",
  isdir: false,
  additional: { time: { mtime: 1 } },
};
test("recognizes media case-insensitively but never treats folders as media", () => {
  expect(mediaKind(entry)).toBe("image");
  expect(mediaKind({ ...entry, name: "电影.MKV" })).toBe("video");
  expect(mediaKind({ ...entry, isdir: true })).toBeNull();
  expect(mediaKind({ ...entry, name: "说明.txt" })).toBeNull();
});
test("thumbnail requests are deduplicated and isolated by account, version and purpose", async () => {
  clearMediaCache();
  vi.mocked(invoke)
    .mockReset()
    .mockResolvedValue({ dataUrl: "data:image/png;base64,a", original: false });
  await Promise.all([getMedia("A", entry), getMedia("A", entry)]);
  expect(invoke).toHaveBeenCalledTimes(1);
  await getMedia("A", entry);
  expect(invoke).toHaveBeenCalledTimes(1);
  await getMedia("B", entry);
  await getMedia("A", { ...entry, additional: { time: { mtime: 2 } } });
  await getMedia("A", entry, true);
  expect(invoke).toHaveBeenCalledTimes(4);
  clearMediaCache();
  await getMedia("A", entry);
  expect(invoke).toHaveBeenCalledTimes(5);
});
test("failed thumbnail requests can be retried", async () => {
  clearMediaCache();
  vi.mocked(invoke)
    .mockReset()
    .mockRejectedValueOnce("NAS unavailable")
    .mockResolvedValueOnce({
      dataUrl: "data:image/png;base64,a",
      original: false,
    });
  await expect(getMedia("A", entry)).rejects.toBe("NAS unavailable");
  await getMedia("A", entry);
  expect(invoke).toHaveBeenCalledTimes(2);
});
