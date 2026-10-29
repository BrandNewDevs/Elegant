import { expect, it } from "vitest";
import { formatDay, groupByDay } from "./format";

const now = new Date(2026, 9, 29, 14, 0); // Thursday 29 October 2026, local time
const at = (daysAgo: number, hour = 10) => new Date(2026, 9, 29 - daysAgo, hour).toISOString();

it("names today and yesterday, then the weekday for the rest of the week, then the date", () => {
  expect(formatDay(at(0, 1), now)).toBe("Today");
  expect(formatDay(at(0, 23), now)).toBe("Today");
  expect(formatDay(at(1, 23), now)).toBe("Yesterday");
  expect(formatDay(at(3), now)).toBe(new Date(2026, 9, 26).toLocaleDateString(undefined, { weekday: "long" }));
  expect(formatDay(at(10), now)).toBe(new Date(2026, 9, 19).toLocaleDateString(undefined, { day: "numeric", month: "short" }));
  expect(formatDay(new Date(2025, 11, 31).toISOString(), now)).toContain("2025"); // another year says so
});

it("starts a new group whenever the day changes, keeping the order", () => {
  const items = [{ startedAt: at(0, 12), id: 1 }, { startedAt: at(0, 9), id: 2 }, { startedAt: at(1), id: 3 }, { startedAt: at(0, 8), id: 4 }];
  expect(groupByDay(items, now).map((g) => [g.day, g.items.map((i) => i.id)])).toEqual([["Today", [1, 2]], ["Yesterday", [3]], ["Today", [4]]]);
  expect(groupByDay([], now)).toEqual([]);
});
