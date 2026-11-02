#!/usr/bin/env node
// Keyless verification of a Petty Cash deployment on NEAR testnet.
// Reads public RPC only: the DAO policy, every budget and every spend, and
// checks each spend against the DAO's own record of its proposal.
//
// Usage: node scripts/verify.mjs [--contract pettycash.testnet] [--dao <dao>.sputnikv2.testnet]

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);

const RPC = args.rpc ?? 'https://rpc.testnet.near.org';
const CONTRACT = args.contract ?? 'pettycash.testnet';
const DAO = args.dao ?? 'harbor-builders.sputnikv2.testnet';

const results = { pass: 0, fail: 0 };

async function view(accountId, method, params = {}) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'verify',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: accountId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(params)).toString('base64'),
      },
    }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) {
    throw new Error(`${accountId}.${method}: ${JSON.stringify(body.error ?? body.result.error)}`);
  }
  return JSON.parse(Buffer.from(body.result.result).toString('utf8'));
}

function check(ok, label, detail = '') {
  results[ok ? 'pass' : 'fail'] += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

async function main() {
  console.log(`Petty Cash verification\ncontract ${CONTRACT}\ndao      ${DAO}\nrpc      ${RPC}\n`);

  const policy = await view(DAO, 'get_policy');
  const keeperRole = policy.roles.find((r) => r.kind?.Group?.includes(CONTRACT));
  check(Boolean(keeperRole), 'the DAO has a role whose member is the Petty Cash contract');
  if (keeperRole) {
    check(keeperRole.kind.Group.length === 1, 'that role has a single member', keeperRole.kind.Group.join(', '));
    const perms = [...keeperRole.permissions].sort().join(', ');
    check(
      perms === 'transfer:AddProposal, transfer:VoteApprove',
      'the role can only add and approve transfer proposals',
      perms,
    );
  }

  const budgets = await view(CONTRACT, 'list_budgets', { dao: DAO });
  check(budgets.length > 0, 'the DAO has budgets', `${budgets.length}`);

  for (const budget of budgets) {
    const spends = await view(CONTRACT, 'list_spends', { budget_id: budget.id, limit: 200 });
    console.log(`\nBudget ${budget.id} "${budget.rules.name}", ${spends.length} spends`);
    let paidThisPeriod = 0n;
    for (const spend of spends) {
      if (spend.proposal_id == null) {
        check(spend.status === 'Failed', `spend ${spend.id} without proposal is Failed`, spend.status);
        continue;
      }
      const proposal = await view(DAO, 'get_proposal', { id: spend.proposal_id });
      const transfer = proposal.kind?.Transfer;
      const matches =
        transfer &&
        transfer.receiver_id === spend.receiver_id &&
        transfer.amount === spend.amount &&
        (transfer.token_id || null) === (budget.rules.token ?? null) &&
        proposal.proposer === CONTRACT;
      check(Boolean(matches), `spend ${spend.id} matches DAO proposal #${spend.proposal_id}`);
      const expected = { Paid: 'Approved', Escalated: 'InProgress' }[spend.status];
      if (spend.status === 'Escalated') {
        check(
          ['InProgress', 'Approved', 'Rejected', 'Removed', 'Expired'].includes(proposal.status),
          `spend ${spend.id} escalated: council decides proposal #${spend.proposal_id}`,
          proposal.status,
        );
      } else if (expected) {
        check(proposal.status === expected, `spend ${spend.id} ${spend.status} and DAO says ${proposal.status}`);
      }
      if (spend.status === 'Paid') {
        const capOk = BigInt(spend.amount) <= BigInt(budget.rules.per_payment_cap);
        check(capOk, `spend ${spend.id} within the per-payment cap`);
        if (spend.period_index === budget.period_index) paidThisPeriod += BigInt(spend.amount);
      }
    }
    check(
      paidThisPeriod <= BigInt(budget.rules.period_cap),
      `budget ${budget.id}: paid this period within the period cap`,
      `${paidThisPeriod} of ${budget.rules.period_cap}`,
    );
  }

  console.log(`\n${results.pass} passed, ${results.fail} failed`);
  process.exit(results.fail ? 1 : 0);
}

main().catch((err) => {
  console.error(`ERROR ${err.message}`);
  process.exit(2);
});
