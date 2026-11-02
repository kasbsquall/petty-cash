//! Petty Cash: budgets with rules for a Sputnik DAO.
//!
//! The DAO adds this contract as the only member of a `pettycash` role that may
//! add and approve `transfer` proposals. The DAO then creates budgets by calling
//! `create_budget` through a normal FunctionCall proposal. A budget holder calls
//! `spend`: inside the rules, this contract files a Transfer proposal and approves
//! it in the same call chain, so the payment leaves the DAO directly. Outside the
//! rules, the proposal is filed and left for the council to vote on.
//!
//! Money never sits in this contract. The only NEAR it holds is each DAO's bond
//! pool, which pays proposal bonds and the storage of that DAO's records.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near, require,
};

const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(20);
const GAS_ACT_PROPOSAL: Gas = Gas::from_tgas(80);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_VIEW_PROPOSAL: Gas = Gas::from_tgas(10);
/// NEP-145 registration for a standard fungible token account.
const FT_STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000;
const MAX_HOLDERS: usize = 20;
const MAX_CATEGORIES: usize = 12;
const MAX_TEXT: usize = 280;
const NS_PER_SEC: u64 = 1_000_000_000;

pub type BudgetId = u32;
pub type SpendId = u64;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum SpendStatus {
    /// Inside the rules, waiting for the DAO to confirm the payment.
    Pending,
    /// Paid from the DAO by an auto-approved proposal.
    Paid,
    /// Outside the rules: a normal proposal was filed for the council.
    Escalated,
    /// The DAO call failed; nothing was paid and the reservation was released.
    Failed,
    /// Escalated and then rejected by the council; nothing was paid.
    Rejected,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct BudgetRules {
    pub name: String,
    /// Fungible token (NEP-141) the budget pays in. None means NEAR.
    pub token: Option<AccountId>,
    pub holders: Vec<AccountId>,
    /// Largest single payment that is approved automatically, in yoctoNEAR.
    pub per_payment_cap: U128,
    /// Total that can be approved automatically per period, in yoctoNEAR.
    pub period_cap: U128,
    /// Length of a period in seconds (e.g. 2_592_000 for 30 days).
    pub period_secs: u64,
    /// Allowed categories. Empty means any category.
    pub categories: Vec<String>,
    /// Optional end of the budget, unix seconds.
    pub expires_at: Option<u64>,
    /// Proposal bond the DAO requires, in yoctoNEAR (see the DAO policy).
    pub proposal_bond: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Budget {
    pub id: BudgetId,
    pub dao: AccountId,
    pub rules: BudgetRules,
    pub paused: bool,
    /// Start of the first period, nanoseconds.
    pub started_at: u64,
    /// Index of the period that `spent` refers to.
    pub period_index: u64,
    pub spent: U128,
    pub reserved: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Spend {
    pub id: SpendId,
    pub budget_id: BudgetId,
    pub dao: AccountId,
    pub by: AccountId,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub category: String,
    pub memo: String,
    /// Nanoseconds.
    pub at: u64,
    pub period_index: u64,
    pub status: SpendStatus,
    pub proposal_id: Option<u64>,
    /// Why a request was escalated or failed, in plain words.
    pub reason: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    budgets: IterableMap<BudgetId, Budget>,
    spends: Vector<Spend>,
    bond_pool: LookupMap<AccountId, u128>,
    next_budget_id: BudgetId,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            budgets: IterableMap::new(b"b"),
            spends: Vector::new(b"s"),
            bond_pool: LookupMap::new(b"p"),
            next_budget_id: 1,
        }
    }

    // ---------- DAO-only calls (made through a FunctionCall proposal) ----------

    /// Creates a budget for the calling DAO. Any attached deposit goes to the
    /// DAO's bond pool.
    #[payable]
    pub fn create_budget(&mut self, rules: BudgetRules) -> BudgetId {
        let dao = env::predecessor_account_id();
        self.credit_pool(&dao, env::attached_deposit().as_yoctonear());
        validate_rules(&rules);
        let storage_before = env::storage_usage();
        let id = self.next_budget_id;
        self.next_budget_id += 1;
        let now = env::block_timestamp();
        self.budgets.insert(
            id,
            Budget {
                id,
                dao: dao.clone(),
                rules,
                paused: false,
                started_at: now,
                period_index: 0,
                spent: U128(0),
                reserved: U128(0),
            },
        );
        self.budgets.flush();
        self.charge_storage(&dao, storage_before);
        env::log_str(&format!("budget {id} created for {dao}"));
        id
    }

    /// Replaces the rules of a budget. Spending already counted this period stays.
    #[payable]
    pub fn update_budget(&mut self, budget_id: BudgetId, rules: BudgetRules) {
        let dao = env::predecessor_account_id();
        self.credit_pool(&dao, env::attached_deposit().as_yoctonear());
        validate_rules(&rules);
        let mut budget = self.dao_budget(budget_id, &dao);
        budget.rules = rules;
        self.budgets.insert(budget_id, budget);
    }

    pub fn set_paused(&mut self, budget_id: BudgetId, paused: bool) {
        let dao = env::predecessor_account_id();
        let mut budget = self.dao_budget(budget_id, &dao);
        budget.paused = paused;
        self.budgets.insert(budget_id, budget);
    }

    /// Anyone can top up a DAO's bond pool. Usually the DAO itself does it.
    #[payable]
    pub fn fund_pool(&mut self, dao: AccountId) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach NEAR to fund the pool");
        self.credit_pool(&dao, amount);
    }

    // ---------- Holder call ----------

    /// Requests a payment from a budget. Inside the rules it is paid right away;
    /// otherwise a normal proposal is filed for the council.
    pub fn spend(
        &mut self,
        budget_id: BudgetId,
        receiver_id: AccountId,
        amount: U128,
        category: String,
        memo: String,
    ) -> Promise {
        let by = env::predecessor_account_id();
        let mut budget = self
            .budgets
            .get(&budget_id)
            .cloned()
            .expect("Unknown budget");
        require!(
            budget.rules.holders.contains(&by),
            "Only a holder of this budget can spend from it"
        );
        require!(amount.0 > 0, "Amount must be greater than zero");
        require!(
            memo.len() <= MAX_TEXT && category.len() <= MAX_TEXT,
            "Text too long"
        );
        require!(!memo.trim().is_empty(), "Say what the payment is for");

        let now = env::block_timestamp();
        roll_period(&mut budget, now);
        let reason = rule_violation(&budget, amount.0, &category, now);
        let within = reason.is_none();

        let bond = budget.rules.proposal_bond.0;
        let token = budget.rules.token.clone();
        let registration = if token.is_some() {
            FT_STORAGE_DEPOSIT
        } else {
            0
        };
        let pool = self.pool_of(&budget.dao);
        require!(
            pool >= bond + registration,
            "The DAO's bond pool is too low; ask the DAO to fund it"
        );
        self.bond_pool
            .insert(budget.dao.clone(), pool - bond - registration);

        if within {
            budget.reserved = U128(budget.reserved.0 + amount.0);
        }
        let storage_before = env::storage_usage();
        let spend_id = self.spends.len() as SpendId;
        self.spends.push(Spend {
            id: spend_id,
            budget_id,
            dao: budget.dao.clone(),
            by: by.clone(),
            receiver_id: receiver_id.clone(),
            amount,
            category: category.clone(),
            memo: memo.clone(),
            at: now,
            period_index: budget.period_index,
            status: if within {
                SpendStatus::Pending
            } else {
                SpendStatus::Escalated
            },
            proposal_id: None,
            reason,
        });
        self.spends.flush();
        let dao = budget.dao.clone();
        self.budgets.insert(budget_id, budget);
        self.budgets.flush();
        self.charge_storage(&dao, storage_before);

        let description = format!(
            "Petty Cash #{spend_id} from budget {budget_id}: {memo} ({category}) requested by {by}{}",
            if within {
                ""
            } else {
                ". Outside the budget rules, needs a council vote."
            }
        );
        let args = json!({
            "proposal": {
                "description": description,
                "kind": transfer_kind(token.as_ref(), &receiver_id, amount),
            }
        });
        // A token payment needs the receiver registered on the token first.
        let start = match &token {
            Some(token_id) => Promise::new(token_id.clone())
                .function_call(
                    "storage_deposit".to_string(),
                    json!({ "account_id": receiver_id, "registration_only": true })
                        .to_string()
                        .into_bytes(),
                    NearToken::from_yoctonear(FT_STORAGE_DEPOSIT),
                    GAS_STORAGE_DEPOSIT,
                )
                .then(Promise::new(dao.clone())),
            None => Promise::new(dao),
        };
        start
            .function_call(
                "add_proposal".to_string(),
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(bond),
                GAS_ADD_PROPOSAL,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(
                        GAS_ACT_PROPOSAL
                            .saturating_add(GAS_VIEW_PROPOSAL)
                            .saturating_add(GAS_CALLBACK)
                            .saturating_add(GAS_CALLBACK),
                    )
                    .on_proposal_added(spend_id, within),
            )
    }

    /// Anyone can settle an escalated payment once the council has decided:
    /// the contract reads the DAO's proposal and records the outcome, so the
    /// budget counts payments the council approved.
    pub fn settle(&mut self, spend_id: SpendId) -> Promise {
        let spend = self
            .spends
            .get(spend_id as u32)
            .cloned()
            .expect("Unknown spend");
        require!(
            spend.status == SpendStatus::Escalated,
            "Only a payment waiting for the council can be settled"
        );
        let proposal_id = spend
            .proposal_id
            .expect("The payment has no DAO proposal yet");
        Promise::new(spend.dao.clone())
            .function_call(
                "get_proposal".to_string(),
                json!({ "id": proposal_id }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_VIEW_PROPOSAL,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_settled(spend_id),
            )
    }

    // ---------- Callbacks ----------

    /// Records the council's decision on an escalated payment.
    #[private]
    pub fn on_settled(
        &mut self,
        spend_id: SpendId,
        #[callback_result] result: Result<near_sdk::serde_json::Value, PromiseError>,
    ) {
        let mut spend = self
            .spends
            .get(spend_id as u32)
            .cloned()
            .expect("Unknown spend");
        if spend.status != SpendStatus::Escalated {
            return;
        }
        let status = match result {
            // A removed proposal no longer exists; Sputnik keeps its bond.
            Err(_) => "Removed".to_string(),
            Ok(p) => p
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        };
        match status.as_str() {
            "Approved" => {
                let mut budget = self
                    .budgets
                    .get(&spend.budget_id)
                    .cloned()
                    .expect("Unknown budget");
                roll_period(&mut budget, env::block_timestamp());
                if budget.period_index == spend.period_index {
                    budget.spent = U128(budget.spent.0 + spend.amount.0);
                }
                self.budgets.insert(spend.budget_id, budget);
                self.credit_bond(&spend);
                spend.status = SpendStatus::Paid;
                spend.reason = Some("Approved by a council vote".to_string());
            }
            "Rejected" => {
                // Sputnik returns the bond to the proposer on a rejection.
                self.credit_bond(&spend);
                spend.status = SpendStatus::Rejected;
                spend.reason = Some("Rejected by a council vote".to_string());
            }
            "InProgress" => {
                env::log_str(&format!("spend {spend_id} still waits for the council"));
                return;
            }
            other => {
                spend.status = SpendStatus::Failed;
                spend.reason = Some(format!("The DAO marked the proposal as {other}"));
            }
        }
        env::log_str(&format!("spend {spend_id} settled: {status}"));
        self.set_spend(spend);
    }

    #[private]
    pub fn on_proposal_added(
        &mut self,
        spend_id: SpendId,
        within: bool,
        #[callback_result] result: Result<u64, PromiseError>,
    ) -> Option<Promise> {
        let mut spend = self
            .spends
            .get(spend_id as u32)
            .cloned()
            .expect("Unknown spend");
        let proposal_id = match result {
            Ok(id) => id,
            Err(_) => {
                // add_proposal failed, so the bond came back with the refund.
                self.release(&spend, within);
                self.credit_bond(&spend);
                spend.status = SpendStatus::Failed;
                spend.reason = Some("The DAO did not accept the proposal".to_string());
                self.set_spend(spend);
                return None;
            }
        };
        spend.proposal_id = Some(proposal_id);
        self.set_spend(spend.clone());
        if !within {
            env::log_str(&format!(
                "spend {spend_id} escalated as proposal {proposal_id}"
            ));
            return None;
        }
        let token = self
            .budgets
            .get(&spend.budget_id)
            .and_then(|b| b.rules.token.clone());
        let args = json!({
            "id": proposal_id,
            "action": "VoteApprove",
            "proposal": transfer_kind(token.as_ref(), &spend.receiver_id, spend.amount),
        });
        Some(
            Promise::new(spend.dao.clone())
                .function_call(
                    "act_proposal".to_string(),
                    args.to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_ACT_PROPOSAL,
                )
                // Read the proposal back: the vote call can succeed without approving it.
                .then(Promise::new(spend.dao.clone()).function_call(
                    "get_proposal".to_string(),
                    json!({ "id": proposal_id }).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_VIEW_PROPOSAL,
                ))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_CALLBACK)
                        .on_checked(spend_id),
                ),
        )
    }

    /// Settles a spend from the DAO's own record of the proposal.
    #[private]
    pub fn on_checked(
        &mut self,
        spend_id: SpendId,
        #[callback_result] result: Result<near_sdk::serde_json::Value, PromiseError>,
    ) {
        let mut spend = self
            .spends
            .get(spend_id as u32)
            .cloned()
            .expect("Unknown spend");
        let mut budget = self
            .budgets
            .get(&spend.budget_id)
            .cloned()
            .expect("Unknown budget");
        budget.reserved = U128(budget.reserved.0.saturating_sub(spend.amount.0));
        let status = result
            .ok()
            .and_then(|p| p.get("status").and_then(|v| v.as_str()).map(str::to_string))
            .unwrap_or_default();
        match status.as_str() {
            "Approved" => {
                if budget.period_index == spend.period_index {
                    budget.spent = U128(budget.spent.0 + spend.amount.0);
                }
                // An approved proposal returns its bond to the proposer, this contract.
                self.credit_bond(&spend);
                spend.status = SpendStatus::Paid;
                env::log_str(&format!("spend {spend_id} paid"));
            }
            "InProgress" => {
                spend.status = SpendStatus::Escalated;
                spend.reason = Some(
                    "The keeper vote did not approve it; it waits for a council vote".to_string(),
                );
                env::log_str(&format!("spend {spend_id} left for the council"));
            }
            other => {
                spend.status = SpendStatus::Failed;
                spend.reason = Some(format!("The DAO marked the payment as {other}"));
                env::log_str(&format!("spend {spend_id} failed: {other}"));
            }
        }
        self.budgets.insert(spend.budget_id, budget);
        self.set_spend(spend);
    }

    // ---------- Views ----------

    pub fn get_budget(&self, budget_id: BudgetId) -> Option<Budget> {
        self.budgets.get(&budget_id).cloned().map(|mut b| {
            roll_period(&mut b, env::block_timestamp());
            b
        })
    }

    pub fn list_budgets(&self, dao: AccountId) -> Vec<Budget> {
        let now = env::block_timestamp();
        self.budgets
            .values()
            .filter(|b| b.dao == dao)
            .cloned()
            .map(|mut b| {
                roll_period(&mut b, now);
                b
            })
            .collect()
    }

    pub fn get_spend(&self, spend_id: SpendId) -> Option<Spend> {
        self.spends.get(spend_id as u32).cloned()
    }

    /// Spends of one budget, oldest first.
    pub fn list_spends(
        &self,
        budget_id: BudgetId,
        from_index: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<Spend> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(200) as usize;
        self.spends
            .iter()
            .skip(from as usize)
            .filter(|s| s.budget_id == budget_id)
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn get_pool(&self, dao: AccountId) -> U128 {
        U128(self.pool_of(&dao))
    }

    // ---------- Internal ----------

    fn dao_budget(&self, budget_id: BudgetId, dao: &AccountId) -> Budget {
        let budget = self
            .budgets
            .get(&budget_id)
            .cloned()
            .expect("Unknown budget");
        require!(
            &budget.dao == dao,
            "Only the DAO that owns this budget can change it"
        );
        budget
    }

    fn pool_of(&self, dao: &AccountId) -> u128 {
        self.bond_pool.get(dao).copied().unwrap_or(0)
    }

    fn credit_pool(&mut self, dao: &AccountId, amount: u128) {
        if amount > 0 {
            let current = self.pool_of(dao);
            self.bond_pool.insert(dao.clone(), current + amount);
        }
    }

    fn credit_bond(&mut self, spend: &Spend) {
        let bond = self
            .budgets
            .get(&spend.budget_id)
            .map(|b| b.rules.proposal_bond.0)
            .unwrap_or(0);
        let dao = spend.dao.clone();
        self.credit_pool(&dao, bond);
    }

    fn release(&mut self, spend: &Spend, within: bool) {
        if !within {
            return;
        }
        if let Some(mut budget) = self.budgets.get(&spend.budget_id).cloned() {
            budget.reserved = U128(budget.reserved.0.saturating_sub(spend.amount.0));
            self.budgets.insert(spend.budget_id, budget);
        }
    }

    fn set_spend(&mut self, spend: Spend) {
        let id = spend.id as u32;
        self.spends.set(id, spend);
    }

    /// The DAO pays for the storage its own records use, out of its bond pool.
    fn charge_storage(&mut self, dao: &AccountId, storage_before: u64) {
        let after = env::storage_usage();
        if after <= storage_before {
            return;
        }
        let cost = env::storage_byte_cost().as_yoctonear() * u128::from(after - storage_before);
        let pool = self.pool_of(dao);
        require!(
            pool >= cost,
            "The DAO's bond pool cannot cover storage; fund it first"
        );
        self.bond_pool.insert(dao.clone(), pool - cost);
    }
}

fn transfer_kind(
    token: Option<&AccountId>,
    receiver_id: &AccountId,
    amount: U128,
) -> near_sdk::serde_json::Value {
    json!({
        "Transfer": {
            "token_id": token.map(|t| t.to_string()).unwrap_or_default(),
            "receiver_id": receiver_id,
            "amount": amount,
            "msg": null,
        }
    })
}

fn validate_rules(rules: &BudgetRules) {
    require!(
        !rules.name.trim().is_empty() && rules.name.len() <= MAX_TEXT,
        "Give the budget a name"
    );
    require!(
        !rules.holders.is_empty() && rules.holders.len() <= MAX_HOLDERS,
        "A budget needs between 1 and 20 holders"
    );
    require!(
        rules.categories.len() <= MAX_CATEGORIES,
        "Too many categories"
    );
    require!(
        rules.per_payment_cap.0 > 0,
        "Per-payment cap must be greater than zero"
    );
    require!(
        rules.period_cap.0 >= rules.per_payment_cap.0,
        "Period cap must be at least the per-payment cap"
    );
    require!(
        rules.period_secs >= 60,
        "Period must be at least 60 seconds"
    );
}

/// Moves the budget to the current period, resetting what was spent.
fn roll_period(budget: &mut Budget, now: u64) {
    let len = budget.rules.period_secs.saturating_mul(NS_PER_SEC);
    let index = now.saturating_sub(budget.started_at) / len;
    if index != budget.period_index {
        budget.period_index = index;
        budget.spent = U128(0);
    }
}

/// Returns the first rule a request breaks, in plain words, or None.
fn rule_violation(budget: &Budget, amount: u128, category: &str, now: u64) -> Option<String> {
    let rules = &budget.rules;
    if budget.paused {
        return Some("The budget is paused".to_string());
    }
    if let Some(end) = rules.expires_at {
        if now / NS_PER_SEC >= end {
            return Some("The budget has expired".to_string());
        }
    }
    if !rules.categories.is_empty() && !rules.categories.iter().any(|c| c == category) {
        return Some(format!("Category '{category}' is not in this budget"));
    }
    if amount > rules.per_payment_cap.0 {
        return Some("Above the per-payment cap".to_string());
    }
    let used = budget.spent.0 + budget.reserved.0;
    if used + amount > rules.period_cap.0 {
        return Some("Above what is left in this period".to_string());
    }
    None
}

#[cfg(test)]
mod tests;
