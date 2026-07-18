# Lock In — Demo Script (hackathon submission)

**Live site:** https://player-perps.vercel.app
**Length:** ~4 minutes. Do a dry run once before recording.

## Setup (before you hit record)

1. Open https://player-perps.vercel.app in a browser with **Phantom installed and unlocked**, switched to **Devnet** (Phantom → Settings → Developer settings → Testnet mode ON).
2. Have a little devnet SOL in the wallet (for tx fees). Faucet: https://faucet.solana.com if needed.
3. Open a second tab on https://explorer.solana.com/?cluster=devnet (you'll paste a tx in later).
4. **Best timing:** record while France–England or Spain–Argentina is still OPEN (France–England locks at kick-off, Sat 18 Jul 21:00 UTC; Spain–Argentina Sun 19 Jul 19:00 UTC). After both lock you can still demo, but the LOCKIN button will correctly refuse.

## The script

### 1. Landing (30s)
- Start on the homepage. Scroll slowly through hero → "Three steps" → market preview.
- Say: *"Lock In is a prediction market on Solana with a twist — you don't bet win/lose, you predict the exact final score. The closer you land, the more of the losers' pool you take. It's Trepa-style proximity scoring: skill, not coin-flips."*
- Pause on the **NO REFEREE TO BRIBE** section: *"And there's no oracle committee, no human settlement — the final score is Merkle-proven on-chain from TxLine's feed before a single cent moves."*

### 2. Markets page (20s)
- Click **Launch app**.
- Say: *"These are real World Cup fixtures, listed automatically by a keeper agent that watches the TxLine feed — France–England kicks off tonight. Available markets up top, settled ones below."*

### 3. Match page + the LOCKIN moment (60s)
- Click the **France v England** card → lands on the match page.
- Point out the on-chain strip: *"This is read live from the fixture account on devnet — escrow balance, staker count, lock countdown."*
- Click **Connect wallet** → approve in Phantom.
- Set your score with the +/– steppers (e.g. **2–1**), drag the stake slider (e.g. **$50**).
- Say: *"One click, one signature — my USDC goes into the fixture's escrow PDA with my scoreline."*
- Hit **LOCKIN** → approve in Phantom → wait for the "On-chain ✓" toast.
- **The money shot:** copy the tx signature from the toast/console, paste it into the Explorer tab: *"There it is — a real stake instruction on devnet."*

### 4. Live PnL simulation (40s)
- Back on the match page: use the demo buttons (**Home goal**, **Away goal**, **+5 min**).
- Say: *"Once the match runs, every goal re-ranks the pool. Watch my projected payout move — the chart shows what I'd win if the whistle blew right now. The leaderboard shows everyone's distance score D — beat the median and you're in the money."*
- Click a goal or two so the chart visibly swings green/white.

### 5. Trustless settlement proof (60s)
- Scroll the Closed section on the markets page → open the settled market.
- Scroll to the **Settlement proof** panel at the bottom.
- Say: *"Here's what makes this different. When the match ends, the keeper submits the final score WITH a Merkle proof. The program CPIs into TxLine's on-chain oracle, which verifies the proof against the day's published root. A tampered score is rejected by the chain itself."*
- Click the **score proof tx** link → in the Explorer, expand **Instruction logs** → point at the nested `ValidateStatV3` invocation and `Program return: … AQ==`: *"That return value is the oracle saying 'proof valid'. Then payouts are computed with exact integer math — the program re-checks that payouts plus platform take equals the pool to the cent, on-chain."*

### 6. Close (20s)
- *"Everything you saw is live on devnet: the program, the escrow, the oracle CPI, the keeper agent that lists and settles markets automatically every 10 minutes via GitHub Actions. Mainnet is a feature flag away — same engine, same proofs, real World Cup data. Lock in."*

## If something goes wrong on camera

- **Market already locked:** stake on the other open market instead, or say "markets lock at kick-off — no late bets" (it's a feature).
- **Wallet won't connect:** make sure Phantom is unlocked BEFORE loading the page, then reload.
- **RPC hiccup / tx slow:** devnet public RPC rate-limits; wait 5s and retry once. Cut and re-record that segment.
- **Fresh proof links:** after France–England finalises tonight, the keeper will validate + settle it automatically — from then on THAT market has a brand-new proof panel with live Solscan/Explorer links (the old sample proofs got pruned by devnet history, which is why they were empty).

## One-command health check (optional, before recording)

    cd "~/Player and match score perps" && node app/keeper/e2e/healthcheck.mjs
