// Monitor loop (keeper/e2e/LISTING-AGENT-PLAN.md, step 4).
//
// For every market in app/ui/fixtures.json:
//   Open  + now >= lockTime            → lock_fixture
//   Locked + feed has game_finalised   → validate_score (real txoracle CPI)
//   ScoreValidated                     → settle:
//       ≥2 stakers, distinct D → submit_settlement (fast path §5.5)
//       else                   → compute_distances_batch (pipeline §5.4) which
//                                flips the fixture to Void → stakes refundable
//   G2 recheck: if finalised but the daily root PDA for the record's day is
//   absent, leave Locked and warn (program would reject the CPI anyway).
// Registry state/pool/stakers are refreshed from chain on every pass.
//
// One pass per invocation (cron-friendly). LOOP=1 to poll forever.
//
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET="$HOME/Player and match score perps/app/keeper/.keys/keeper-devnet.json" \
//   TOKEN_MINT_ADDRESS=4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG \
//   npx tsx examples/devnet/monitor.ts

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { Txoracle } from "./types/txoracle";
import TxoracleJson from "./idl/txoracle.json";
import PpIdl from "./player_perps.idl.json";
import * as users from "./common/users";
import { settle, distanceA, DEFAULT_DIST_PARAMS, DEFAULT_PAYOUT_PARAMS } from "./engine.ts";
import * as fs from "fs";

const AUTH_CACHE = "/tmp/txline-auth.json";
const FIXTURES_JSON = process.env.FIXTURES_JSON ?? process.env.HOME + "/Player and match score perps/app/ui/fixtures.json";
const DAY_MS = 86_400_000;
const POLL_MS = Number(process.env.POLL_MS ?? 60_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = (o: any, ...names: string[]) => { for (const n of names) if (o?.[n] !== undefined) return o[n]; return undefined; };
const parseHash = (h: any): number[] => { const raw = h?.hash ?? h; return typeof raw === "string" ? Array.from(raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64")) : Array.from(raw); };
const mapProof = (p: any[]) => (p ?? []).map((n: any) => ({ hash: parseHash(n), isRightSibling: n.isRightSibling ?? false }));
const statusName = (s: any) => Object.keys(s ?? {})[0] ?? "?";

async function findFinalisedSeq(api: any, fixtureId: number): Promise<number | null> {
  const { data } = await api.get(`/scores/snapshot/${fixtureId}`);
  const recs: any[] = Array.isArray(data) ? data : (data?.records ?? data?.updates ?? []);
  const seqs = recs
    .filter((r) => pick(r, "Action", "action") === "game_finalised")
    .map((r) => Number(pick(r, "Seq", "seq")))
    .filter((s) => Number.isInteger(s) && s > 0);
  return seqs.length ? Math.max(...seqs) : null;
}

async function fetchProof(api: any, fixtureId: number, seq: number) {
  const { data: val } = await api.get(`/scores/stat-validation-v3?fixtureId=${fixtureId}&seq=${seq}&statKeys=1,2`);
  const targetTs = Number(val.summary.updateStats.minTimestamp);
  const payload = {
    ts: new BN(targetTs),
    fixtureSummary: {
      fixtureId: new BN(val.summary.fixtureId),
      updateStats: { updateCount: val.summary.updateStats.updateCount, minTimestamp: new BN(val.summary.updateStats.minTimestamp), maxTimestamp: new BN(val.summary.updateStats.maxTimestamp) },
      eventsSubTreeRoot: parseHash(val.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: mapProof(val.subTreeProof), mainTreeProof: mapProof(val.mainTreeProof), eventStatRoot: parseHash(val.eventStatRoot),
    leaves: val.statsToProve.map((l: any) => ({ stat: l.stat, statProof: mapProof(l.statProof) })),
    leafIndices: val.multiproof.indices, multiproofHashes: mapProof(val.multiproof.hashes),
  };
  if (payload.leaves[0].stat.key !== 1 || payload.leaves[1].stat.key !== 2)
    throw new Error(`bad stat key order: ${payload.leaves.map((l: any) => l.stat.key)}`);
  return { payload, home: Number(payload.leaves[0].stat.value), away: Number(payload.leaves[1].stat.value), epochDay: Math.floor(targetTs / DAY_MS) };
}

async function pass(ctx: { pp: Program; txo: Program<Txoracle>; keeper: anchor.web3.Keypair; api: any; conn: anchor.web3.Connection }) {
  const { pp, txo, keeper, api, conn } = ctx;
  const reg = JSON.parse(fs.readFileSync(FIXTURES_JSON, "utf8"));
  const now = Math.floor(Date.now() / 1000);

  for (const m of reg.markets) {
    const pda = new PublicKey(m.pda);
    let fx: any;
    try { fx = await (pp.account as any).fixture.fetch(pda); }
    catch (e: any) { console.warn(`${m.home}-${m.away}: fixture fetch failed (${e?.message}), skipping`); continue; }
    let st = statusName(fx.status);
    const tag = `${m.home}-${m.away} (${m.fixtureId})`;

    // Open past lock → lock (permissionless)
    if (st === "open" && now >= Number(fx.lockTime)) {
      await pp.methods.lockFixture().accountsStrict({ fixture: pda }).rpc();
      st = "locked";
      console.log(`✓ ${tag} locked (KO reached, pool ${fx.totalPool.toString()}, ${fx.stakerCount} stakers)`);
      await sleep(1500);
    }

    // Locked → look for finalisation, then validate on-chain
    if (st === "locked") {
      const seq = await findFinalisedSeq(api, m.fixtureId);
      if (seq === null) { console.log(`· ${tag} locked, not finalised yet`); }
      else {
        const proof = await fetchProof(api, m.fixtureId, seq);
        // G2 recheck: root for the record's day must exist
        const [rootPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("daily_scores_roots"), new BN(proof.epochDay).toArrayLike(Buffer, "le", 2)], txo.programId);
        if (!(await conn.getAccountInfo(rootPda))) {
          console.warn(`⚠ ${tag} finalised ${proof.home}-${proof.away} but daily root day ${proof.epochDay} absent — leaving Locked`);
        } else {
          const sig = await pp.methods.validateScore(proof.payload as any, proof.home, proof.away)
            .accountsStrict({ fixture: pda, dailyScoresMerkleRoots: rootPda, txoracleProgram: txo.programId })
            .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
          st = "scoreValidated";
          m.actualHome = proof.home; m.actualAway = proof.away;
          m.validateSig = sig; m.proofSeq = seq;
          console.log(`✓ ${tag} score ${proof.home}-${proof.away} validated on-chain (seq ${seq}) tx ${sig}`);
          await sleep(1500);
        }
      }
    }

    // ScoreValidated → settle
    if (st === "scoreValidated") {
      fx = await (pp.account as any).fixture.fetch(pda);
      const accounts = await (pp.account as any).stakePosition.all([{ memcmp: { offset: 8, bytes: pda.toBase58() } }]);
      const positions = accounts.map((a: any) => ({
        pubkey: a.publicKey, guessHome: a.account.guessHome, guessAway: a.account.guessAway,
        stake: BigInt(a.account.stakeAmount.toString()),
      }));
      const ah = fx.actualHome, aa = fx.actualAway;
      const ep = positions.map((p: any) => ({ stake: p.stake, d: distanceA(p.guessHome, p.guessAway, ah, aa, DEFAULT_DIST_PARAMS) }));
      const res = settle(ep, DEFAULT_PAYOUT_PARAMS);

      if (res.void !== null) {
        // Fast path can't set Void — run the pipeline's distance phase, which
        // detects <2 stakers / all-equal-D and flips status to Void (refunds).
        const sig = await pp.methods.computeDistancesBatch()
          .accountsStrict({ keeper: keeper.publicKey, fixture: pda })
          .remainingAccounts(positions.map((p: any) => ({ pubkey: p.pubkey, isSigner: false, isWritable: true })))
          .rpc();
        st = "void";
        m.settleSig = sig;
        console.log(`✓ ${tag} VOID (${res.void}) — stakes refundable via claim, tx ${sig}`);
      } else {
        const paid = res.outcomes.reduce((s: bigint, o: any) => s + o.payout, 0n);
        if (paid + res.platformCut !== res.totalPool) throw new Error(`${tag} conservation check failed — not submitting`);
        const sig = await pp.methods.submitSettlement(new BN(res.medianD.toString()), new BN(res.platformCut.toString()),
          res.outcomes.map((o: any, i: number) => ({ distanceD: new BN(ep[i].d.toString()), isWinner: o.isWinner, accuracyA: new BN(o.a.toString()), payoutAmount: new BN(o.payout.toString()) })))
          .accountsStrict({ authority: keeper.publicKey, fixture: pda })
          .remainingAccounts(positions.map((p: any) => ({ pubkey: p.pubkey, isSigner: false, isWritable: true })))
          .rpc();
        st = "settled";
        m.settleSig = sig;
        console.log(`✓ ${tag} SETTLED — median D ${res.medianD}, take ${res.platformCut}, ${res.outcomes.filter((o: any) => o.isWinner).length} winners, tx ${sig}`);
      }
      await sleep(1500);
    }

    if (!["open", "locked", "scoreValidated"].includes(st)) console.log(`· ${tag} ${st}`);
    m.state = st[0].toUpperCase() + st.slice(1);
    m.stakerCount = fx.stakerCount;
    m.totalPool = Number(fx.totalPool.toString());
    if (fx.actualHome !== undefined && st === "settled") { m.actualHome = fx.actualHome; m.actualAway = fx.actualAway; }
  }

  reg.updated = Date.now();
  fs.writeFileSync(FIXTURES_JSON, JSON.stringify(reg, null, 1));
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const keeper = (provider.wallet as anchor.Wallet).payer;
  const txo = new Program<Txoracle>(TxoracleJson as unknown as Txoracle, provider);
  const pp = new Program(PpIdl as anchor.Idl, provider);

  let cached: any = {}; try { cached = JSON.parse(fs.readFileSync(AUTH_CACHE, "utf8")); } catch {}
  await users.setupUser("Keeper", process.env.ANCHOR_WALLET!, new PublicKey(process.env.TOKEN_MINT_ADDRESS!), provider.connection, txo, 1, 4, [], cached.jwt, cached.apiToken);
  fs.writeFileSync(AUTH_CACHE, JSON.stringify({ jwt: users.authState.jwt, apiToken: users.authState.apiToken }));

  const ctx = { pp, txo, keeper, api: users.apiClient, conn: provider.connection };
  do {
    console.log(`\n[${new Date().toISOString()}] monitor pass`);
    try { await pass(ctx); } catch (e: any) { console.error("pass error:", e?.error?.errorMessage ?? e?.message ?? e); if (e?.logs) console.error(e.logs.slice(-8).join("\n")); }
    if (process.env.LOOP === "1") await sleep(POLL_MS);
  } while (process.env.LOOP === "1");
}
main().catch((e) => { console.error("MONITOR FAILED:", e?.message ?? e); process.exit(1); });
