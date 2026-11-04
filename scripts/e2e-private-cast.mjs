// Live end-to-end check of the browser-wallet vote path, run headless against a local SDK build:
// create a 1-voter election for the SDK account, shield a fee, then cast with
// OotleAccount.redeemStealthOutputWithPrivateFee exactly as Sapient does for vote.js.
//   node scripts/e2e-private-cast.mjs <path-to-ootle-sdk dist/index.js> <seed-entropy-hex>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { makeContext, initiateElection, readElectionState, currentEpoch } from '../lib/chain.mjs';

const [sdkPath, entropy] = process.argv.slice(2);
const { OotleAccount, fromHex, configureOotleStorage, inMemoryAdapter } = await import(pathToFileURL(sdkPath).href);
configureOotleStorage(inMemoryAdapter());

const cfg = Object.fromEntries(readFileSync('config.env', 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ctx = await makeContext(cfg);
const voter = OotleAccount.fromSeed(fromHex(entropy), 0, 'esmeralda');
const voterAddress = await voter.getWalletAddress();
console.log('voter', voterAddress);

const epoch = await currentEpoch(ctx);
const init = await initiateElection(ctx, cfg, {
  title: 'e2e private cast', tallyMethod: 'irv', numWinners: 1, numCandidates: 3, candidates: ['A', 'B', 'C'],
  voterAddresses: [voterAddress], epoch, expiresInEpochs: 3, expiresAtEpoch: epoch + 3,
});
console.log('election', init.componentAddress, 'ballot resource', init.ballotResource);
const ballot = init.ballots?.[0]?.commitment;
if (!ballot) throw new Error(`no ballot commitment in initiateElection result: ${Object.keys(init)}`);

const XTR = 'resource_0101010101010101010101010101010101010101010101010101010101010101';
const shielded = await voter.shield(XTR, 500000n);
console.log('fee shielded', shielded.commitment, shielded.transactionId);

const ranking = '83020001'; // [2, 0, 1]
const res = await voter.redeemStealthOutputWithPrivateFee(
  init.ballotResource, ballot, 1n,
  [{ CallMethod: { call: { Address: init.componentAddress }, method: 'cast_ballot', args: [{ Workspace: { id: 0, offset: null } }, { Literal: ranking }] } }],
  XTR, shielded.commitment, 100000n, [init.componentAddress],
);
console.log('cast tx', res.transactionId);
const state = await readElectionState(ctx, init.componentAddress);
console.log('ballots on chain', state.ballotCount, JSON.stringify(state.ballots));
process.exit(state.ballotCount === 1 ? 0 : 1);
