// POST /api/spend  { budgetId, amount, category, memo, receiver }
// Signs `spend` as the budget's demo holder and reports what the contract did.
import {
  CONTRACT, MAX_DEMO_AMOUNT, RECEIVERS, TUSD,
  accountFor, logsOf, panicText, rateLimited, send, view,
} from './_lib.js';

const DEMO_HOLDERS = ['harbor-ana.testnet', 'harbor-rui.testnet', 'harbor-bot.testnet'];

function parseAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, cents = ''] = text.split('.');
  const units = BigInt(whole) * TUSD + BigInt(cents.padEnd(2, '0')) * (TUSD / 100n);
  if (units <= 0n || units > BigInt(MAX_DEMO_AMOUNT) * TUSD) return null;
  return units;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  if (rateLimited(req)) {
    return send(res, 429, { error: 'Too many demo requests from here. Try again in a few minutes.' });
  }

  const { budgetId, amount, category, memo, receiver } = req.body || {};
  const units = parseAmount(amount);
  if (!Number.isInteger(budgetId) || budgetId < 0) return send(res, 400, { error: 'Pick a budget.' });
  if (units === null) {
    return send(res, 400, { error: `Type an amount between $0.01 and $${MAX_DEMO_AMOUNT}.` });
  }
  if (!RECEIVERS.includes(receiver)) return send(res, 400, { error: 'Pick one of the demo receivers.' });
  const cleanMemo = String(memo ?? '').trim().slice(0, 140);
  if (!cleanMemo) return send(res, 400, { error: 'Say what the payment is for.' });

  try {
    const budget = await view(CONTRACT, 'get_budget', { budget_id: budgetId });
    const holder = budget?.rules.holders.find((h) => DEMO_HOLDERS.includes(h));
    if (!holder) return send(res, 400, { error: 'That budget has no demo holder.' });
    if (!budget.rules.categories.includes(category)) {
      return send(res, 400, { error: 'Pick one of the budget categories.' });
    }

    const outcome = await accountFor(holder).callFunctionRaw({
      contractId: CONTRACT,
      methodName: 'spend',
      args: {
        budget_id: budgetId,
        receiver_id: receiver,
        amount: units.toString(),
        category,
        memo: cleanMemo,
      },
      gas: 300_000_000_000_000n,
      waitUntil: 'FINAL',
    });

    const logs = logsOf(outcome);
    const idLog = logs.map((l) => l.match(/^spend (\d+) /)).find(Boolean);
    const spend = idLog ? await view(CONTRACT, 'get_spend', { spend_id: Number(idLog[1]) }) : null;
    return send(res, 200, {
      txHash: outcome.transaction.hash,
      holder,
      spend,
    });
  } catch (err) {
    const reason = panicText(err);
    console.error('spend failed', err);
    return send(res, reason ? 400 : 502, {
      error: reason || 'NEAR testnet did not answer. Try again in a moment.',
    });
  }
}
