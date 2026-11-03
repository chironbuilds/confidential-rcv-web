// On-chain operations for Ootle 0.49: account setup, election initiation (server-signed or
// wallet-signed), read-only state queries (dry-run) and ending elections.
//
// Built on the official @tari-project packages: `IndexerProvider` (indexer REST), `SecretKeyWallet`
// (signing) and the `@tari-project/ootle` transaction builder. Since 0.48 the indexer serves
// receipts, substate values and events as base64 CBOR; `decode*` below turns them back into JSON.
import {
  Network,
  TransactionBuilder,
  XTR_FAUCET_CLAIM_RESOURCE_ADDRESS,
  XTR_FAUCET_COMPONENT_ADDRESS,
  XTR_FAUCET_VAULT_ADDRESS,
  decodeEvent,
  decodeExecuteResult,
  decodeSubstateValue,
  defaultIndexerUrl,
  getVaultIdsForAccount,
  intLiteral,
  resolveMaxEpoch,
  resolveTransaction,
  sealTransaction,
  signTransaction,
  submitTransaction,
  watchTransaction,
} from '@tari-project/ootle';
import { IndexerProvider } from '@tari-project/ootle-indexer';
import { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet';

import { readFileSync } from 'node:fs';
import { initSync as initTally, tally as runTally } from './tally/rcv_tally_wasm.js';
import { accountAddressFromPublicKey } from './derive.mjs';
import { buildMintStatement, decodeMintStatement } from './mint.mjs';

/** A 0.49 range proof aggregates at most 16 outputs, so one mint can create at most 16 ballots. */
export const MAX_VOTERS = 16;

// `TallyMethod` as the 0.49 template encodes it ([variant, []]): SequentialIrv=0, Stv=1, Fptp=2,
// Irv=3. The template pins the seat count per method (Irv/Fptp single-winner, the others > 1).
const TALLY_LITERAL = { 'sequential-irv': '820080', stv: '820180', fptp: '820280', irv: '820380' };

export function networkFromString(name) {
  const n = name?.toLowerCase() ?? 'esmeralda';
  if (n === 'esmeralda') return Network.Esmeralda;
  if (n === 'localnet') return Network.LocalNet;
  if (n === 'mainnet') return Network.MainNet;
  throw new Error(`unsupported network: ${n}`);
}

export async function makeContext(cfg) {
  const network = networkFromString(cfg.NETWORK);
  const url = cfg.OOTLE_INDEXER_URL || defaultIndexerUrl(network);
  const provider = await IndexerProvider.connect({ url, network });
  const signer = SecretKeyWallet.fromSecretKey(
    new Uint8Array(Buffer.from(cfg.OWNER_KEY_HEX, 'hex')),
    network,
    new Uint8Array(Buffer.from(cfg.VIEW_KEY_HEX, 'hex')),
  );
  const ownerPublicKey = await signer.getPublicKey();
  return {
    network,
    indexerUrl: url,
    provider,
    signer,
    address: await signer.getAddress(),
    ownerPublicKey,
    account: accountAddressFromPublicKey(ownerPublicKey),
  };
}

// ---------- receipt decoding ----------

const decodeIf = (v, fn) => (typeof v === 'string' ? fn(v) : v);

/** The finalize section of a (dry-run or committed) transaction result, decoded. */
function finalizeOf(res) {
  const r = res?.result;
  if (!r || r === 'Pending') return null;
  if (typeof r === 'object' && 'Rejected' in r) {
    throw new Error('transaction rejected: ' + (r.Rejected?.reason ?? JSON.stringify(r.Rejected)));
  }
  const fin = r.Finalized ?? r;
  const exec = decodeIf(fin.execution_result ?? fin, decodeExecuteResult);
  const finalize = exec?.finalize ?? null;
  if (finalize && Array.isArray(finalize.events)) finalize.events = finalize.events.map((e) => decodeIf(e, decodeEvent));
  return finalize;
}

function acceptOf(finalize) {
  const r = finalize?.result;
  if (!r) return null;
  if (r.Accept) return r.Accept;
  if (r.AcceptFeeRejectRest) {
    const [, reason] = r.AcceptFeeRejectRest;
    throw new Error('transaction failed: ' + rejectText(reason));
  }
  if (r.Reject) throw new Error('transaction failed: ' + rejectText(r.Reject));
  return null;
}

function rejectText(reason) {
  if (!reason) return 'unknown reason';
  if (typeof reason === 'string') return reason;
  const [kind, detail] = Object.entries(reason)[0] ?? [];
  if (detail && typeof detail === 'object') return `${kind}: ${detail.message ?? JSON.stringify(detail)}`;
  return `${kind}${detail ? `: ${detail}` : ''}`;
}

/** `[substateId, decodedValue]` pairs for every substate the transaction created or updated. */
function upSubstates(res) {
  const accept = acceptOf(finalizeOf(res));
  return (accept?.up_substates ?? []).map(([id, entry]) => {
    const raw = entry?.substate ?? entry?.value ?? entry;
    return [String(id), decodeIf(raw?.substate ?? raw, decodeSubstateValue)];
  });
}

function events(res) {
  return (finalizeOf(res)?.events ?? []).map((e) => ({ topic: e.topic, substate_id: e.substate_id, payload: e.payload }));
}

export function findComponentAddress(res) {
  for (const [id, value] of upSubstates(res)) {
    if (id.startsWith('component_') && value?.Component?.template_address) return id;
  }
  for (const [id] of upSubstates(res)) if (id.startsWith('component_')) return id;
  return null;
}

/** The ballot resource is the newly created Resource substate whose metadata SYMBOL is RVOTE. */
export function findBallotResource(res) {
  for (const [id, value] of upSubstates(res)) {
    if (!id.startsWith('resource_')) continue;
    const md = value?.Resource?.metadata;
    const symbol = md instanceof Map ? md.get('SYMBOL') : md?.SYMBOL;
    if (symbol === 'RVOTE') return id;
  }
  for (const e of events(res)) {
    if (e.topic === 'std.resource.create' && e.payload?.SYMBOL === 'RVOTE') return e.substate_id;
  }
  return null;
}

// ---------- submission ----------

/** Resolve, sign, seal, submit and wait. Returns the receipt with `transaction_id` attached. */
async function submitAndWait(ctx, unsigned, timeoutMs = 180_000) {
  const resolved = await resolveTransaction(ctx.provider, unsigned);
  const envelope = sealTransaction(await signTransaction([ctx.signer], resolved));
  const transactionId = await submitTransaction(ctx.provider, envelope);
  const res = await watchTransaction(ctx.provider, transactionId, { timeoutMs });
  const fin = res?.result?.Finalized;
  if (fin && fin.final_decision && fin.final_decision !== 'Commit') {
    let reason = fin.abort_details ?? fin.final_decision;
    try {
      acceptOf(finalizeOf(res));
    } catch (e) {
      reason = e.message;
    }
    throw new Error(`transaction ${transactionId} was not committed: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
  }
  return { ...res, transaction_id: transactionId };
}

// ---------- account ----------

/** Create the server account and claim faucet funds in one transaction (testnet only). */
export async function setupAccount(ctx) {
  const maxEpoch = await resolveMaxEpoch(ctx.provider);
  const inputs = await ctx.provider.resolveInputs([
    { substate_id: XTR_FAUCET_COMPONENT_ADDRESS, version: null, is_write: true },
    { substate_id: XTR_FAUCET_VAULT_ADDRESS, version: null, is_write: true },
    { substate_id: XTR_FAUCET_CLAIM_RESOURCE_ADDRESS, version: null, is_write: false },
  ]);
  const unsigned = TransactionBuilder.new(ctx.network, maxEpoch)
    .withFeeInstructionsBuilder((b) =>
      b
        .createAccount(Buffer.from(ctx.ownerPublicKey).toString('hex'))
        .saveVar('acct')
        .callMethod({ componentAddress: XTR_FAUCET_COMPONENT_ADDRESS, methodName: 'take' }, [{ Workspace: 'acct' }]),
    )
    .feeTransactionPayFromComponent(ctx.account, 5000n)
    .withInputs(inputs)
    .buildUnsignedTransaction();
  return submitAndWait(ctx, unsigned, 120_000);
}

/** The server account's revealed XTR balance in µT, or null when the account does not exist. */
export async function accountBalance(ctx) {
  let vaults;
  try {
    vaults = await getVaultIdsForAccount(ctx.provider, ctx.account);
  } catch {
    return null;
  }
  let total = 0n;
  for (const id of vaults) {
    try {
      const r = await ctx.provider.getSubstate(id);
      const v = decodeIf(r?.state?.up?.substate ?? r?.substate, decodeSubstateValue);
      const vault = v?.Vault;
      if (!vault) continue;
      const res = vault.resource_container ?? vault.resource ?? vault;
      const inner = res.Fungible ?? res.Stealth ?? res;
      if (String(inner.address ?? inner.resource_address ?? '').endsWith('0101010101010101010101010101010101010101010101010101010101010101')) {
        total += BigInt(inner.amount ?? inner.revealed_amount ?? 0);
      }
    } catch {
      /* skip unreadable vaults */
    }
  }
  return total;
}

/** The election component and its vaults (ballot vault, mint badge vault) as inputs. */
async function componentInputs(ctx, builder, component, isWrite) {
  builder.addInput({ substate_id: component, version: null, is_write: isWrite });
  for (const v of await getVaultIdsForAccount(ctx.provider, component)) builder.addInput({ substate_id: v, version: null, is_write: isWrite });
}

async function accountInputs(ctx, builder) {
  builder.addInput({ substate_id: ctx.account, version: null });
  for (const v of await getVaultIdsForAccount(ctx.provider, ctx.account)) builder.addInput({ substate_id: v, version: null });
}

// ---------- elections ----------

function newElectionBuilder(cfg, maxEpoch, network, params, mint) {
  const { voterAddresses, numCandidates, numWinners, tallyMethod, expiresAtEpoch } = params;
  return TransactionBuilder.new(network, maxEpoch)
    .allocateAddress('Resource', 'ballot_res')
    .callFunction({ templateAddress: cfg.TEMPLATE_ADDRESS, functionName: 'new' }, [
      { Workspace: 'ballot_res' },
      intLiteral(BigInt(voterAddresses.length)),
      intLiteral(BigInt(numCandidates)),
      intLiteral(BigInt(numWinners)),
      { Literal: TALLY_LITERAL[tallyMethod] ?? TALLY_LITERAL.irv },
      intLiteral(BigInt(expiresAtEpoch)),
      { Literal: mint.encodedHex },
    ]);
}

/**
 * The unsigned `new()` instructions for a wallet to sign and pay for. Building the mint statement
 * needs no secret key (its balance proof covers a revealed-input-only transfer), so the browser can
 * hand these to `window.tari` and the connected wallet pays the fee from its own account.
 * The returned `ballots` are never persisted with addresses (see /api/elections/finalize).
 */
export async function prepareInitiateElection(ctx, cfg, params) {
  const mint = buildMintStatement(ctx.network, params.voterAddresses);
  const maxEpoch = await resolveMaxEpoch(ctx.provider);
  const unsigned = newElectionBuilder(cfg, maxEpoch, ctx.network, params, mint).buildUnsignedTransaction();
  return { instructions: unsigned.instructions, ballots: mint.ballots };
}

/** Waits for a wallet-submitted creation and extracts the component and ballot resource. */
export async function finalizeInitiateElection(ctx, transactionId) {
  const res = await watchTransaction(ctx.provider, transactionId, { timeoutMs: 180_000 });
  const component = findComponentAddress(res);
  const ballotResource = findBallotResource(res);
  if (!component) throw new Error('no component address in receipt');
  if (!ballotResource) throw new Error('no ballot resource in receipt');
  return { componentAddress: component, ballotResource, txId: transactionId, events: events(res) };
}

/**
 * Checks that a committed transaction really is this template's `new()` for `draft`, with a mint
 * statement whose outputs are exactly the `ballots` the client sent. Throws on any mismatch.
 */
export async function verifyElectionCreation(ctx, cfg, transactionId, draft, ballots) {
  const tx = await ctx.provider.getClient().getTransaction(transactionId);
  const body = tx?.transaction?.transaction?.V1?.body ?? tx?.transaction?.V1?.body ?? tx?.transaction?.body;
  const instructions = body?.transaction?.instructions ?? body?.instructions ?? [];
  const template = String(cfg.TEMPLATE_ADDRESS).replace('template_', '');
  const call = instructions.find((i) => i?.CallFunction?.function === 'new' && String(i.CallFunction.address).replace('template_', '') === template);
  if (!call) throw new Error(`transaction ${transactionId} does not call new() on the configured template`);
  const args = call.CallFunction.args ?? [];
  if (args.length !== 7) throw new Error(`new() call has ${args.length} args, expected 7`);
  const lit = (i) => {
    const v = args[i]?.Literal;
    if (!v) throw new Error('new() call arguments are not literals');
    return v;
  };
  if (decodeCborUint(lit(1)) !== draft.voterAddresses.length) throw new Error('new() voter_count does not match the draft');
  if (decodeCborUint(lit(2)) !== draft.numCandidates || decodeCborUint(lit(3)) !== draft.numWinners) {
    throw new Error('new() candidate/winner counts do not match the draft');
  }
  if (decodeCborUint(lit(5)) !== draft.expiresAtEpoch) throw new Error('new() expires_at_epoch does not match the draft');
  if (lit(4) !== (TALLY_LITERAL[draft.tallyMethod] ?? '')) throw new Error('new() tally method does not match the draft');
  const decoded = decodeMintStatement(lit(6));
  if (decoded.outputs.length !== ballots.length || decoded.outputs.length !== draft.voterAddresses.length) {
    throw new Error('mint statement output count does not match the supplied ballots');
  }
  decoded.outputs.forEach((out, i) => {
    if (out.commitment !== ballots[i]?.commitment || out.nonce !== ballots[i]?.nonce) {
      throw new Error(`mint statement output ${i} does not match the supplied ballot`);
    }
  });
  return true;
}

function decodeCborUint(hex) {
  const buf = Buffer.from(hex, 'hex');
  if (buf[0] >> 5 !== 0) throw new Error('expected a CBOR uint');
  const ai = buf[0] & 31;
  if (ai < 24) return ai;
  if (ai === 24) return buf[1];
  if (ai === 25) return buf.readUInt16BE(1);
  if (ai === 26) return buf.readUInt32BE(1);
  if (ai === 27) return Number(buf.readBigUInt64BE(1));
  throw new Error('bad CBOR uint');
}

/** Create + initiate an election with the server's own account. */
export async function initiateElection(ctx, cfg, params) {
  const mint = buildMintStatement(ctx.network, params.voterAddresses);
  const maxEpoch = await resolveMaxEpoch(ctx.provider);
  const b = newElectionBuilder(cfg, maxEpoch, ctx.network, params, mint).feeTransactionPayFromComponent(ctx.account, 2_000_000n);
  b.addInput({ substate_id: cfg.TEMPLATE_ADDRESS.startsWith('template_') ? cfg.TEMPLATE_ADDRESS : `template_${cfg.TEMPLATE_ADDRESS}`, version: null, is_write: false });
  await accountInputs(ctx, b);
  const res = await submitAndWait(ctx, b.buildUnsignedTransaction());
  const component = findComponentAddress(res);
  const ballotResource = findBallotResource(res);
  if (!component) throw new Error('no component address in receipt');
  if (!ballotResource) throw new Error('no ballot resource in receipt');
  return { componentAddress: component, ballotResource, ballots: mint.ballots, txId: res?.transaction_id ?? null, events: events(res) };
}

// ---------- reading election state ----------
// Ootle 0.49 no longer returns method results from execution, so the state is read straight from
// the component substate and the tally is recomputed with the template's own `rcv-tally` crate
// compiled to WASM (lib/tally, built from tools/tally-wasm): same code, same result.
initTally({ module: readFileSync(new URL('./tally/rcv_tally_wasm_bg.wasm', import.meta.url)) });

const METHOD_BY_VARIANT = ['sequential-irv', 'stv', 'fptp', 'irv'];
const plain = (v) => (typeof v === 'bigint' ? Number(v) : v);

/** Component state fields, in the template's struct order. */
function parseState(component) {
  const st = component?.body?.state ?? component?.state;
  if (!Array.isArray(st) || st.length < 11) throw new Error('unexpected election component state');
  const [, , , , ballots, numCandidates, numWinners, tallyMethod, voterCount, expiresAtEpoch, active] = st;
  return {
    ballots: (ballots ?? []).map((b) => (b ?? []).map((x) => Number(plain(x)))),
    numCandidates: Number(plain(numCandidates)),
    numWinners: Number(plain(numWinners)),
    method: METHOD_BY_VARIANT[Number(plain(Array.isArray(tallyMethod) ? tallyMethod[0] : tallyMethod))],
    voterCount: Number(plain(voterCount)),
    expiresAtEpoch: Number(plain(expiresAtEpoch)),
    active: active === true,
  };
}

export function tallyBallots(method, ballots, numCandidates, numWinners) {
  return JSON.parse(runTally(method, JSON.stringify(ballots), numCandidates, numWinners));
}

export async function readElectionState(ctx, component) {
  const res = await ctx.provider.getSubstate(component);
  const value = decodeIf(res?.state?.up?.substate ?? res?.substate, decodeSubstateValue);
  const s = parseState(value?.Component);
  return {
    voterCount: s.voterCount,
    ballotCount: s.ballots.length,
    vaultBalance: s.ballots.length,
    active: s.active,
    ballots: s.ballots,
    result: tallyBallots(s.method, s.ballots, s.numCandidates, s.numWinners),
  };
}

/** End the vote: method = 'end_vote' (initiator) or 'end_vote_expired' (anyone, after the deadline). */
export async function endVote(ctx, component, method) {
  const maxEpoch = await resolveMaxEpoch(ctx.provider);
  const b = TransactionBuilder.new(ctx.network, maxEpoch)
    .callMethod({ componentAddress: component, methodName: method }, [])
    .feeTransactionPayFromComponent(ctx.account, 300_000n);
  await componentInputs(ctx, b, component, true);
  await accountInputs(ctx, b);
  const res = await submitAndWait(ctx, b.buildUnsignedTransaction());
  const finalize = finalizeOf(res);
  acceptOf(finalize);
  const state = await readElectionState(ctx, component);
  return { result: state.result, events: events(res), txId: res.transaction_id };
}

export async function currentEpoch(ctx) {
  return ctx.provider.getCurrentEpoch();
}
