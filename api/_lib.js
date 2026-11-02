// Shared helpers for the guided-demo functions. Testnet only.
// The keys in DEMO_KEY_* are function-call keys: the holders' keys can only call
// `spend` on the Petty Cash contract, the council keys only `act_proposal` on the demo DAO.
import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';

export const RPC = process.env.NEAR_RPC || 'https://rpc.testnet.near.org';
export const CONTRACT = 'pettycash.testnet';
export const DAO = 'harbor-builders.sputnikv2.testnet';
export const TOKEN = 'tusd-pettycash.testnet';
export const TUSD = 1_000_000n;
export const MAX_DEMO_AMOUNT = 1_000; // dollars, per request

// Demo accounts that may receive a payment. Free text would let anyone point
// the demo at their own account and drain the test pool's storage deposits.
export const RECEIVERS = [
  'harbor-venue.testnet',
  'harbor-print.testnet',
  'harbor-studio.testnet',
  'harbor-compute.testnet',
  'harbor-ana.testnet',
];

const KEYS = {
  'harbor-ana.testnet': 'DEMO_KEY_ANA',
  'harbor-rui.testnet': 'DEMO_KEY_RUI',
  'harbor-bot.testnet': 'DEMO_KEY_BOT',
  'harbor-jon.testnet': 'DEMO_KEY_JON',
  'harbor-ines.testnet': 'DEMO_KEY_INES',
};

export const provider = new JsonRpcProvider({ url: RPC });

export function view(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args });
}

export function accountFor(accountId) {
  const secret = process.env[KEYS[accountId]];
  if (!secret) throw new Error(`No demo key configured for ${accountId}`);
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(secret));
}

// Best effort per-instance limit. The on-chain budget rules are the real limit.
const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 12;

export function rateLimited(req) {
  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_HITS) return true;
  hits.set(ip, [...recent, now]);
  return false;
}

export function logsOf(outcome) {
  return (outcome.receipts_outcome || []).flatMap((r) => r.outcome.logs || []);
}

// Turns a contract panic into the sentence the contract wrote, nothing else.
export function panicText(err) {
  const raw = String(err?.message || err);
  const m = raw.match(/Smart contract panicked: ([^"\\]+)/);
  return m ? m[1].trim() : null;
}

export function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}
