// Checks the loss math and round logic. Run: node test.js
process.env.MINT = "TESTMINT";
process.env.ROUND_MINUTES = "60";
process.env.MIN_HOLD_MINUTES = "5";
process.env.MIN_LOSS_SOL = "0.05";
process.env.PAYOUT_CAP_PCT = "50";
process.env.CREATOR_FEE_PCT = "1";
process.env.DATA_FILE = require("path").join(require("os").tmpdir(), "loser-test.json");
const assert = require("assert");
const { onTrade, closeRoundIfDue, leaderboard, S } = require("./server.js");

const H = 3_600_000, M = 60_000;
const t0 = 1_000 * H; // aligned to an hour
let n = 0;
const trade = (w, type, tokens, sol, t) => onTrade({ signature: "s" + n++, mint: "TESTMINT", traderPublicKey: w, txType: type, tokenAmount: tokens, solAmount: sol }, t);
const near = (a, b) => assert(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

closeRoundIfDue(t0);

// A: buys 1000 for 2 SOL, sells all after 10 min for 0.5 SOL -> loss 1.5
trade("A", "buy", 1000, 2, t0 + M);
trade("A", "sell", 1000, 0.5, t0 + 11 * M);
// B: two buys at different prices, FIFO: sells 150 tokens -> 100 @0.01 + 50 @0.02 cost = 1+1 = 2, proceeds 0.9 -> loss 1.1
trade("B", "buy", 100, 1, t0 + M);
trade("B", "buy", 100, 2, t0 + 2 * M);
trade("B", "sell", 150, 0.9, t0 + 20 * M);
// C: quick flip (under 5 min hold) at a huge loss -> not counted
trade("C", "buy", 1000, 10, t0 + 30 * M);
trade("C", "sell", 1000, 1, t0 + 31 * M);
// D: sells tokens never bought while tracked -> ignored
trade("D", "sell", 500, 0.1, t0 + 32 * M);
// E: profit -> not on loser board
trade("E", "buy", 100, 1, t0 + M);
trade("E", "sell", 100, 3, t0 + 40 * M);
// wrong mint ignored, duplicate signature ignored
onTrade({ signature: "x", mint: "OTHER", traderPublicKey: "Z", txType: "buy", tokenAmount: 1, solAmount: 99 }, t0 + 41 * M);
onTrade({ signature: "s0", mint: "TESTMINT", traderPublicKey: "A", txType: "buy", tokenAmount: 1000, solAmount: 2 }, t0 + 42 * M);

const lb = leaderboard(S().round);
assert.deepStrictEqual(lb.map((x) => x.wallet), ["A", "B"]);
near(lb[0].loss, 1.5);
near(lb[1].loss, 1.1);
assert.strictEqual(S().lots.B.length, 1); near(S().lots.B[0].tokens, 50); near(S().lots.B[0].cost, 1);

// volume = 2+0.5+1+2+0.9+10+1+0.1+1+3 = 21.5 ; pot = 1% = 0.215 ; payout = min(0.215, 50% of 1.5) = 0.215
closeRoundIfDue(t0 + H + 1);
const w = S().winners[0];
assert.strictEqual(w.wallet, "A");
near(w.pot, 0.215); near(w.payout, 0.215); near(S().rollover, 0);

// Round 2: winner's cap binds -> leftover rolls over
trade("F", "buy", 100, 100, t0 + H + M);        // volume 100
trade("F", "sell", 100, 99.9, t0 + H + 10 * M); // loss 0.1, volume 99.9 -> pot 1.999, payout capped 0.05
closeRoundIfDue(t0 + 2 * H + 1);
near(S().winners[0].payout, 0.05);
near(S().rollover, 1.999 - 0.05);

// Round 3: nobody loses -> everything rolls
closeRoundIfDue(t0 + 3 * H + 1);
assert.strictEqual(S().winners[0].status, "rolled");
near(S().rollover, 1.949);

console.log("All loss-math tests passed");

// totals + wallet lookup
assert.strictEqual(S().totals.rounds, 3);
assert.strictEqual(S().totals.winners, 2);
near(S().totals.paid, 0.215 + 0.05);
near(S().totals.worstLoss, 1.5);
assert.strictEqual(S().wins.A.count, 1);
const { walletInfo } = require("./server.js");
trade("G", "buy", 100, 2, t0 + 3 * H + M);
trade("G", "sell", 100, 1, t0 + 3 * H + 10 * M);
trade("K", "buy", 100, 2, t0 + 3 * H + M);
trade("K", "sell", 100, 1.5, t0 + 3 * H + 10 * M);
const wi = walletInfo("K", t0 + 3 * H + 11 * M);
assert.strictEqual(wi.rank, 2); near(wi.roundPnl, -0.5); near(wi.lossToFirst, 0.5);
console.log("Totals and wallet lookup tests passed");
