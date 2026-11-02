# Petty Cash

A community group pays $40 for pizza at its meetup. Today, if the group keeps its money in a DAO, the whole council has to vote on that $40 the same way it votes on a $40,000 grant, and the organizer waits days to be paid back.

Petty Cash lets the group's council approve a budget once, with rules: who can spend, how much per payment, how much per month, on what, until when. After that, a payment inside the rules is paid from the group's treasury in seconds. Anything outside the rules goes to a normal council vote. The money stays in the treasury until a payment goes out, and the monthly spending report comes from the records.

On NEAR, the treasury is a Sputnik DAO and Petty Cash is a contract the DAO installs with two ordinary proposals. A holder can be a person or an AI agent: the agent's key can only ask Petty Cash for a payment, and the rules decide the rest.

- Live demo (NEAR testnet, no wallet needed): https://petty-cash-ochre.vercel.app
- Repository: https://github.com/kasbsquall/petty-cash
- Built at NEAR HACKATHON, 1 to 14 November 2026. Tracks: Social Money (`social`), Real-World Money (`realworld`).
- Contract: `pettycash.testnet`. Demo DAO: `harbor-builders.sputnikv2.testnet`. Test token: `tusd-pettycash.testnet`.

## The problem

A community DAO on Sputnik asks its council for the same vote on a $40 pizza reimbursement as on a $40,000 grant, because Sputnik's approval threshold depends on the proposal kind and the role, never on the amount (`sputnikdao2/src/policy.rs`, `Policy::proposal_status`). The person who runs the meetups waits days to be paid back, council members vote on dozens of small payments, and someone writes the monthly spending report by hand.

## What Petty Cash does

1. The DAO installs Petty Cash once, with a normal policy proposal: a role named `pettycash` whose only member is the Petty Cash contract, allowed only to add and approve `transfer` proposals.
2. The DAO creates a budget with a normal `FunctionCall` proposal: who can spend (holders), a cap per payment, a cap per period, the period length, allowed categories, an end date, and the token.
3. A holder calls `spend`. Petty Cash checks the rules on chain.
4. Inside the rules: Petty Cash files a `Transfer` proposal on the DAO, approves it with its role, reads the proposal back, and marks the payment `Paid` only if the DAO reports `Approved`. Sputnik sends the money from the DAO.
5. Outside the rules: Petty Cash files the same `Transfer` proposal with the reason in its description and leaves it for the council. It is an ordinary Sputnik proposal, so the council votes on it as usual.
6. When the council decides an escalated payment, anyone can call `settle`: Petty Cash reads the proposal and records it as paid by council vote (counted in the budget) or rejected.
7. Every payment is recorded with its category, memo and DAO proposal id, so the monthly report comes from chain data.

Petty Cash never holds the budget. The only NEAR it holds is each DAO's bond pool, which pays the proposal bonds, the token storage registration of new receivers, and the storage of that DAO's own records.

## Try it in 2 minutes

Open https://petty-cash-ochre.vercel.app in any browser. You act as a budget holder of Harbor Builders, a demo community on NEAR testnet. Every action below sends a real testnet transaction, signed by the demo server with keys that can only call Petty Cash (see "Demo keys").

1. Look at the left card. See: the Meetups budget, what is left this period, what was spent, and its rules in plain words. The same numbers come from `get_budget` on `pettycash.testnet`.
2. In "Request a payment", type `40` in Amount and `Pizza for the meetup` in "What it is for". See: the rule check turns green ("Inside the rules") with each rule ticked.
3. Click "Pay $40 now". See, in about 3 to 5 seconds: the Meetups gate on the model opens, a green notice "Paid $40 to ... from the DAO, proposal #N" with a link to the transaction, the amount left goes down by 40, and a new payment appears in the channel at the bottom marked "Paid inside the rules".
4. Type `600` in Amount. See: the check turns orange, "Above the $250 per-payment cap", and the button changes to "Send $600 to a council vote". Click it. See: "Above the per-payment cap. $600 stays in the DAO until 2 of 3 approve, proposal #N", and the Council votes counter goes up by one. No money moved.
5. Open "Council votes". You act as a council member. Click "Approve" on a payment. See: "Your vote is in" signed by a demo council account, and the vote count on that payment goes up. With 2 of 3 approvals the DAO pays it, the demo calls `settle`, and the payment shows as "Paid after council vote" and counts in the budget.
6. Click "Monthly report". See: a CSV with every payment, its budget, category, receiver, status, DAO proposal id and transaction.

To check any of this on an explorer, open https://testnet.nearblocks.io/address/harbor-builders.sputnikv2.testnet and look at the tUSD transfers going out of the DAO.

## Verify on testnet without keys

Needs Node 20 or later. No keys, no wallet.

```bash
git clone https://github.com/kasbsquall/petty-cash
cd petty-cash
npm run verify
```

It reads the demo DAO and the contract from public RPC (FastNear, `https://test.rpc.fastnear.com`) and checks:

- `pettycash.testnet` has no access keys, so nobody can redeploy it, and it publishes the commit and Docker image it was built from (NEP-330);
- each key the demo server signs with is a function-call key limited to the one method listed under "Demo keys";
- the DAO has a `pettycash` role with a single member, the contract, allowed only to add and approve transfer proposals;
- every payment matches its DAO proposal (receiver, amount, token, proposer);
- every payment marked paid has a proposal the DAO reports `Approved`, every rejected one a proposal the DAO reports `Rejected`, and every escalated one a proposal left for the council;
- payments paid inside the rules stay inside the per-payment cap and the period cap (a payment the council approved by vote may exceed them).

Expected: every line starts with `PASS` and the last line ends with `0 failed`. The number of checks grows as people use the demo. To check another deployment: `node scripts/verify.mjs --contract <contract> --dao <dao>.sputnikv2.testnet`.

To check that the deployed code is the code in this repository, rebuild it (needs Docker and cargo-near 0.21.1) and compare hashes:

```bash
cd contract
cargo near build reproducible-wasm
```

The build prints a `SHA-256 checksum bs58`. It must equal the `code_hash` that `view_account` returns for `pettycash.testnet`: `pmAvCz2Mo44AyS8jNXfgEbT6xT2wsErucTXDawZbqu5`, built from commit `08bd115` in `sourcescan/cargo-near:0.21.1-rust-1.96.0`. The contract source has not changed since that commit.

## Run the tests

Needs Rust and the `wasm32-unknown-unknown` target only for building; the tests run natively.

```bash
cd contract
cargo test
```

Expected: `test result: ok. 24 passed; 0 failed`. The tests cover a non-holder trying to spend, another DAO and a holder trying to change a budget, a paused budget, a category outside the list, the period cap counting payments still in flight, a new period resetting the spent amount, an empty bond pool, inconsistent rules, a token budget paying the receiver's storage registration from the pool, a keeper vote that does not approve the proposal, and `settle` after a council approval, a rejection, a removal, an undecided vote and a vote in a later period.

## Install it on your own DAO (testnet)

`scripts/seed-testnet.sh` does every step below for the demo with near-cli-rs 0.30. In short, for a DAO `<dao>.sputnikv2.testnet`:

1. A council member proposes `ChangePolicyAddOrUpdateRole` with role `pettycash`, kind `{"Group":["pettycash.testnet"]}`, permissions `["transfer:AddProposal","transfer:VoteApprove"]` and vote policy `{"transfer":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,1]}}`. The council approves it.
2. A council member proposes a `FunctionCall` to `pettycash.testnet`, method `create_budget`, with the budget rules as arguments and a deposit (for example 1 NEAR) that becomes the DAO's bond pool. The council approves it.
3. If the budget is in a token, the DAO must hold that token. Holders can now call `spend`.

`create_budget`, `update_budget` and `set_paused` only accept calls from the DAO itself, so every change to a budget is a council decision. `fund_pool` tops up the bond pool.

## How the pieces fit

| Piece | Where | What it does |
| --- | --- | --- |
| Petty Cash contract | `contract/src/lib.rs` | Budgets, rule checks (`rule_violation`), the call chain `add_proposal` then `act_proposal` then `get_proposal`, and settlement in `on_checked` |
| tUSD | `test-usd/src/lib.rs` | Test-only NEP-141 token, 6 decimals, no value, so demo amounts read as dollars |
| Web | `index.html`, `src/` | Static page that reads everything from public RPC |
| Demo server | `api/spend.js`, `api/vote.js` | Vercel functions that sign demo requests with function-call keys |
| Verifier | `scripts/verify.mjs` | Keyless check of the demo DAO against the contract |
| Seed script | `scripts/seed-testnet.sh` | Rebuilds the whole demo on testnet |

## Demo keys

The demo server holds function-call access keys, never full-access keys:

- `harbor-ana.testnet`, `harbor-rui.testnet`, `harbor-bot.testnet` (the budget holders): only `spend` on `pettycash.testnet`.
- `harbor-jon.testnet`, `harbor-ines.testnet` (two of the three council members): only `act_proposal` on `harbor-builders.sputnikv2.testnet`.

- A second key on `harbor-jon.testnet`: only `settle` on `pettycash.testnet`.

The server also refuses receivers outside a fixed list of demo accounts, amounts above 1,000 tUSD, and votes on anything other than an open `Transfer` proposal filed by Petty Cash. The `harbor-bot.testnet` holder stands for an AI agent: its key can only ask Petty Cash for a payment, and the budget rules decide the rest.

This is a public demo on purpose: anyone who opens it acts as the holder and as two of the three council members, so anyone can move the demo DAO's test dollars to the demo receivers, one request at a time, with a best-effort per-visitor rate limit. It holds tUSD, a token with no value, and the seed script can refill it.

## Trust model

- Custody stays with the DAO. Petty Cash cannot move money by itself: it can only file a `Transfer` proposal and cast the vote of its role, and Sputnik executes the transfer.
- At the Sputnik level, the `pettycash` role can approve any transfer of any amount. The budget rules live in the Petty Cash contract, so the code of `pettycash.testnet` is what a DAO trusts when it installs the role. A DAO can remove the role at any time with one policy proposal.
- Who can change that code: nobody. `pettycash.testnet` was deployed from a reproducible build (its `contract_source_metadata` links the exact commit and Docker image) and its last full-access key was deleted, so the code can never change. Check it yourself: `view_access_key_list` on `pettycash.testnet` returns no keys, and `npm run verify` checks it too. A fix would mean a new contract account and a policy proposal in each DAO to point the role at it.

## Limitations

- The `pettycash` role must have exactly one member. With two members and a 1/1 threshold, Sputnik needs both votes; Petty Cash then reads the proposal back, sees it still `InProgress`, and leaves the payment for the council instead of marking it paid. This was found on testnet and is covered by a test.
- `Paid` means the DAO reported the proposal `Approved` right after the vote. Sputnik executes the transfer in a later receipt; if that transfer fails, Sputnik marks the proposal `Failed`. The verifier reads the final status.
- Each escalated payment locks one proposal bond from the DAO's pool until the council finalizes it. The demo DAO lowered its bond to 0.1 NEAR.
- Sputnik does not notify Petty Cash when the council decides an escalated payment. Until someone calls `settle`, the budget does not count it; the web and the CSV already read the decision from the DAO. The demo calls `settle` right after the deciding vote.
- Testnet only. Demo amounts are tUSD, test dollars with no value. Harbor Builders is a demo community, not a real one.

## Built with

near-sdk 5.29, near-contract-standards 5.29, cargo-near 0.21.1, near-cli-rs 0.30.1, near-api-js 7.4.0, Vite 8.3.5, Sputnik DAO v2 (factory `sputnikv2.testnet`), FastNear RPC, Phosphor Icons, Libre Franklin (OFL), interface sounds by Kenney (CC0). The 3D model of the reservoir was generated with Google's Nano Banana. All code in this repository was written during the hackathon, with Claude Code as the coding assistant.

## License

MIT, see `LICENSE`.
