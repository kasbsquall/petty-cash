#!/usr/bin/env node
// Keyless verification of a Petty Cash deployment on NEAR testnet.
// Reads public RPC only: who can change the contract, which keys the demo
// server holds, the DAO policy, every budget and every spend, and checks each
// spend against the DAO's own record of its proposal.
//
// Usage: node scripts/verify.mjs [--contract pettycash.testnet] [--dao <dao>.sputnikv2.testnet]

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);

const RPC = args.rpc ?? 'https://test.rpc.fastnear.com';
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

async function query(params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'verify', method: 'query', params: { finality: 'final', ...params } }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${params.request_type} ${params.account_id}: ${JSON.stringify(body.error)}`);
  return body.result;
}

// The function-call keys the demo server signs with (public keys, see README "Demo keys").
const DEMO_KEYS = [
  ['harbor-ana.testnet', 'ed25519:48iUJhTKN6ZsYrDLkF3CpLcnNsBod2qj4HQLfVXBvRuU', 'pettycash.testnet', ['spend']],
  ['harbor-rui.testnet', 'ed25519:YbyT43S7d2ezoJ6EWFbta5E7Z8AQibAyVbiDfsxAMW4', 'pettycash.testnet', ['spend']],
  ['harbor-bot.testnet', 'ed25519:5sfhMmbWPk8ABhaeDbqBHwh8oo4nRKoURAB5QUH5EhLT', 'pettycash.testnet', ['spend']],
  ['harbor-jon.testnet', 'ed25519:GfSw89YWDHMWxofJtvpxh83Vxmm2NcNEok95fMcXvsP2', 'harbor-builders.sputnikv2.testnet', ['act_proposal']],
  ['harbor-ines.testnet', 'ed25519:HV4KnzgZYvnv54wtTCTaYjQNaAyghMwYK6Vidu4evSGU', 'harbor-builders.sputnikv2.testnet', ['act_proposal']],
  ['harbor-jon.testnet', 'ed25519:EXdEPaMukdtU7iq6cmLxKwh79N7W4kSX4qZUNXMu6wDg', 'pettycash.testnet', ['settle']],
];

async function checkTrust() {
  const keys = await query({ request_type: 'view_access_key_list', account_id: CONTRACT });
  check(keys.keys.length === 0, `${CONTRACT} has no access keys, so its code cannot change`, `${keys.keys.length} key(s)`);

  const meta = await view(CONTRACT, 'contract_source_metadata');
  const build = meta.build_info ?? {};
  check(
    /^git\+https:\/\/github\.com\/.+\?rev=[0-9a-f]{40}$/.test(build.source_code_snapshot ?? '') &&
      /@sha256:[0-9a-f]{64}$/.test(build.build_environment ?? ''),
    `${CONTRACT} publishes a reproducible build (NEP-330)`,
    build.source_code_snapshot ?? 'no build_info',
  );

  for (const [account, publicKey, receiver, methods] of DEMO_KEYS) {
    let permission;
    try {
      permission = (await query({ request_type: 'view_access_key', account_id: account, public_key: publicKey })).permission;
    } catch {
      permission = null;
    }
    const call = permission?.FunctionCall;
    check(
      Boolean(call) && call.receiver_id === receiver && JSON.stringify(call.method_names) === JSON.stringify(methods),
      `demo key on ${account} can only call ${methods.join(', ')} on ${receiver}`,
      call ? `${call.receiver_id}: ${call.method_names.join(', ')}` : JSON.stringify(permission),
    );
  }
}

function check(ok, label, detail = '') {
  results[ok ? 'pass' : 'fail'] += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

async function main() {
  await checkTrust();
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
      const expected = { Paid: 'Approved', Rejected: 'Rejected', Escalated: 'InProgress' }[spend.status];
      const byCouncil = spend.status === 'Paid' && spend.reason != null;
      if (spend.status === 'Escalated') {
        check(
          ['InProgress', 'Approved', 'Rejected', 'Removed', 'Expired'].includes(proposal.status),
          `spend ${spend.id} escalated: council decides proposal #${spend.proposal_id}`,
          proposal.status,
        );
      } else if (expected) {
        check(proposal.status === expected, `spend ${spend.id} ${spend.status} and DAO says ${proposal.status}`);
      }
      // A payment the council approved by vote may exceed the caps; one paid inside the rules may not.
      if (spend.status === 'Paid' && !byCouncil) {
        const capOk = BigInt(spend.amount) <= BigInt(budget.rules.per_payment_cap);
        check(capOk, `spend ${spend.id} within the per-payment cap`);
        if (spend.period_index === budget.period_index) paidThisPeriod += BigInt(spend.amount);
      }
    }
    check(
      paidThisPeriod <= BigInt(budget.rules.period_cap),
      `budget ${budget.id}: paid inside the rules this period within the period cap`,
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
