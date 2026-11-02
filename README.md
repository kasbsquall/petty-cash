# Petty Cash

Budgets with rules for a Sputnik DAO. The council approves a budget once; payments inside the rules are paid from the DAO in seconds; anything else becomes a normal council vote. The money never leaves the DAO until a payment goes out.

Built at NEAR HACKATHON (November 2026). Tracks: Social Money, Real-World Money.

> Status: work in progress. Sections marked TODO are filled before submission.

## The problem

A community DAO on Sputnik needs the same council vote for a $40 pizza reimbursement as for a $40,000 grant, because Sputnik's approval threshold does not depend on the amount (`sputnikdao2/src/policy.rs`, `proposal_status`). Community organizers wait days for small payments, and someone writes the monthly spending report by hand.

## What Petty Cash does

1. The DAO installs Petty Cash once: a `pettycash` role whose only member is the Petty Cash contract, allowed to add and approve `transfer` proposals.
2. The DAO creates a budget with a normal `FunctionCall` proposal: holders, cap per payment, cap per period, period length, categories, end date, token.
3. A holder calls `spend`. Inside the rules, the contract files a `Transfer` proposal on the DAO and approves it in the same call chain, then reads the proposal back and marks the spend `Paid` only if the DAO reports it `Approved`.
4. Outside the rules, the contract files the proposal and leaves it for the council, with the reason in the description.
5. Every spend is recorded with its proposal id, so the monthly report writes itself.

The contract never holds the budget. The only NEAR it holds is each DAO's bond pool, which pays proposal bonds and the storage of that DAO's records.

## Try it in 2 minutes

TODO: live URL and guided demo steps ("do X, see Y").

## Verify on testnet without keys

Needs Node 18 or later. No keys, no wallet, no install.

```bash
npm run verify
```

It reads the demo DAO `harbor-builders.sputnikv2.testnet` and the contract `pettycash.testnet` from public RPC and checks:

- the DAO has a `pettycash` role with a single member, the contract, allowed only to add and approve transfer proposals;
- every spend matches its DAO proposal (receiver, amount, token, proposer);
- every spend marked paid has a proposal the DAO reports `Approved`, and every escalated spend has a proposal left for the council;
- paid amounts stay inside the per-payment cap and the period cap.

Expected on the demo DAO: `24 passed, 0 failed`. To check another deployment: `node scripts/verify.mjs --contract <contract> --dao <dao>.sputnikv2.testnet`.

`scripts/seed-testnet.sh` rebuilds the whole demo (contract, tUSD, DAO, role, budgets, spends) step by step with near-cli-rs.

## Run the tests

```bash
cd contract
cargo test
```

Expected: 18 tests pass, including a non-holder trying to spend, another DAO trying to change a budget, a paused budget, the period cap counting reserved amounts, and a vote that does not approve the proposal.

## Repository

| Path | What it is |
| --- | --- |
| `contract/` | Petty Cash contract (Rust, near-sdk 5.29) |
| `test-usd/` | tUSD, a test-only NEP-141 token with no value, used so demo amounts read as dollars |

## Limitations

- The `pettycash` role must have a single member. With two members and a 1/1 threshold, Sputnik needs both votes; the contract then leaves the spend for the council instead of marking it paid (found on testnet, see tests).
- `Paid` means the DAO reported the proposal `Approved` right after the vote. Sputnik executes the transfer in a later receipt; if that transfer fails, Sputnik marks the proposal `Failed`. The verifier re-reads the final status.
- Testnet only. Amounts in the demo are tUSD, test dollars with no value.

## Built with

near-sdk 5.29, near-contract-standards 5.29, cargo-near 0.22.0, near-cli-rs 0.30.1, Sputnik DAO v2 (factory `sputnikv2.testnet`). Written with Claude Code.

## License

MIT
