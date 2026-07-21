# arcade-backfill

Recovers arcade transactions stuck in a non-final status because merkle-service proof callbacks were missed (e.g. after a teranode resync). Fetches BRC-74 merkle paths from JungleBus, verifies them against block headers, and delivers them to arcade's callback endpoint as the STUMP + BLOCK_PROCESSED pair the merkle service would have sent.

Selects transactions in `ACCEPTED_BY_NETWORK`, `SEEN_ON_NETWORK`, or `SEEN_MULTIPLE_NODES` older than a threshold. Transactions without a JungleBus proof (not yet mined, or never propagated) are skipped and reported. `RECEIVED` is intentionally excluded.

## Requirements

- Runs on the arcade host. Reads the Postgres DSN and callback token from arcade's `config.yaml`; nothing is stored here.
- Arcade must be running (delivery goes through its HTTP callback endpoint).
- Postgres storage backend only.

## Usage

```bash
bun install

# dry run (default): plan only, no writes
bun run src/index.ts

# deliver
bun run src/index.ts --execute

# options (defaults shown)
bun run src/index.ts --min-age-minutes 60 --limit 100000 \
  --arcade-config ~/Code/arcade/config.yaml \
  --arcade-url http://localhost:3011 \
  --junglebus https://junglebus.gorillapool.io
```

`ARCADE_DSN` and `ARCADE_CALLBACK_TOKEN` env vars take precedence over config parsing.

## How it works

1. Query stuck transactions from arcade's Postgres.
2. Fetch each txid's merkle path from JungleBus (`/v1/transaction/proof/<txid>`).
3. Group by block, merging same-block paths into one BUMP (`MerklePath.combine`).
4. Resolve each block's hash and merkle root from JungleBus (`/v1/block_header/get/<height>`).
5. Per block, POST to arcade's callback endpoint: a `STUMP` (the full-block BUMP, with the block declared single-subtree so the BUMP is the stump), then a `BLOCK_PROCESSED` naming it. Arcade validates the compound BUMP against the merkle root before persisting, then transitions the transactions to `MINED`.
6. Poll until the delivered set converges to `MINED`; report anything that didn't.
