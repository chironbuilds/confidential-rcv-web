#!/usr/bin/env node
// Voter client example: cast a ranked ballot from your own wallet.
//
// Each voter received a ballot token at election creation (see the ballot table
// in the web UI). This script spends that token privately: the ballot UTXO is
// spent via the one-time stealth key derived from your private key, so the
// transaction cannot be linked to you by any on-chain observer.
//
// Usage:
//   node scripts/cast-ballot.mjs \
//     --component component_... \
//     --resource resource_... \
//     --address otl_esm_... \
//     --owner-key <32-byte hex> \
//     --view-key <32-byte hex> \
//     --commitment <ballot commitment hex> \
//     --nonce <ballot sender nonce hex> \
//     --ranking 0,2,1
//
// Optional: --indexer <url> (default: esmeralda public indexer), --fee <max fee in µTARI>
// The fee account (derived from --owner-key) must already exist and hold tTARI.
//
// NOTE on fees: for full anonymity the fee must also be paid from a stealth
// TARI UTXO (see the template README). This example pays the fee from the
// voter's TARI account for simplicity; the canonical fully-anonymous pattern
// is implemented in the template repo's Rust integration client.
import {
  Mask,
  Network,
  OotleWallet,
  StealthInput,
  StealthInputsStatement,
  StealthOutputsStatement,
  StealthTransferStatement,
  TransactionBuilder,
  WalletStealthAuthorizer,
  WasmStealthCrypto,
  decodeEvent,
  decodeExecuteResult,
  defaultIndexerUrl,
  fromHexStr,
  getVaultIdsForAccount,
  intLiteral,
  resolveMaxEpoch,
  resolveTransaction,
  submitTransaction,
  watchTransaction,
} from '@tari-project/ootle';
import { IndexerProvider } from '@tari-project/ootle-indexer';
import { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet';
import { accountAddressFromPublicKey } from '../lib/derive.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const NETWORK = Network.Esmeralda;
const COMPONENT = arg('component');
const RESOURCE = arg('resource');
const ADDRESS = arg('address');
const OWNER_KEY = arg('owner-key');
const VIEW_KEY = arg('view-key');
const COMMITMENT = arg('commitment');
const NONCE = arg('nonce');
const RANKING = (arg('ranking') || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n));
const FEE = BigInt(arg('fee') || '500000');
const INDEXER = arg('indexer') || defaultIndexerUrl(NETWORK);

function need(name, v) {
  if (!v) {
    console.error(`missing required --${name}`);
    process.exit(2);
  }
  return v;
}
need('component', COMPONENT);
need('resource', RESOURCE);
need('address', ADDRESS);
need('owner-key', OWNER_KEY);
need('view-key', VIEW_KEY);
need('commitment', COMMITMENT);
need('nonce', NONCE);
if (!RANKING.length) {
  console.error('--ranking must be a comma-separated list of candidate ids (first = top choice)');
  process.exit(2);
}

const provider = await IndexerProvider.connect({ url: INDEXER, network: NETWORK });
const signer = SecretKeyWallet.fromSecretKey(new Uint8Array(Buffer.from(OWNER_KEY, 'hex')), NETWORK, new Uint8Array(Buffer.from(VIEW_KEY, 'hex')));
const ownerPublicKey = await signer.getPublicKey();
const account = accountAddressFromPublicKey(ownerPublicKey);
const wallet = new OotleWallet().registerKeyProvider(account, signer).setDefaultSigner(account);

const log = (m) => console.log(`[voter] ${m}`);

async function accountExists() {
  try {
    await provider.getSubstate(account);
    return true;
  } catch {
    return false;
  }
}

async function cast() {
  log(`fee account ${account}`);
  if (!(await accountExists())) {
    console.error('[voter] the fee account does not exist yet — send it some tTARI first');
    process.exit(1);
  }

  log(`spending ballot ${COMMITMENT.slice(0, 16)}… ranking=${RANKING.join(' > ')}`);

  // The SDK's StealthTransfer builder requires at least one stealth output, but a
  // ballot spend is revealed-only (the token goes straight to cast_ballot as a
  // bucket). Build the statement and spec manually instead — same shapes the
  // engine accepts (verified against the template's integration client).
  const commitment = fromHexStr(COMMITMENT);
  const inputsJson = JSON.stringify({
    inputs: [{ commitment: COMMITMENT, witness: 'KeyPath' }],
    revealed_amount: '0',
  });
  // Ootle 0.49: a revealed output names the receiver key whose signature authorises taking the
  // revealed bucket; this transaction is signed with the account key.
  const outputsJson = JSON.stringify({
    outputs: [],
    revealed_output: { amount: '1', receiver: Buffer.from(ownerPublicKey).toString('hex') },
    agg_range_proof: '',
  });
  const inputsStatement = new StealthInputsStatement([], 0n, inputsJson);
  const outputsStatement = new StealthOutputsStatement(outputsJson);
  const statement = new StealthTransferStatement(inputsStatement, outputsStatement);

  const maxEpoch = await resolveMaxEpoch(provider);
  const b = TransactionBuilder.new(NETWORK, maxEpoch);
  b.addInstruction({
    StealthTransfer: {
      resource_address_ref: { Address: RESOURCE },
      statement: { __ootleRawJson: statement.toCompactJson() },
      revealed_input_bucket: null,
    },
  });
  b.saveVar('vote');
  b.callMethod(
    { methodName: 'cast_ballot', componentAddress: COMPONENT },
    [{ Workspace: 'vote' }, { Literal: rankingCborHex(RANKING) }],
  );
  b.addFeeInstruction({
    CallMethod: {
      call: { Address: account },
      method: 'pay_fee',
      args: [intLiteral(FEE)],
    },
  });
  b.addInput({ substate_id: `utxo_${RESOURCE.replace('resource_', '')}_${COMMITMENT}`, version: null });
  b.addInput({ substate_id: RESOURCE, version: null });
  b.addInput({ substate_id: COMPONENT, version: null });
  b.addInput({ substate_id: account, version: null });
  for (const v of await getVaultIdsForAccount(provider, COMPONENT)) {
    b.addInput({ substate_id: v, version: null });
  }
  for (const v of await getVaultIdsForAccount(provider, account)) {
    b.addInput({ substate_id: v, version: null });
  }

  const spec = {
    unsignedTx: await resolveTransaction(provider, b.buildUnsignedTransaction()),
    statement,
    outputMask: Mask.zero(),
    state: {
      resource: RESOURCE,
      revealedInput: null,
      inputsToSpend: new Map([[COMMITMENT, { input: new StealthInput(commitment), owner: account }]]),
      outputs: [],
      revealedOutput: { amount: 1n, receiver: ownerPublicKey },
    },
    requiredSigners: [account],
    inputs: [{ input: new StealthInput(commitment), owner: account }],
  };

  const authorizer = WalletStealthAuthorizer.fromSpec(wallet, spec, {
    viewSecret: await signer.getViewSecret(),
    crypto: new WasmStealthCrypto(NETWORK),
  });
  const authorized = await authorizer.prepare(provider);
  const envelope = await authorized.seal();

  const txId = await submitTransaction(provider, envelope);
  log(`cast tx ${txId} …`);
  const res = await watchTransaction(provider, txId, { timeoutMs: 180_000 });
  const fin = res?.result?.Finalized;
  if (!fin || fin.final_decision !== 'Commit') {
    console.error('ballot NOT accepted:', JSON.stringify(res?.result, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 2000));
    process.exit(1);
  }
  log('ballot accepted ✓');
  const exec = typeof fin.execution_result === 'string' ? decodeExecuteResult(fin.execution_result) : fin.execution_result;
  for (const raw of exec?.finalize?.events ?? []) {
    const e = typeof raw === 'string' ? decodeEvent(raw) : raw;
    log(`event: ${e.topic} ${JSON.stringify(e.payload)}`);
  }
}

// CBOR encoding of Vec<u32>. FPTP elections take a single choice: --ranking 2
function rankingCborHex(ranking) {
  const head = (major, n) => (n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255]);
  return Buffer.from([...head(4, ranking.length), ...ranking.flatMap((r) => head(0, r))]).toString('hex');
}

cast().catch((e) => {
  console.error('[voter] failed:', e.message || e);
  process.exit(1);
});
