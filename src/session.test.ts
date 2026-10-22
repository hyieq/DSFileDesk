import { describe, it, expect, vi } from "vitest";
import { restoreSession } from "./session";
import { blankAccount } from "./model";
const first = { ...blankAccount, id: "first" };
const last = { ...blankAccount, id: "last" };
describe("startup session", () => {
  it("restores only the last used account", async () => {
    const connect = vi.fn().mockResolvedValue("last");
    expect(
      (await restoreSession([first, last], "last", connect)).connectedId,
    ).toBe("last");
    expect(connect).toHaveBeenCalledExactlyOnceWith(last);
  });
  it("falls back to the first account when the saved account was removed", async () => {
    const connect = vi.fn().mockResolvedValue("first");
    await restoreSession([first], "removed", connect);
    expect(connect).toHaveBeenCalledExactlyOnceWith(first);
  });
  it("does not log in without accounts or remembered credentials", async () => {
    const connect = vi.fn();
    expect(await restoreSession([], null, connect)).toEqual({
      account: undefined,
    });
    const account = { ...first, remember: false };
    expect(await restoreSession([account], null, connect)).toEqual({ account });
    expect(connect).not.toHaveBeenCalled();
  });
  it("returns the failed account for manual login without retrying other accounts", async () => {
    const connect = vi.fn().mockRejectedValue("需要验证码");
    expect(await restoreSession([first, last], "last", connect)).toEqual({
      account: last,
      error: "需要验证码",
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
