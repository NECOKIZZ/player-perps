// Market-listing agent (keeper/e2e/LISTING-AGENT-PLAN.md, step 3 "List").
//
// Discovers upcoming fixtures from the TxLine feed and lists every one that
// passes ALL verifiability gates:
//   G1 feed live      — /scores/snapshot/{id} returns records
//   G2 publisher alive— daily_scores_roots PDA exists for the CURRENT epoch day
//                       (future-day roots don't exist yet by design; the program
//                       re-checks the actual root at settlement anyway)
//   G3 sport/keys     — SportId == 1 (soccer; statKeys 1/2 implemented)
//   G4 timing         — GameState scheduled + KO at least MIN_LEAD_MIN out
// For each listable fixture: initialize_fixture(id, lock_time = feed StartTime)
// then append it to app/ui/fixtures.json (the page's market registry).
//
// Safe to re-run: fixtures already on-chain are refreshed in the registry, not
// re-initialized. A bad listing can never pay out wrong — validate_score only
// accepts scores that Merkle-prove against TxLine's on-chain root; worst case
// is a market that voids/refunds.
//
// Run (from a tx-on-chain checkout with these files in examples/devnet/):
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET="$HOME/Player and match score perps/app/keeper/.keys/keeper-devnet.json" \
//   TOKEN_MINT_ADDRESS=4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG \
//   npx tsx examples/devnet/lister.ts

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Txoracle } from "./types/txoracle";
import TxoracleJson from "./idl/txoracle.json";
import PpIdl from "./player_perps.idl.json";
import * as users from "./common/users";
import { DEFAULT_DIST_PARAMS, DEFAULT_PAYOUT_PARAMS } from "./engine.ts";
import * as fs from "fs";

const AUTH_CACHE = "/tmp/txline-auth.json";
const UI_DIR = process.env.UI_DIR ?? process.env.HOME + "/Player and match score perps/app/ui";
const FIXTURES_JSON = `${UI_DIR}/fixtures.json`;
const COMPETITIONS = [72, 430]; // devnet: 72 = World Cup samples, 430 = Friendlies
const COMP_NAMES: Record<number, string> = { 72: "World Cup", 430: "Friendlies" };
const MIN_LEAD_MIN = 10; // G4: KO must be at least this far out
const DAY_MS = 86_400_000;
const SOCCER = 1;

const pick = (o: any, ...names: string[]) => { for (const n of names) if (o?.[n] !== undefined) return o[n]; return undefined; };

interface RegistryEntry {
  fixtureId: number; pda: string; escrow: string;
  home: string; away: string; homeId: number; awayId: number;
  competition: string; kickoff: number; lockTime: number;
  listedAt: number; state: string; stakerCount: number; totalPool: number;
  actualHome?: number; actualAway?: number;
}

function loadRegistry(): RegistryEntry[] {
  try { return JSON.parse(fs.readFileSync(FIXTURES_JSON, "utf8")).markets ?? []; } catch { return []; }
}
function saveRegistry(markets: RegistryEntry[]) {
  markets.sort((a, b) => a.kickoff - b.kickoff);
  fs.writeFileSync(FIXTURES_JSON, JSON.stringify({ updated: Date.now(), markets }, null, 1));
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const keeper = (provider.wallet as anchor.Wallet).payer;
  const txo = new Program<Txoracle>(TxoracleJson as unknown as Txoracle, provider);
  const pp = new Program(PpIdl as anchor.Idl, provider);

  // Escrow token: the mint the UI page is configured for.
  const cfg = fs.readFileSync(`${UI_DIR}/config.js`, "utf8");
  const usdcMint = new PublicKey(cfg.match(/USDC_MINT: "(\w+)"/)![1]);
  console.log("lister — program", pp.programId.toBase58(), "| mint", usdcMint.toBase58());

  // auth (reuses cached JWT/API token when still valid)
  let cached: any = {}; try { cached = JSON.parse(fs.readFileSync(AUTH_CACHE, "utf8")); } catch {}
  await users.setupUser("Keeper", process.env.ANCHOR_WALLET!, new PublicKey(process.env.TOKEN_MINT_ADDRESS!), conn, txo, 1, 4, [], cached.jwt, cached.apiToken);
  fs.writeFileSync(AUTH_CACHE, JSON.stringify({ jwt: users.authState.jwt, apiToken: users.authState.apiToken }));
  const api = users.apiClient;

  // G2 (publisher-alive heuristic): today's daily root PDA must exist on-chain.
  const today = Math.floor(Date.now() / DAY_MS);
  const [rootPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(today).toArrayLike(Buffer, "le", 2)], txo.programId);
  const rootInfo = await conn.getAccountInfo(rootPda);
  if (!rootInfo) { console.error(`G2 FAIL: no daily_scores_roots for today (day ${today}) — oracle publisher looks dead, listing nothing.`); process.exit(1); }
  console.log(`G2 ✓ daily root day ${today} exists (${rootInfo.data.length}B)`);

  // 1. Discover upcoming fixtures across competitions, next 3 epoch days.
  const seen = new Map<number, any>();
  for (const comp of COMPETITIONS) {
    for (let d = 0; d < 3; d++) {
      try {
        const { data } = await api.get(`/fixtures/snapshot?competitionId=${comp}&startEpochDay=${today + d}`);
        const recs: any[] = Array.isArray(data) ? data : (data?.records ?? data?.fixtures ?? []);
        for (const r of recs) {
          const id = Number(pick(r, "FixtureId", "fixtureId"));
          if (id && !seen.has(id)) seen.set(id, r);
        }
      } catch (e: any) {
        if (e?.response?.status !== 404) console.warn(`discover comp=${comp} day=${today + d}:`, e?.response?.status ?? e?.message);
      }
    }
  }
  console.log(`discovered ${seen.size} fixtures`);

  const registry = loadRegistry();
  const byId = new Map(registry.map((m) => [m.fixtureId, m]));
  const now = Date.now();

  for (const [id, f] of seen) {
    const startMs = Number(pick(f, "StartTime", "startTime"));
    const state = pick(f, "GameState", "gameState");
    const sport = Number(pick(f, "SportId", "sportId"));
    const p1Home = pick(f, "Participant1IsHome", "participant1IsHome") !== false;
    const p1 = pick(f, "Participant1", "Participant1Name", "participant1") ?? `Team ${pick(f, "Participant1Id")}`;
    const p2 = pick(f, "Participant2", "Participant2Name", "participant2") ?? `Team ${pick(f, "Participant2Id")}`;
    const [home, away] = p1Home ? [p1, p2] : [p2, p1];
    const [homeId, awayId] = p1Home
      ? [Number(pick(f, "Participant1Id")), Number(pick(f, "Participant2Id"))]
      : [Number(pick(f, "Participant2Id")), Number(pick(f, "Participant1Id"))];
    const tag = `${home}-${away} (${id})`;

    if (byId.has(id)) { console.log(`· ${tag} already listed`); continue; }
    // G4 (state is "scheduled" on comp-72 records, numeric 1 on others)
    if (state !== "scheduled" && state !== 1) { console.log(`✗ ${tag} G4: state ${state}`); continue; }
    if (!(startMs > now + MIN_LEAD_MIN * 60_000)) { console.log(`✗ ${tag} G4: KO ${new Date(startMs).toISOString()} too soon/past`); continue; }
    // G1 — and the score records carry SportId when the fixture record doesn't (G3)
    let scoreRecs: any[] = [];
    try {
      const { data } = await api.get(`/scores/snapshot/${id}`);
      scoreRecs = Array.isArray(data) ? data : (data?.records ?? data?.updates ?? []);
    } catch {}
    if (scoreRecs.length === 0) { console.log(`✗ ${tag} G1: no score feed records`); continue; }
    // G3
    const effSport = Number.isFinite(sport) ? sport : Number(pick(scoreRecs[0], "SportId", "sportId"));
    if (effSport !== SOCCER) { console.log(`✗ ${tag} G3: sport ${effSport} unsupported`); continue; }

    // List it.
    const idBuf = new BN(id).toArrayLike(Buffer, "le", 8);
    const [fixturePda] = PublicKey.findProgramAddressSync([Buffer.from("fixture"), idBuf], pp.programId);
    const escrow = getAssociatedTokenAddressSync(usdcMint, fixturePda, true);
    const lockTime = Math.floor(startMs / 1000);

    const onChain = await conn.getAccountInfo(fixturePda);
    if (!onChain) {
      const D = DEFAULT_DIST_PARAMS, P = DEFAULT_PAYOUT_PARAMS;
      await pp.methods.initializeFixture(new BN(id), new BN(lockTime),
        { p: new BN(D.p), wGd: new BN(D.wGd), wTg: new BN(D.wTg), wCs: new BN(D.wCs), capGd: D.capGd, capTg: D.capTg },
        { gamma: P.gamma, takeRateBps: P.takeRateBps, capMultiple: new BN(P.capMultiple) })
        .accountsStrict({ authority: keeper.publicKey, fixture: fixturePda, usdcMint, escrow,
          tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
        .rpc();
      await new Promise((r) => setTimeout(r, 1500)); // public-RPC throttle
    }
    byId.set(id, {
      fixtureId: id, pda: fixturePda.toBase58(), escrow: escrow.toBase58(),
      home, away, homeId, awayId,
      competition: COMP_NAMES[Number(pick(f, "CompetitionId"))] ?? `Competition ${pick(f, "CompetitionId")}`,
      kickoff: startMs, lockTime, listedAt: now, state: "Open", stakerCount: 0, totalPool: 0,
    });
    console.log(`✓ LISTED ${tag} — KO ${new Date(startMs).toISOString()} — ${fixturePda.toBase58()}${onChain ? " (was already on-chain)" : ""}`);
  }

  saveRegistry([...byId.values()]);
  console.log(`registry: ${byId.size} markets → ${FIXTURES_JSON}`);
}
main().catch((e) => { console.error("LISTER FAILED:", e?.error?.errorMessage ?? e?.response?.status ?? e?.message ?? e); process.exit(1); });
