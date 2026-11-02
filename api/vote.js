// POST /api/vote  { proposalId, approve }
// Casts one council vote as a demo council member. It only votes on transfers
// that Petty Cash filed, to a demo receiver, for a demo-sized amount.
import {
  CONTRACT, DAO, MAX_DEMO_AMOUNT, RECEIVERS, TOKEN, TUSD,
  accountFor, panicText, rateLimited, send, view,
} from './_lib.js';

const DEMO_COUNCIL = ['harbor-jon.testnet', 'harbor-ines.testnet'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  if (rateLimited(req)) {
    return send(res, 429, { error: 'Too many demo requests from here. Try again in a few minutes.' });
  }

  const { proposalId, approve } = req.body || {};
  if (!Number.isInteger(proposalId) || proposalId < 0 || typeof approve !== 'boolean') {
    return send(res, 400, { error: 'Pick a payment and a vote.' });
  }

  try {
    const proposal = await view(DAO, 'get_proposal', { id: proposalId });
    const transfer = proposal?.kind?.Transfer;
    const eligible =
      transfer &&
      proposal.proposer === CONTRACT &&
      proposal.status === 'InProgress' &&
      transfer.token_id === TOKEN &&
      RECEIVERS.includes(transfer.receiver_id) &&
      BigInt(transfer.amount) <= BigInt(MAX_DEMO_AMOUNT) * TUSD;
    if (!eligible) return send(res, 400, { error: 'The demo council only votes on open Petty Cash payments.' });

    const voter = DEMO_COUNCIL.find((m) => !(m in (proposal.votes || {})));
    if (!voter) return send(res, 409, { error: 'Every demo council member already voted on this one.' });

    const outcome = await accountFor(voter).callFunctionRaw({
      contractId: DAO,
      methodName: 'act_proposal',
      args: { id: proposalId, action: approve ? 'VoteApprove' : 'VoteReject', proposal: proposal.kind },
      gas: 200_000_000_000_000n,
      waitUntil: 'FINAL',
    });
    const after = await view(DAO, 'get_proposal', { id: proposalId });
    return send(res, 200, { txHash: outcome.transaction.hash, voter, proposal: after });
  } catch (err) {
    const reason = panicText(err);
    console.error('vote failed', err);
    return send(res, reason ? 400 : 502, {
      error: reason || 'NEAR testnet did not answer. Try again in a moment.',
    });
  }
}
