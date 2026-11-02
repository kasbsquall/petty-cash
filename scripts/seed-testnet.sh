#!/usr/bin/env bash
# Seeds the Petty Cash demo on NEAR testnet: contract, tUSD, the Harbor Builders
# demo DAO, its council, the Petty Cash role and three budgets.
# Requires near-cli-rs 0.30 and keys for the accounts below in ~/.near-credentials.
# Run one step at a time: ./scripts/seed-testnet.sh <step>
set -euo pipefail

CONTRACT=${CONTRACT:-pettycash.testnet}
TOKEN=${TOKEN:-tusd-pettycash.testnet}
DAO_NAME=${DAO_NAME:-harbor-builders}
DAO=$DAO_NAME.sputnikv2.testnet
COUNCIL=(harbor-mara.testnet harbor-jon.testnet harbor-ines.testnet)
ANA=harbor-ana.testnet
RUI=harbor-rui.testnet
BOT=harbor-bot.testnet
TUSD=1000000            # 6 decimals
END_2026=1798675200     # 31 Dec 2026 00:00 UTC

tx() { # signer receiver method json deposit
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas '300.0 Tgas' attached-deposit "$5" sign-as "$1" \
    network-config testnet sign-with-legacy-keychain send 2>&1 \
    | grep -E "Transaction ID|^[0-9]+$|panicked|spend [0-9]+|budget [0-9]+" || true
}

view() { # account method json
  near contract call-function as-read-only "$1" "$2" json-args "${3:-{\}}" network-config testnet now 2>/dev/null
}

propose() { # description kind_json -> prints proposal id
  tx "${COUNCIL[0]}" "$DAO" add_proposal \
    "{\"proposal\":{\"description\":\"$1\",\"kind\":$2}}" "$(bond)" | grep -E "^[0-9]+$"
}

bond() {
  local y
  y=$(view "$DAO" get_policy | python -c "import json,sys;print(json.load(sys.stdin)['proposal_bond'])")
  python -c "from decimal import Decimal;print(f'{Decimal($y)/Decimal(10**24)} NEAR')"
}

approve() { # id kind_json ; two of three council votes
  for member in "${COUNCIL[0]}" "${COUNCIL[1]}"; do
    tx "$member" "$DAO" act_proposal "{\"id\":$1,\"action\":\"VoteApprove\",\"proposal\":$2}" '0 NEAR'
  done
}

budget_kind() { # rules_json deposit_yocto
  local b64
  b64=$(node -e "console.log(Buffer.from(process.argv[1]).toString('base64'))" "{\"rules\":$1}")
  echo "{\"FunctionCall\":{\"receiver_id\":\"$CONTRACT\",\"actions\":[{\"method_name\":\"create_budget\",\"args\":\"$b64\",\"deposit\":\"$2\",\"gas\":\"50000000000000\"}]}}"
}

case "${1:-help}" in
  deploy)
    near contract deploy "$CONTRACT" use-file contract/target/near/petty_cash.wasm \
      with-init-call new json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
      network-config testnet sign-with-legacy-keychain send 2>&1 | grep -iE "deployed|error"
    near contract deploy "$TOKEN" use-file test-usd/target/near/test_usd.wasm \
      with-init-call new json-args "{\"owner\":\"$TOKEN\"}" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
      network-config testnet sign-with-legacy-keychain send 2>&1 | grep -iE "deployed|error"
    ;;
  dao)
    args=$(node -e "console.log(Buffer.from(JSON.stringify({config:{name:'$DAO_NAME',purpose:'Harbor Builders, a demo community for Petty Cash on NEAR testnet',metadata:''},policy:process.argv.slice(1)})).toString('base64'))" "${COUNCIL[@]}")
    tx "${COUNCIL[0]}" sputnikv2.testnet create "{\"name\":\"$DAO_NAME\",\"args\":\"$args\"}" '6 NEAR'
    ;;
  fund-dao)
    near tokens "${COUNCIL[1]}" send-near "$DAO" '6 NEAR' network-config testnet sign-with-legacy-keychain send 2>&1 | grep "Transaction ID"
    ;;
  lower-bond)
    kind='{"ChangePolicyUpdateParameters":{"parameters":{"proposal_bond":"100000000000000000000000","proposal_period":null,"bounty_bond":null,"bounty_forgiveness_period":null}}}'
    id=$(propose "Lower the proposal bond to 0.1 NEAR for the demo" "$kind"); echo "proposal $id"
    approve "$id" "$kind"
    ;;
  install)
    kind="{\"ChangePolicyAddOrUpdateRole\":{\"role\":{\"name\":\"pettycash\",\"kind\":{\"Group\":[\"$CONTRACT\"]},\"permissions\":[\"transfer:AddProposal\",\"transfer:VoteApprove\"],\"vote_policy\":{\"transfer\":{\"weight_kind\":\"RoleWeight\",\"quorum\":\"0\",\"threshold\":[1,1]}}}}}"
    id=$(propose "Install Petty Cash: a role whose only member is the Petty Cash contract, limited to adding and approving transfers" "$kind"); echo "proposal $id"
    approve "$id" "$kind"
    ;;
  tusd)
    tx "$TOKEN" "$TOKEN" storage_deposit "{\"account_id\":\"$DAO\",\"registration_only\":true}" '0.01 NEAR'
    tx "$TOKEN" "$TOKEN" mint "{\"account_id\":\"$DAO\",\"amount\":\"$((10000 * TUSD))\"}" '0 NEAR'
    ;;
  budgets)
    meetups="{\"name\":\"Meetups\",\"token\":\"$TOKEN\",\"holders\":[\"$ANA\"],\"per_payment_cap\":\"$((250 * TUSD))\",\"period_cap\":\"$((1200 * TUSD))\",\"period_secs\":2592000,\"categories\":[\"food\",\"venue\",\"printing\"],\"expires_at\":$END_2026,\"proposal_bond\":\"100000000000000000000000\"}"
    design="{\"name\":\"Design\",\"token\":\"$TOKEN\",\"holders\":[\"$RUI\"],\"per_payment_cap\":\"$((400 * TUSD))\",\"period_cap\":\"$((1500 * TUSD))\",\"period_secs\":2592000,\"categories\":[\"tools\",\"freelance\"],\"expires_at\":$END_2026,\"proposal_bond\":\"100000000000000000000000\"}"
    bot="{\"name\":\"Community bot\",\"token\":\"$TOKEN\",\"holders\":[\"$BOT\"],\"per_payment_cap\":\"$((50 * TUSD))\",\"period_cap\":\"$((300 * TUSD))\",\"period_secs\":2592000,\"categories\":[\"compute\"],\"expires_at\":$END_2026,\"proposal_bond\":\"100000000000000000000000\"}"
    for pair in "Meetups|$meetups|3000000000000000000000000" "Design|$design|500000000000000000000000" "Community bot|$bot|500000000000000000000000"; do
      IFS='|' read -r name rules deposit <<< "$pair"
      kind=$(budget_kind "$rules" "$deposit")
      id=$(propose "Create the Petty Cash budget: $name" "$kind"); echo "proposal $id ($name)"
      approve "$id" "$kind"
    done
    view "$CONTRACT" list_budgets "{\"dao\":\"$DAO\"}" | grep -E '"id"|"name"'
    ;;
  spend) # holder budget_id receiver amount_tusd category memo
    tx "$2" "$CONTRACT" spend "{\"budget_id\":$3,\"receiver_id\":\"$4\",\"amount\":\"$(($5 * TUSD))\",\"category\":\"$6\",\"memo\":\"$7\"}" '0 NEAR'
    ;;
  status)
    view "$DAO" get_policy | head -20
    view "$CONTRACT" list_budgets "{\"dao\":\"$DAO\"}"
    view "$CONTRACT" get_pool "{\"dao\":\"$DAO\"}"
    ;;
  *)
    echo "steps: deploy dao fund-dao lower-bond install tusd budgets spend status"
    ;;
esac
