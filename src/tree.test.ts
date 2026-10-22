import { expect, test } from "vitest";
import { directoryChain, childDirectories } from "./tree";
test("deep navigation preserves every ancestor including english", () => {
  expect(directoryChain("/video/english/Color Blocks")).toEqual([
    "/video",
    "/video/english",
    "/video/english/Color Blocks",
  ]);
  expect(directoryChain("/")).toEqual([]);
});
test("children cannot be flattened under their grandparent and are not limited to six", () => {
  const entries = Array.from({ length: 9 }, (_, i) => ({
    name: `Folder ${9 - i}`,
    path: `/video/english/Folder ${9 - i}`,
    isdir: true,
  }));
  expect(childDirectories("/video", entries)).toEqual([]);
  expect(childDirectories("/video/english", entries)).toHaveLength(9);
  expect(childDirectories("/video/english", entries)[0].name).toBe("Folder 1");
  expect(
    childDirectories("/video/english", [
      { name: "movie.mp4", path: "/video/english/movie.mp4", isdir: false },
    ]),
  ).toEqual([]);
});
