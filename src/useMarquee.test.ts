import { expect, test } from "vitest";
import { intersects } from "./useMarquee";
test("marquee selects partial overlaps but not adjacent or outside items", () => {
  const item = { left: 100, top: 100, right: 200, bottom: 200 };
  expect(intersects(item, { left: 90, top: 90, right: 110, bottom: 110 })).toBe(
    true,
  );
  expect(intersects(item, { left: 90, top: 90, right: 100, bottom: 100 })).toBe(
    false,
  );
  expect(intersects(item, { left: 0, top: 0, right: 300, bottom: 300 })).toBe(
    true,
  );
  expect(intersects(item, { left: 220, top: 0, right: 250, bottom: 300 })).toBe(
    false,
  );
});
