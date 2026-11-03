// Builds the stealth mint statement for an election: one amount-1 stealth ballot UTXO per voter,
// with `voter_count` as the revealed input amount.
//
// The statement itself comes from ootle-wasm's `buildStealthTransferStatement` (Ootle 0.49), which
// produces the outputs, the aggregate range proof and the balance proof in one call. This file only
// serializes it to the CBOR the template's `new()` decodes (`StealthTransferStatement` in
// tari_template_lib_types 0.37). The encoder is checked byte-for-byte against the Rust codec by
// `scripts/check-mint-cbor.mjs`.
import {
  buildStealthTransferStatement,
  createStealthOutputWitness,
  parseOotleAddress,
  validateStealthTransfer,
} from '@tari-project/ootle-wasm';

// The ballot resource does not exist yet when the statement is built (its address is allocated in
// the same transaction). The resource address only feeds the output's encrypted memo context, so
// any value works; the engine binds outputs to the resource the instruction names.
const PLACEHOLDER_RESOURCE = 'resource_' + '0'.repeat(64);

// --- minimal CBOR encoder (the subset minicbor's derive emits for this type) ---

function head(major, n) {
  n = BigInt(n);
  const m = major << 5;
  if (n < 24n) return Uint8Array.of(m | Number(n));
  if (n < 256n) return Uint8Array.of(m | 24, Number(n));
  if (n < 65536n) return Uint8Array.of(m | 25, Number(n >> 8n), Number(n & 255n));
  if (n < 4294967296n) {
    return Uint8Array.of(m | 26, Number((n >> 24n) & 255n), Number((n >> 16n) & 255n), Number((n >> 8n) & 255n), Number(n & 255n));
  }
  const b = new Uint8Array(9);
  b[0] = m | 27;
  for (let i = 8; i >= 1; i--) {
    b[i] = Number(n & 255n);
    n >>= 8n;
  }
  return b;
}

const uint = (n) => head(0, n);
const arr = (n) => head(4, n);
const NULL = Uint8Array.of(0xf6);
const hexToU8 = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const u8ToHex = (b) => Buffer.from(b).toString('hex');
const bytes = (hex) => {
  const u8 = hexToU8(hex);
  return concat(head(2, u8.length), u8);
};

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// minicbor encodes a derived enum variant as [index, [fields...]].
const variant = (index, ...fields) => concat(arr(2), uint(index), arr(fields.length), ...fields);

function encodeAuth(auth) {
  if (auth.Key) return variant(0, bytes(auth.Key));
  if (auth.Script) return variant(1, bytes(auth.Script));
  if (auth.KeyAndScript) return variant(2, bytes(auth.KeyAndScript.spend_key), bytes(auth.KeyAndScript.condition_root));
  throw new Error('unsupported spend authorization: ' + JSON.stringify(auth));
}

function encodeOutput(o) {
  if (o.output.viewable_balance_proof) throw new Error('viewable balance proofs are not used for ballots');
  // `viewable_balance_proof` (field 4) is None, and minicbor leaves a trailing None field out.
  const body = concat(
    arr(4),
    bytes(o.output.commitment),
    bytes(o.output.sender_public_nonce),
    bytes(o.output.encrypted_data),
    uint(o.output.minimum_value_promise),
  );
  return concat(arr(3), body, encodeAuth(o.auth), uint(o.tag));
}

/** Serialize a statement (the wasm's JSON form) to the CBOR hex used as the `new()` argument. */
export function encodeMintStatement(stmt) {
  if (stmt.inputs_statement.inputs.length) throw new Error('a ballot mint has no stealth inputs');
  if (stmt.covenant_claims?.length) throw new Error('a ballot mint has no covenant claims');
  if (stmt.outputs_statement.revealed_output) throw new Error('a ballot mint reveals no output');
  const inputs = concat(arr(2), arr(0), uint(stmt.inputs_statement.revealed_amount));
  const outs = stmt.outputs_statement.outputs;
  const outputs = concat(arr(3), arr(outs.length), ...outs.map(encodeOutput), NULL, bytes(stmt.outputs_statement.agg_range_proof));
  const balance = stmt.balance_proof
    ? concat(arr(2), bytes(stmt.balance_proof.public_nonce), bytes(stmt.balance_proof.signature))
    : NULL;
  return u8ToHex(concat(arr(4), inputs, outputs, balance, arr(0)));
}

/**
 * Build the mint statement for `voterAddresses` (otl_… addresses).
 * Returns { statement, statementJson, encodedHex, ballots }; ballots[i] = { address, commitment, nonce }.
 */
export function buildMintStatement(network, voterAddresses) {
  const witnesses = voterAddresses.map((addr) => {
    const p = parseOotleAddress(addr);
    return createStealthOutputWitness(network, new Uint8Array(p.owner_key), new Uint8Array(p.view_key), 1n, PLACEHOLDER_RESOURCE, null, null, null, 1n);
  });
  const count = BigInt(voterAddresses.length);
  const statementJson = buildStealthTransferStatement('[]', count, '[' + witnesses.join(',') + ']', 0n, new Uint8Array(32));
  validateStealthTransfer(statementJson, null);
  const statement = JSON.parse(statementJson);
  const ballots = statement.outputs_statement.outputs.map((o, i) => ({
    address: voterAddresses[i],
    commitment: o.output.commitment,
    nonce: o.output.sender_public_nonce,
  }));
  return { statement, statementJson, encodedHex: encodeMintStatement(statement), ballots };
}

// --- minimal CBOR decoder, the inverse of the encoder (used to verify wallet-signed creations) ---

function cborDecode(buf) {
  let pos = 0;
  const readHead = () => {
    const ib = buf[pos++];
    const mt = ib >> 5;
    let ai = ib & 31;
    if (ai === 24) ai = buf[pos++];
    else if (ai === 25) {
      ai = (buf[pos] << 8) | buf[pos + 1];
      pos += 2;
    } else if (ai === 26) {
      ai = ((buf[pos] << 24) >>> 0) + (buf[pos + 1] << 16) + (buf[pos + 2] << 8) + buf[pos + 3];
      pos += 4;
    } else if (ai === 27) {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buf[pos + i]);
      pos += 8;
      return [mt, v];
    } else if (ai === 31) throw new Error('indefinite-length CBOR not supported');
    return [mt, ai];
  };
  const item = () => {
    const [mt, ai] = readHead();
    if (mt === 0) return ai;
    if (mt === 1) return -1 - Number(ai);
    if (mt === 2) {
      const b = buf.slice(pos, pos + ai);
      pos += ai;
      return b;
    }
    if (mt === 3) {
      const s = Buffer.from(buf.slice(pos, pos + ai)).toString();
      pos += ai;
      return s;
    }
    if (mt === 4) return Array.from({ length: Number(ai) }, item);
    if (mt === 5) {
      const m = {};
      for (let i = 0; i < ai; i++) m[String(item())] = item();
      return m;
    }
    if (mt === 6) return { tag: ai, value: item() };
    if (mt === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22 || ai === 23) return null;
      throw new Error('unsupported simple value ' + ai);
    }
    throw new Error('unsupported major type ' + mt);
  };
  return item();
}

/** Decode a mint-statement CBOR hex back into `{ inputs, revealedInputAmount, outputs, revealedOutputAmount }`. */
export function decodeMintStatement(hex) {
  const v = cborDecode(hexToU8(hex));
  if (!Array.isArray(v) || v.length !== 4) throw new Error('mint statement: expected a 4-element array');
  const [inputsStmt, outputsStmt] = v;
  const outputs = (outputsStmt?.[0] ?? []).map((out) => {
    const body = out?.[0];
    if (!Array.isArray(body) || !(body[0] instanceof Uint8Array) || !(body[1] instanceof Uint8Array)) {
      throw new Error('mint statement: output body malformed');
    }
    return { commitment: u8ToHex(body[0]), nonce: u8ToHex(body[1]) };
  });
  const revealedOutput = outputsStmt?.[1];
  return {
    inputs: (inputsStmt?.[0] ?? []).length,
    revealedInputAmount: inputsStmt?.[1] ?? 0,
    outputs,
    revealedOutputAmount: Array.isArray(revealedOutput) ? revealedOutput[0] : 0,
  };
}
