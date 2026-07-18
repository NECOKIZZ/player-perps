# Lock In — Technical Overview (TxLINE World Cup Track)

**Live app:** https://player-perps.vercel.app · **Repo:** https://github.com/NECOKIZZ/player-perps
**Network:** Solana devnet · Program `6krdS27r9oHpiTwHemWXwcKSns7Dj3616pFwKNDgmE26`

## Core idea

Lock In is a proximity prediction market for football scorelines. Users stake USDC on the exact
full-time score; at the whistle, payouts are weighted by how *close* each guess landed (Trepa-style
median gate + accuracy weighting) — skill beats coin-flips. Settlement is trustless: the final
score enters the program only through a Merkle proof verified on-chain via CPI into TxLINE's
`validate_stat_v3`, so no admin, multisig, or human referee can settle a wrong score.

## Architecture (three layers, one engine)

- `app/engine/` — pure-Rust fixed-point settlement engine (no floats, no Solana deps): distance
  metric + median-gate/accuracy-weight/cap-water-fill payout. 7 unit tests reproduce the spec
  scenario to the integer.
- `app/programs/player_perps/` — Anchor program. Fixture PDA escrows USDC (SPL); lifecycle
  Open → Locked → ScoreValidated → Settled/Void. `validate_score` CPIs into TxLINE's on-chain
  txoracle, pinning the daily-roots PDA and requiring `period == 100` (game_finalised) so a live
  score can never settle. Payout conservation (`Σpayouts + take == pool`) is re-checked on-chain.
- `app/keeper/` — TypeScript agents mirroring the engine byte-for-byte: `lister.ts` discovers
  upcoming fixtures from the feed and lists them; `monitor.ts` locks at kick-off, fetches the
  stat-validation-v3 proof, submits it on-chain, and settles. Runs unattended every 10 min via
  GitHub Actions; each pass commits `fixtures.json`, which redeploys the UI.
- `app/ui/` — static frontend (no build step). Reads fixture accounts directly from RPC, stakes
  via Phantom/Solflare (one signature), renders live PnL simulation and a per-market
  **Settlement proof** panel with explorer links to the validate/settle transactions.

## TxLINE endpoints used

| Endpoint | Use |
|---|---|
| `/fixtures/snapshot` | Lister discovery: upcoming fixtures, KO time, competition gates |
| `/scores/snapshot/{fixtureId}` | Monitor: watch for `game_finalised` (statusId/period 100), read final score |
| `/scores/stat-validation-v3?fixtureId&seq&statKeys=1,2` | Fetch the Merkle multiproof for total-goals stats |
| On-chain `txoracle.validate_stat_v3` (CPI) | Trustless proof verification inside our program |
| On-chain `daily_scores_roots` PDA | Pinned by seeds in `validate_score` so proofs verify against the published root |
| Subscribe/activate flow (level 1) | Free-tier auth for the keeper (JWT + API token, cached) |

## Judging-criteria highlights

- **Core functionality:** live devnet feed ingestion end-to-end — lister and monitor have listed
  and settled real fixtures unattended (proof txs linked in the UI and README).
- **Verification layer (the optional part judges value):** we built the custom check gates —
  fixture-id binding, exactly-two total-goals leaves, finalised-period guard, daily-root PDA
  pinning — on top of `validate_stat_v3`, plus tamper tests proving a forged score is rejected
  on-chain.
- **Deterministic resolution:** the same fixed-point engine runs in Rust (program), TypeScript
  (keeper), and the browser (live PnL) — one source of truth, integer-exact.

## Feedback on the TxLINE API

Liked: single normalised schema across competitions; stat-validation-v3's shared multiproof keeps
CPI transactions small (632 bytes on devnet — fits Solana's limit with room); free-tier
subscribe/activate is genuinely frictionless.
Friction: devnet carries only sample fixtures (live WC data is mainnet), so devnet demos depend on
sample finalisations; comp-430 fixture records use numeric GameState and omit SportId (we had to
read sport from the scores snapshot); devnet's daily-roots publisher occasionally skips days, which
blocks G2 listing gates.
