// Prints, one per line, N freshly built mint statements as JSON followed by their CBOR hex from
// encodeMintStatement. Pipe the JSON lines through the Rust codec (stmt-cbor) and compare:
//   node scripts/check-mint-cbor.mjs json > s.jsonl; node scripts/check-mint-cbor.mjs ... (see README)
import { generateOotleAddress, generateOotleSecretKey, ootlePublicKeyFromSecretKey } from '@tari-project/ootle-wasm';
import { Network } from '@tari-project/ootle';
import { buildMintStatement, decodeMintStatement } from '../lib/mint.mjs';

const addr = () => {
  const k = generateOotleSecretKey();
  const pk = ootlePublicKeyFromSecretKey(k.owner_key, k.view_key);
  return generateOotleAddress(new Uint8Array(pk.owner_key), new Uint8Array(pk.view_key), Network.Esmeralda);
};
for (const n of [1, 2, 3, 7, 16]) {
  const m = buildMintStatement(Network.Esmeralda, Array.from({ length: n }, addr));
  const d = decodeMintStatement(m.encodedHex);
  if (d.outputs.length !== n || d.revealedInputAmount !== n) throw new Error('decode round-trip failed');
  d.outputs.forEach((o, i) => {
    if (o.commitment !== m.ballots[i].commitment || o.nonce !== m.ballots[i].nonce) throw new Error('ballot mismatch');
  });
  console.log(m.statementJson + '\t' + m.encodedHex);
}
