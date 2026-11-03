// Confidential RCV web server.
// Serves the static front end and a small JSON API for the election lifecycle.
// The initiator's wallet keys live in config.env (gitignored).
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { generateOotleSecretKey } from '@tari-project/ootle-wasm';
import {
  MAX_VOTERS,
  accountBalance,
  currentEpoch,
  endVote,
  finalizeInitiateElection,
  initiateElection,
  makeContext,
  prepareInitiateElection,
  readElectionState,
  setupAccount,
  verifyElectionCreation,
} from './lib/chain.mjs';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT || 80);
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'config.env');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'elections.json');

// --- config ---
function loadConfig() {
  const cfg = {};
  if (existsSync(CONFIG_FILE)) {
    for (const line of readFileSync(CONFIG_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) cfg[m[1]] = m[2];
    }
  }
  if (!cfg.OWNER_KEY_HEX || !cfg.VIEW_KEY_HEX) {
    const k = generateOotleSecretKey();
    cfg.OWNER_KEY_HEX = Buffer.from(k.owner_key).toString('hex');
    cfg.VIEW_KEY_HEX = Buffer.from(k.view_key).toString('hex');
    writeFileSync(
      CONFIG_FILE,
      `# generated on first run — keep private\nNETWORK=${cfg.NETWORK || 'esmeralda'}\nOOTLE_INDEXER_URL=${cfg.OOTLE_INDEXER_URL || ''}\nTEMPLATE_ADDRESS=${cfg.TEMPLATE_ADDRESS || ''}\nOWNER_KEY_HEX=${cfg.OWNER_KEY_HEX}\nVIEW_KEY_HEX=${cfg.VIEW_KEY_HEX}\nPORT=${PORT}\nDATA_FILE=${DATA_FILE}\n`,
    );
  }
  if (!cfg.TEMPLATE_ADDRESS) {
    console.error('[rcv] TEMPLATE_ADDRESS not set in config.env — publish the template and set it');
  }
  return cfg;
}

const cfg = loadConfig();
const ctx = await makeContext(cfg);

// Approximate epoch length in seconds. Esmeralda epochs are ~20-30 min; the value is
// configurable via EPOCH_DURATION_SECS and only used to translate between wall-clock
// time and epoch numbers (the on-chain deadline is always the epoch).
const EPOCH_DURATION_SECS = Number(cfg.EPOCH_DURATION_SECS || 1200);

function epochToUtc(epoch, currentEpoch) {
  const secs = (epoch - currentEpoch) * EPOCH_DURATION_SECS;
  return new Date(Date.now() + secs * 1000).toISOString();
}

function utcToEpochDelta(utcIso, currentEpoch) {
  const target = Date.parse(utcIso);
  if (Number.isNaN(target)) throw new Error('invalid endUtc date');
  const diffSecs = (target - Date.now()) / 1000;
  return Math.ceil(diffSecs / EPOCH_DURATION_SECS);
}

// --- persistence ---
function loadElections() {
  if (!existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8')).elections ?? [];
  } catch {
    return [];
  }
}

function saveElections(list) {
  mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify({ elections: list }, null, 2));
}

let elections = loadElections();

// Elections from before an Ootle network reset point at a template that no longer exists. They are
// kept in the data file but hidden from the site.
const isCurrent = (e) => e.templateAddress === cfg.TEMPLATE_ADDRESS;
const visible = () => elections.filter(isCurrent);

// Live state is read with four dry-runs per election; cache it briefly so many viewers polling the
// same election do not multiply the indexer load.
const stateCache = new Map();
async function cachedState(e) {
  const hit = stateCache.get(e.id);
  if (hit && Date.now() - hit.at < 6000) return hit.value;
  const pending = readElectionState(ctx, e.componentAddress).then(
    (value) => (stateCache.set(e.id, { at: Date.now(), value }), value),
    (err) => ({ error: String(err.message || err) }),
  );
  stateCache.set(e.id, { at: Date.now(), value: pending });
  return pending;
}

function publicElection(e) {
  return {
    id: e.id,
    title: e.title,
    createdAt: e.createdAt,
    componentAddress: e.componentAddress,
    ballotResource: e.ballotResource,
    templateAddress: e.templateAddress,
    tallyMethod: e.tallyMethod,
    numWinners: e.numWinners,
    numCandidates: e.numCandidates,
    candidates: e.candidates,
    voters: e.voters,
    expiresAtEpoch: e.expiresAtEpoch,
    expiresAtUtc: e.expiresAtUtc ?? null,
    resultSchema: e.resultSchema ?? 'legacy',
    status: e.status,
    txId: e.txId,
    initiator: e.initiator ?? 'server',
    endResult: e.endResult ?? null,
    endedAt: e.endedAt ?? null,
  };
}

// --- http ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mjs': 'text/javascript',
};
const STATIC = new Set(['app.js', 'style.css', 'vote.js', 'wallet.js', 'ui.js', 'results.js', 'favicon.svg']);
// The tally WASM is also served so browsers can recount the public ballots themselves.
const TALLY = { '/tally/rcv_tally_wasm.js': 'text/javascript', '/tally/rcv_tally_wasm_bg.wasm': 'application/wasm' };
const VENDOR = { '/vendor/qrcode.js': 'node_modules/qrcode-generator/qrcode.js' };

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 2_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

// Cloudflare in front of the site gives JS/CSS a long browser TTL, so every asset URL in the HTML
// carries a content hash: a deploy changes the URL and nobody gets new HTML with stale scripts.
const BUILD = (() => {
  const h = createHash('sha256');
  for (const f of readdirSync(PUBLIC_DIR).sort()) h.update(f).update(readFileSync(path.join(PUBLIC_DIR, f)));
  h.update(readFileSync(path.join(ROOT, 'lib', 'tally', 'rcv_tally_wasm_bg.wasm')));
  return h.digest('hex').slice(0, 10);
})();
const stamp = (html) => html.replace(/(src|href)="(\/(?:[\w.-]+\/)?[\w.-]+\.(?:js|css|svg))"/g, `$1="$2?v=${BUILD}"`);

async function serveStatic(req, res, rel) {
  try {
    let data = await readFile(path.join(PUBLIC_DIR, rel));
    if (rel.endsWith('.html')) data = stamp(data.toString('utf8'));
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(rel)] || 'text/plain',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // static
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html')) return serveStatic(req, res, 'index.html');
    if ((req.method === 'GET' || req.method === 'HEAD') && STATIC.has(p.slice(1))) return serveStatic(req, res, p.slice(1));
    if ((req.method === 'GET' || req.method === 'HEAD') && VENDOR[p]) {
      const data = await readFile(path.join(ROOT, VENDOR[p]));
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=86400' });
      return res.end(data);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && TALLY[p]) {
      const data = await readFile(path.join(ROOT, 'lib', p));
      res.writeHead(200, { 'Content-Type': TALLY[p], 'Cache-Control': 'public, max-age=3600' });
      return res.end(data);
    }
    // Separate, minimal-input voter page -- linked from the initiator console after an election is
    // created, never requires typing a component/resource/commitment by hand (see vote.js).
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/vote' || p === '/vote.html')) return serveStatic(req, res, 'vote.html');

    // status
    if (req.method === 'GET' && p === '/api/status') {
      const epoch = await currentEpoch(ctx);
      return sendJson(res, 200, {
        network: cfg.NETWORK,
        indexerUrl: ctx.indexerUrl,
        epoch,
        templateAddress: cfg.TEMPLATE_ADDRESS || null,
        walletAccount: ctx.account,
        walletAddress: ctx.address,
        epochDurationSecs: EPOCH_DURATION_SECS,
        maxVoters: MAX_VOTERS,
        build: BUILD,
        elections: visible().length,
      });
    }

    // setup (create account + faucet)
    if (req.method === 'POST' && p === '/api/setup') {
      const res2 = await setupAccount(ctx);
      return sendJson(res, 200, { txId: res2?.transaction_id ?? null, account: ctx.account });
    }

    // Shared parsing/validation for all three "create an election" entry points below.
    if (req.method === 'POST' && (p === '/api/elections' || p === '/api/elections/prepare')) {
      const body = JSON.parse((await readBody(req)) || '{}');
      const title = String(body.title || 'Untitled election').slice(0, 200);
      const tallyMethod = ['stv', 'sequential-irv', 'fptp'].includes(body.tallyMethod) ? body.tallyMethod : 'irv';
      const numWinners = ['irv', 'fptp'].includes(tallyMethod) ? 1 : Math.max(2, Math.min(100, Math.floor(Number(body.numWinners) || 2)));
      const numCandidates = Math.max(1, Math.min(50, Math.floor(Number(body.numCandidates) || 0)));
      const candidates = Array.isArray(body.candidates) ? body.candidates.map(String).slice(0, 50) : [];
      const voterAddresses = (Array.isArray(body.voters) ? body.voters : [])
        .map((v) => String(v).trim())
        .filter((v) => /^otl_esm_/.test(v));
      const epoch = await currentEpoch(ctx);
      let expiresInEpochs;
      if (body.endUtc) {
        expiresInEpochs = Math.max(1, Math.min(100_000, utcToEpochDelta(body.endUtc, epoch)));
      } else {
        expiresInEpochs = Math.max(1, Math.min(100_000, Math.floor(Number(body.expiresInEpochs) || 100)));
      }
      const expiresAtEpoch = epoch + expiresInEpochs;

      if (!cfg.TEMPLATE_ADDRESS) throw new Error('TEMPLATE_ADDRESS not configured');
      if (numCandidates < 2) throw new Error('at least 2 candidates required');
      if (numWinners > numCandidates) throw new Error('numWinners cannot exceed candidates');
      if (tallyMethod === 'fptp' && numWinners !== 1) throw new Error('FPTP is single-winner (numWinners must be 1)');
      if (voterAddresses.length < 1) throw new Error('at least one voter address required');
      if (voterAddresses.length !== (Array.isArray(body.voters) ? body.voters.length : 0)) {
        throw new Error('invalid voter addresses (must be otl_esm_... ootle addresses)');
      }
      if (voterAddresses.length > MAX_VOTERS) {
        throw new Error(`too many voters (this network allows up to ${MAX_VOTERS} per election)`);
      }
      if (new Set(voterAddresses).size !== voterAddresses.length) throw new Error('duplicate voter addresses');
      if (numWinners >= numCandidates && numWinners > 1) throw new Error('multi-winner elections need more candidates than seats');
      const endUtc = body.endUtc && !Number.isNaN(Date.parse(body.endUtc)) ? new Date(body.endUtc).toISOString() : null;
      const parsed = { title, tallyMethod, numWinners, numCandidates, candidates, voterAddresses, epoch, expiresInEpochs, expiresAtEpoch, endUtc };

      // This server's own account signs and submits -- unchanged, still the simplest path for
      // anyone happy to let the server hold a key.
      if (p === '/api/elections') {
        const initiated = await initiateElection(ctx, cfg, parsed);
        const record = {
          id: randomUUID(),
          title,
          createdAt: new Date().toISOString(),
          componentAddress: initiated.componentAddress,
          ballotResource: initiated.ballotResource,
          templateAddress: cfg.TEMPLATE_ADDRESS,
          tallyMethod,
          numWinners,
          numCandidates,
          candidates,
          // Deliberately never keeps the voter's address alongside the commitment: once the
          // ballot is minted, this server has no further legitimate need for an
          // address<->commitment mapping, and retaining one would be exactly the kind of
          // centrally-held deanonymization risk a stealth ballot scheme exists to avoid. Voters
          // find their own ballot later by connecting their own wallet and scanning the chain
          // (see public/vote.js), never by asking this server "which one is mine."
          voters: voterAddresses.map((_a, i) => ({
            commitment: initiated.ballots[i].commitment,
            nonce: initiated.ballots[i].nonce,
          })),
          expiresAtEpoch,
          expiresInEpochs,
          expiresAtUtc: endUtc ?? epochToUtc(expiresAtEpoch, epoch),
          resultSchema: 'v2',
          status: 'open',
          txId: initiated.txId,
          events: initiated.events,
        };
        elections.push(record);
        saveElections(elections);
        return sendJson(res, 200, publicElection(record));
      }

      // /api/elections/prepare: build the unsigned instructions only. Building the mint
      // statement needs no secret key (see chain.mjs's own comment), so this is safe to hand to
      // whichever wallet the browser has connected -- see /api/elections/finalize below for the
      // other half, once that wallet has signed and submitted them.
      const prepared = await prepareInitiateElection(ctx, cfg, parsed);
      return sendJson(res, 200, { instructions: prepared.instructions, ballots: prepared.ballots, maxFee: '2000000', draft: parsed });
    }

    // The initiator's own wallet (via window.tari) has already signed and submitted the
    // instructions /api/elections/prepare returned; this reads the committed receipt back and
    // stores the election record, exactly like /api/elections does for the server's own account.
    if (req.method === 'POST' && p === '/api/elections/finalize') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { transactionId, draft, ballots } = body;
      if (!transactionId) throw new Error('transactionId is required');
      if (!draft || !Array.isArray(ballots)) throw new Error('draft and ballots (from /api/elections/prepare) are required');
      if (!cfg.TEMPLATE_ADDRESS) throw new Error('TEMPLATE_ADDRESS not configured');
      // The client could have tampered with the draft between /prepare and /finalize, so
      // re-validate it here rather than trusting the round-trip.
      const draftVoters = Array.isArray(draft.voterAddresses) ? draft.voterAddresses.map((v) => String(v).trim()) : [];
      const validated = {
        title: String(draft.title || 'Untitled election').slice(0, 200),
        tallyMethod: ['stv', 'sequential-irv', 'fptp'].includes(draft.tallyMethod) ? draft.tallyMethod : null,
        numWinners: Math.floor(Number(draft.numWinners) || 0),
        numCandidates: Math.floor(Number(draft.numCandidates) || 0),
        candidates: Array.isArray(draft.candidates) ? draft.candidates.map(String).slice(0, 50) : [],
        voterAddresses: draftVoters.filter((v) => /^otl_esm_/.test(v)),
        expiresInEpochs: Math.floor(Number(draft.expiresInEpochs) || 0),
        expiresAtEpoch: Math.floor(Number(draft.expiresAtEpoch) || 0),
        epoch: Math.floor(Number(draft.epoch) || 0),
        endUtc: draft.endUtc && !Number.isNaN(Date.parse(draft.endUtc)) ? new Date(draft.endUtc).toISOString() : null,
      };
      if (!validated.tallyMethod) throw new Error('invalid draft tally method');
      if (validated.numCandidates < 2) throw new Error('invalid draft: at least 2 candidates required');
      if (validated.numWinners < 1 || validated.numWinners > validated.numCandidates) {
        throw new Error('invalid draft: numWinners out of range');
      }
      if (validated.tallyMethod === 'fptp' && validated.numWinners !== 1) {
        throw new Error('invalid draft: FPTP is single-winner');
      }
      if (validated.voterAddresses.length < 1 || validated.voterAddresses.length > MAX_VOTERS) {
        throw new Error('invalid draft: voter count out of range');
      }
      if (validated.voterAddresses.length !== draftVoters.length) {
        throw new Error('invalid draft: bad voter addresses');
      }
      if (!validated.expiresAtEpoch || !validated.epoch) throw new Error('invalid draft: expiry missing');
      // finalizeInitiateElection() first, not verifyElectionCreation() -- the wallet has *just*
      // submitted this transaction, and only finalizeInitiateElection() actually waits for it to
      // land (watchTransaction, up to 180s). verifyElectionCreation()'s getTransaction() call has
      // no wait/retry of its own: called first, it raced the indexer and threw "does not call
      // new() on the configured template" (instructions come back empty) whenever the indexer
      // hadn't caught up yet -- a false verification failure, not a real mismatch. Once
      // finalizeInitiateElection() returns, the transaction is guaranteed committed and indexed,
      // so verifyElectionCreation() reading the same transactionId right after is safe.
      const finalized = await finalizeInitiateElection(ctx, transactionId);
      await verifyElectionCreation(ctx, cfg, transactionId, validated, ballots);
      if (elections.some((e) => e.componentAddress === finalized.componentAddress)) {
        throw new Error('election already recorded');
      }
      const record = {
        id: randomUUID(),
        title: validated.title,
        createdAt: new Date().toISOString(),
        componentAddress: finalized.componentAddress,
        ballotResource: finalized.ballotResource,
        templateAddress: cfg.TEMPLATE_ADDRESS,
        tallyMethod: validated.tallyMethod,
        numWinners: validated.numWinners,
        numCandidates: validated.numCandidates,
        candidates: validated.candidates,
        // See the identical comment in the /api/elections branch above -- no address is stored
        // here either, for the same reason.
        voters: validated.voterAddresses.map((_a, i) => ({
          commitment: ballots[i].commitment,
          nonce: ballots[i].nonce,
        })),
        expiresAtEpoch: validated.expiresAtEpoch,
        expiresInEpochs: validated.expiresInEpochs,
        expiresAtUtc: validated.endUtc ?? epochToUtc(validated.expiresAtEpoch, validated.epoch),
        resultSchema: 'v2',
        status: 'open',
        initiator: 'wallet',
        txId: finalized.txId,
        events: finalized.events,
      };
      elections.push(record);
      saveElections(elections);
      return sendJson(res, 200, publicElection(record));
    }

    // list elections
    if (req.method === 'GET' && p === '/api/elections') {
      return sendJson(res, 200, visible().map((e) => {
        const hit = stateCache.get(e.id)?.value;
        const ballotCount = hit && !(hit instanceof Promise) && !hit.error ? hit.ballotCount : undefined;
        return { ...publicElection(e), ballotCount };
      }));
    }

    // single election + live state
    const oneMatch = p.match(/^\/api\/elections\/([^/]+)$/);
    if (oneMatch && req.method === 'GET') {
      const e = visible().find((x) => x.id === oneMatch[1]);
      if (!e) return sendJson(res, 404, { error: 'not found' });
      const epoch = await currentEpoch(ctx);
      // Keep the deadline anchored to the recorded wall-clock time; re-deriving it from the epoch on
      // every request makes it drift with epoch-length jitter.
      const fresh = { ...publicElection(e), expiresAtUtc: e.expiresAtUtc ?? epochToUtc(e.expiresAtEpoch, epoch) };
      const state = await cachedState(e);
      // Ended on-chain by someone else (e.g. `end_vote_expired` from another client): record it.
      if (state && state.active === false && e.status !== 'ended') {
        e.status = 'ended';
        e.endResult = state.result;
        e.endedAt = new Date().toISOString();
        saveElections(elections);
        fresh.status = 'ended';
        fresh.endResult = state.result;
      }
      return sendJson(res, 200, { ...fresh, epoch, state });
    }

    // end vote
    const endMatch = p.match(/^\/api\/elections\/([^/]+)\/(end|end-expired)$/);
    if (endMatch && req.method === 'POST') {
      const e = visible().find((x) => x.id === endMatch[1]);
      if (!e) return sendJson(res, 404, { error: 'not found' });
      const method = endMatch[2] === 'end-expired' ? 'end_vote_expired' : 'end_vote';
      if (e.status === 'ended') throw new Error('this election has already ended');
      const outcome = await endVote(ctx, e.componentAddress, method);
      stateCache.delete(e.id);
      e.status = 'ended';
      e.endResult = outcome.result;
      e.endEvents = outcome.events;
      e.endedAt = new Date().toISOString();
      saveElections(elections);
      return sendJson(res, 200, { ...publicElection(e), outcome });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[rcv] error:', err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`[rcv] confidential-rcv-web listening on :${PORT}`);
  console.log(`[rcv] initiator account: ${ctx.account}`);
  console.log(`[rcv] template: ${cfg.TEMPLATE_ADDRESS || '(not configured)'}`);
});