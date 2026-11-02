use super::*;
use near_sdk::test_utils::{VMContextBuilder, accounts};
use near_sdk::testing_env;

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn dao() -> AccountId {
    "guild.sputnikv2.testnet".parse().unwrap()
}

fn other_dao() -> AccountId {
    "other.sputnikv2.testnet".parse().unwrap()
}

fn context(predecessor: &AccountId, deposit: u128, now_secs: u64) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id("pettycash.testnet".parse().unwrap())
        .predecessor_account_id(predecessor.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(50))
        .block_timestamp(now_secs * NS_PER_SEC);
    builder
}

fn rules() -> BudgetRules {
    BudgetRules {
        name: "Meetups".to_string(),
        holders: vec![accounts(1)],
        per_payment_cap: U128(5 * ONE_NEAR),
        period_cap: U128(12 * ONE_NEAR),
        period_secs: 30 * 24 * 3600,
        categories: vec!["food".to_string(), "venue".to_string()],
        expires_at: None,
        proposal_bond: U128(ONE_NEAR / 10),
    }
}

fn setup() -> (Contract, BudgetId) {
    testing_env!(context(&dao(), 2 * ONE_NEAR, 1_000).build());
    let mut contract = Contract::new();
    let id = contract.create_budget(rules());
    (contract, id)
}

fn spend(contract: &mut Contract, budget: BudgetId, amount: u128, category: &str) {
    testing_env!(context(&accounts(1), 0, 2_000).build());
    contract.spend(budget, accounts(2), U128(amount), category.to_string(), "Pizza".to_string());
}

/// Callbacks are called directly with their result, as the runtime would.
fn as_contract(now_secs: u64) {
    testing_env!(context(&"pettycash.testnet".parse().unwrap(), 0, now_secs).build());
}

#[test]
fn dao_creates_budget_and_funds_pool() {
    let (contract, id) = setup();
    let budget = contract.get_budget(id).unwrap();
    assert_eq!(budget.dao, dao());
    assert!(contract.get_pool(dao()).0 > 0);
    assert!(contract.get_pool(dao()).0 < 2 * ONE_NEAR, "storage is charged to the pool");
}

#[test]
fn spend_inside_rules_is_pending_and_reserved() {
    let (mut contract, id) = setup();
    spend(&mut contract, id, 3 * ONE_NEAR, "food");
    let s = contract.get_spend(0).unwrap();
    assert_eq!(s.status, SpendStatus::Pending);
    assert!(s.reason.is_none());
    assert_eq!(contract.get_budget(id).unwrap().reserved.0, 3 * ONE_NEAR);
}

#[test]
fn spend_above_per_payment_cap_is_escalated() {
    let (mut contract, id) = setup();
    spend(&mut contract, id, 6 * ONE_NEAR, "food");
    let s = contract.get_spend(0).unwrap();
    assert_eq!(s.status, SpendStatus::Escalated);
    assert_eq!(s.reason.as_deref(), Some("Above the per-payment cap"));
    assert_eq!(contract.get_budget(id).unwrap().reserved.0, 0);
}

#[test]
fn spend_in_unknown_category_is_escalated() {
    let (mut contract, id) = setup();
    spend(&mut contract, id, ONE_NEAR, "travel");
    let s = contract.get_spend(0).unwrap();
    assert_eq!(s.status, SpendStatus::Escalated);
    assert!(s.reason.unwrap().contains("travel"));
}

#[test]
fn period_cap_counts_reserved_and_spent() {
    let (mut contract, id) = setup();
    spend(&mut contract, id, 5 * ONE_NEAR, "food");
    spend(&mut contract, id, 5 * ONE_NEAR, "food");
    spend(&mut contract, id, 5 * ONE_NEAR, "food");
    assert_eq!(contract.get_spend(2).unwrap().status, SpendStatus::Escalated);
    assert_eq!(
        contract.get_spend(2).unwrap().reason.as_deref(),
        Some("Above what is left in this period")
    );
}

#[test]
#[should_panic(expected = "Only a holder of this budget can spend from it")]
fn non_holder_cannot_spend() {
    let (mut contract, id) = setup();
    testing_env!(context(&accounts(3), 0, 2_000).build());
    contract.spend(id, accounts(3), U128(ONE_NEAR), "food".to_string(), "Me".to_string());
}

#[test]
#[should_panic(expected = "Only the DAO that owns this budget can change it")]
fn other_dao_cannot_change_budget() {
    let (mut contract, id) = setup();
    testing_env!(context(&other_dao(), 0, 2_000).build());
    contract.set_paused(id, true);
}

#[test]
#[should_panic(expected = "Only the DAO that owns this budget can change it")]
fn holder_cannot_change_budget() {
    let (mut contract, id) = setup();
    testing_env!(context(&accounts(1), 0, 2_000).build());
    let mut r = rules();
    r.per_payment_cap = U128(1_000 * ONE_NEAR);
    r.period_cap = U128(1_000 * ONE_NEAR);
    contract.update_budget(id, r);
}

#[test]
fn paused_budget_escalates_everything() {
    let (mut contract, id) = setup();
    testing_env!(context(&dao(), 0, 1_500).build());
    contract.set_paused(id, true);
    spend(&mut contract, id, ONE_NEAR, "food");
    assert_eq!(contract.get_spend(0).unwrap().reason.as_deref(), Some("The budget is paused"));
}

#[test]
#[should_panic(expected = "The DAO's bond pool is too low")]
fn empty_pool_blocks_spend() {
    testing_env!(context(&dao(), 0, 1_000).build());
    let mut contract = Contract::new();
    // Creation without deposit fails on storage, so fund first from a third party.
    testing_env!(context(&accounts(4), ONE_NEAR / 50, 1_000).build());
    contract.fund_pool(dao());
    testing_env!(context(&dao(), 0, 1_000).build());
    let id = contract.create_budget(rules());
    spend(&mut contract, id, ONE_NEAR, "food");
}

#[test]
fn approval_marks_paid_and_moves_reserve_to_spent() {
    let (mut contract, id) = setup();
    spend(&mut contract, id, 3 * ONE_NEAR, "food");
    let pool_before = contract.get_pool(dao()).0;
    as_contract(2_001);
    contract.on_proposal_added(0, true, Ok(7));
    assert_eq!(contract.get_spend(0).unwrap().proposal_id, Some(7));
    as_contract(2_002);
    contract.on_approved(0, Ok(()));
    let budget = contract.get_budget(id).unwrap();
    assert_eq!(contract.get_spend(0).unwrap().status, SpendStatus::Paid);
    assert_eq!(budget.spent.0, 3 * ONE_NEAR);
    assert_eq!(budget.reserved.0, 0);
    assert_eq!(contract.get_pool(dao()).0, pool_before + ONE_NEAR / 10, "bond returns to pool");
}

#[test]
fn failed_proposal_releases_reserve() {
    let (mut contract, id) = setup();
    spend(&mut contract, id, 3 * ONE_NEAR, "food");
    as_contract(2_001);
    contract.on_proposal_added(0, true, Err(PromiseError::Failed));
    let s = contract.get_spend(0).unwrap();
    assert_eq!(s.status, SpendStatus::Failed);
    assert_eq!(contract.get_budget(id).unwrap().reserved.0, 0);
}

#[test]
fn failed_approval_releases_reserve_without_counting() {
    let (mut contract, id) = setup();
    spend(&mut contract, id, 3 * ONE_NEAR, "food");
    as_contract(2_001);
    contract.on_proposal_added(0, true, Ok(1));
    as_contract(2_002);
    contract.on_approved(0, Err(PromiseError::Failed));
    let budget = contract.get_budget(id).unwrap();
    assert_eq!(contract.get_spend(0).unwrap().status, SpendStatus::Failed);
    assert_eq!(budget.spent.0, 0);
    assert_eq!(budget.reserved.0, 0);
}

#[test]
fn new_period_resets_spent() {
    let (mut contract, id) = setup();
    spend(&mut contract, id, 5 * ONE_NEAR, "food");
    as_contract(2_001);
    contract.on_proposal_added(0, true, Ok(1));
    contract.on_approved(0, Ok(()));
    testing_env!(context(&accounts(1), 0, 1_000 + 31 * 24 * 3600).build());
    let budget = contract.get_budget(id).unwrap();
    assert_eq!(budget.spent.0, 0);
    assert_eq!(budget.period_index, 1);
}

#[test]
#[should_panic(expected = "Period cap must be at least the per-payment cap")]
fn rejects_inconsistent_rules() {
    testing_env!(context(&dao(), ONE_NEAR, 1_000).build());
    let mut contract = Contract::new();
    let mut r = rules();
    r.period_cap = U128(ONE_NEAR);
    contract.create_budget(r);
}

#[test]
fn list_budgets_filters_by_dao() {
    let (mut contract, _) = setup();
    testing_env!(context(&other_dao(), ONE_NEAR, 1_000).build());
    contract.create_budget(rules());
    assert_eq!(contract.list_budgets(dao()).len(), 1);
    assert_eq!(contract.list_budgets(other_dao()).len(), 1);
}
