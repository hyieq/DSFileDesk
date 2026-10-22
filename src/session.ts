import type { Account } from "./model";

// Only the last-used account is restored; a failure never tries other accounts.
export async function restoreSession(
  accounts: Account[],
  lastId: string | null,
  connect: (account: Account) => Promise<string>,
): Promise<{ account?: Account; connectedId?: string; error?: string }> {
  const account = accounts.find((a) => a.id === lastId) || accounts[0];
  if (!account?.remember) return { account };
  try {
    return { account, connectedId: await connect(account) };
  } catch (error) {
    return { account, error: String(error) };
  }
}
