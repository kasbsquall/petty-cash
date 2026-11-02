// Read-only access to NEAR testnet through public RPC. No wallet, no keys.
// The official endpoint answers 429 under load, so FastNear goes first.
export const RPCS = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
export const CONTRACT = 'pettycash.testnet';
export const DAO = 'harbor-builders.sputnikv2.testnet';
export const TOKEN = 'tusd-pettycash.testnet';
export const EXPLORER = 'https://testnet.nearblocks.io';

async function query(rpc, accountId, method, args) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'pettycash',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'optimistic',
        account_id: accountId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = await res.json();
  if (body.error || body.result?.error) throw new Error(`${accountId}.${method} failed`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result)));
}

export async function view(accountId, method, args = {}) {
  let last;
  for (const rpc of RPCS) {
    try { return await query(rpc, accountId, method, args); } catch (err) { last = err; }
  }
  throw last;
}

export async function post(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'The demo server did not answer. Try again in a moment.');
  return body;
}

// Loads everything the budget page shows, in parallel where it can.
export async function loadDemo() {
  const [budgets, policy, balance] = await Promise.all([
    view(CONTRACT, 'list_budgets', { dao: DAO }),
    view(DAO, 'get_policy'),
    view(TOKEN, 'ft_balance_of', { account_id: DAO }),
  ]);
  const spendLists = await Promise.all(
    budgets.map((b) => view(CONTRACT, 'list_spends', { budget_id: b.id, limit: 200 })),
  );
  const spends = spendLists.flat();
  const open = spends.filter((s) => s.status === 'Escalated' && s.proposal_id != null);
  const proposals = await Promise.all(open.map((s) => view(DAO, 'get_proposal', { id: s.proposal_id })));
  const council = policy.roles.find((r) => r.name === 'council')?.kind?.Group ?? [];
  return {
    budgets,
    spends,
    proposals: Object.fromEntries(proposals.map((p) => [p.id, p])),
    council,
    balance: BigInt(balance),
  };
}
