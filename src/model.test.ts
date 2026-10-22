import { expect, test } from "vitest";
import { sortedEntries, parent, size } from "./model";
test("sorting keeps directories first and sorts numbered filenames naturally", () => {
  const entries = [
    { name: "10.txt", path: "/10.txt", isdir: false },
    { name: "2.txt", path: "/2.txt", isdir: false },
    { name: "Z", path: "/Z", isdir: true },
  ];
  expect(sortedEntries(entries, "", "name", true).map((e) => e.name)).toEqual([
    "Z",
    "2.txt",
    "10.txt",
  ]);
  expect(
    sortedEntries(entries, "TXT", "name", false).map((e) => e.name),
  ).toEqual(["10.txt", "2.txt"]);
});
test("root navigation and byte display", () => {
  expect(parent("/home")).toBe("/");
  expect(parent("/home/docs")).toBe("/home");
  expect(size(1024)).toBe("1.0 KB");
});
