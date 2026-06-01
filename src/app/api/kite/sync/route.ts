import { syncAccount, syncAllAccounts } from "@/lib/kite/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Re-pull holdings for one account (POST { accountId }) or all accounts
 * (no body). Used by the "Sync now" button and the India agent loop.
 */
export async function POST(req: Request) {
  let accountId: string | undefined;
  try {
    const body = (await req.json()) as { accountId?: string };
    accountId = body.accountId;
  } catch {
    // no body → sync all
  }

  try {
    if (accountId) {
      const result = await syncAccount(accountId);
      return Response.json({ result });
    }
    const results = await syncAllAccounts();
    return Response.json({ results });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
