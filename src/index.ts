import { MerklePath } from "@bsv/sdk";
import { SQL } from "bun";
import { parseArgs } from "util";

const { values: args } = parseArgs({
  options: {
    execute: { type: "boolean", default: false },
    "min-age-minutes": { type: "string", default: "60" },
    limit: { type: "string", default: "100000" },
    "arcade-config": { type: "string", default: `${process.env.HOME}/Code/arcade/config.yaml` },
    "arcade-url": { type: "string", default: "http://localhost:3011" },
    junglebus: { type: "string", default: "https://junglebus.gorillapool.io" },
  },
});

const STATUSES = ["ACCEPTED_BY_NETWORK", "SEEN_ON_NETWORK", "SEEN_MULTIPLE_NODES"];

// DSN and callback token come from arcade's own config unless overridden by env.
const configText = await Bun.file(args["arcade-config"]!).text();
const dsn = process.env.ARCADE_DSN ?? configText.match(/dsn:\s*"?(postgres:\/\/[^"\s]+)"?/)?.[1];
const token = process.env.ARCADE_CALLBACK_TOKEN ?? configText.match(/callback_token:\s*"?([^"\s]+)"?/)?.[1];
if (!dsn || !token) throw new Error("could not resolve arcade DSN or callback token");

const sql = new SQL(dsn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StuckTx {
  txid: string;
  status: string;
  created_at: Date;
}

const stuck: StuckTx[] = await sql`
  SELECT txid, status, created_at FROM transactions
  WHERE status IN ${sql(STATUSES)}
    AND created_at < now() - make_interval(mins => ${Number(args["min-age-minutes"])})
  ORDER BY created_at
  LIMIT ${Number(args.limit)}`;
console.log(`stuck transactions older than ${args["min-age-minutes"]}m: ${stuck.length}`);

// Fetch junglebus proofs, grouping mined txs by block height.
interface BlockGroup {
  height: number;
  txids: string[];
  path: MerklePath;
}
const blocks = new Map<number, BlockGroup>();
const noProof: string[] = [];

for (const tx of stuck) {
  const res = await fetch(`${args.junglebus}/v1/transaction/proof/${tx.txid}`);
  if (!res.ok) {
    noProof.push(tx.txid);
    await sleep(150);
    continue;
  }
  const proof = (await res.json()) as { blockHeight: number; path: MerklePath["path"] };
  const path = new MerklePath(proof.blockHeight, proof.path);
  const group = blocks.get(proof.blockHeight);
  if (group) {
    group.path.combine(path);
    group.txids.push(tx.txid);
  } else {
    blocks.set(proof.blockHeight, { height: proof.blockHeight, txids: [tx.txid], path });
  }
  await sleep(150);
}
console.log(`proofs found: ${stuck.length - noProof.length} across ${blocks.size} blocks; no proof (not mined or junglebus lagging): ${noProof.length}`);

// Resolve each block's hash + merkle root from junglebus headers. Arcade
// validates the compound BUMP against this root before persisting anything.
interface Deliverable extends BlockGroup {
  blockHash: string;
  merkleRoot: string;
}
const deliverables: Deliverable[] = [];
const headerFailed: number[] = [];

for (const group of blocks.values()) {
  const res = await fetch(`${args.junglebus}/v1/block_header/get/${group.height}`);
  if (!res.ok) {
    headerFailed.push(group.height);
    await sleep(150);
    continue;
  }
  const header = (await res.json()) as { hash: string; merkleroot: string };
  deliverables.push({ ...group, blockHash: header.hash, merkleRoot: header.merkleroot });
  await sleep(150);
}
if (headerFailed.length) console.log(`header fetch failed — skipped heights: ${headerFailed.join(", ")}`);

if (!args.execute) {
  for (const d of deliverables) {
    console.log(`[dry-run] block ${d.height} (${d.blockHash}): would deliver stump covering ${d.txids.length} tx(s)`);
  }
  console.log(`dry run complete: ${deliverables.length} blocks ready, ${headerFailed.length} header failures, ${noProof.length} unproven`);
  await sql.close();
  process.exit(0);
}

// Deliver per block: STUMP, then single-subtree BLOCK_PROCESSED.
const callback = async (body: object) => {
  const res = await fetch(`${args["arcade-url"]}/api/v1/merkle-service/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`callback rejected: ${res.status} ${await res.text()}`);
};

for (const d of deliverables) {
  await callback({
    type: "STUMP",
    txid: d.txids[0],
    blockHash: d.blockHash,
    subtreeIndex: 0,
    stump: d.path.toHex(),
  });
  await callback({
    type: "BLOCK_PROCESSED",
    blockHash: d.blockHash,
    merkleRoot: d.merkleRoot,
    subtreeCount: 1,
    subtreeHashes: [d.merkleRoot],
    // arcade's callbackBlockData requires a non-empty coinbaseBump before it
    // will use ANY of the enriched fields (falling back to a datahub fetch
    // otherwise). In the single-subtree case the coinbase path is never
    // dereferenced, so the block's own BUMP satisfies the gate.
    coinbaseBump: d.path.toHex(),
    expectedSubtreeIndices: [0],
  });
  console.log(`delivered block ${d.height}: ${d.txids.length} tx(s)`);
  await sleep(250);
}

// The bump-builder works through its queue asynchronously; poll for convergence.
console.log("waiting for arcade to process...");
const allTxids = deliverables.flatMap((d) => d.txids);
let mined = 0;
for (let attempt = 0; attempt < 20; attempt++) {
  await sleep(15000);
  const rows: { n: string }[] = await sql`
    SELECT COUNT(*) AS n FROM transactions WHERE txid IN ${sql(allTxids)} AND status = 'MINED'`;
  mined = Number(rows[0]?.n ?? 0);
  console.log(`MINED: ${mined}/${allTxids.length}`);
  if (mined === allTxids.length) break;
}

if (mined < allTxids.length) {
  const still: { txid: string; status: string }[] = await sql`
    SELECT txid, status FROM transactions WHERE txid IN ${sql(allTxids)} AND status != 'MINED' LIMIT 20`;
  console.log("not converged:", still);
}
console.log(`done: ${mined}/${allTxids.length} mined, ${noProof.length} unproven skipped, ${headerFailed.length} header-failure skipped`);
await sql.close();
