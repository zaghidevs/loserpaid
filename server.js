// loser — hourly "biggest loser" tracker for a pump.fun coin.
// Zero dependencies. Needs Node 22+ (built-in WebSocket).
//
//   Demo:  DEMO=1 node server.js
//   Live:  CREATOR_WALLET=<wallet you launch from> PUMPPORTAL_API_KEY=<key> ADMIN_KEY=<secret> node server.js
//          The site waits in "launching soon" mode and locks onto your coin the second that wallet creates it.
//          (MINT=<token address> still works if the coin already exists.)
//   Rehearsal: TEST_ANY_LAUNCH=1 locks onto the next coin anyone launches, to prove everything works. Reset it from /admin.
//   Optional: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to keep data safe on hosts that wipe disk (e.g. Render free)

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------- config ----------
const env = process.env;
const DEMO = env.DEMO === "1";
const CFG = {
  port: +(env.PORT || 3000),
  mint: env.MINT || (DEMO ? "DEMOxLoser1111111111111111111111111111pump" : ""),
  creator: (env.CREATOR_WALLET || "").trim(),
  testAnyLaunch: env.TEST_ANY_LAUNCH === "1",
  wsUrl: env.PUMPPORTAL_WS || "wss://pumpportal.fun/api/data",
  apiKey: env.PUMPPORTAL_API_KEY || "",
  adminKey: env.ADMIN_KEY || (DEMO ? "demo" : ""),
  roundMinutes: +(env.ROUND_MINUTES || (DEMO ? 2 : 60)),
  minHoldMinutes: +(env.MIN_HOLD_MINUTES ?? (DEMO ? 0.1 : 5)),
  minLossSol: +(env.MIN_LOSS_SOL ?? 0.05),
  payoutCapPct: +(env.PAYOUT_CAP_PCT ?? 50),
  creatorFeePct: +(env.CREATOR_FEE_PCT ?? 0.3),
  potSharePct: +(env.POT_SHARE_PCT ?? 100),
  exclude: new Set((env.EXCLUDE_WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean)),
  dataFile: env.DATA_FILE || path.join(__dirname, "data", DEMO ? "demo-state.json" : "state.json"),
  redisUrl: (env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, ""),
  redisToken: env.UPSTASH_REDIS_REST_TOKEN || "",
};
const REMOTE = !!(CFG.redisUrl && CFG.redisToken);
const REDIS_KEY = DEMO ? "loser:demo" : "loser:state";
if (require.main === module && !DEMO && (!CFG.apiKey || !CFG.adminKey || !(CFG.mint || CFG.creator || CFG.testAnyLaunch))) {
  console.error("Missing config. Set PUMPPORTAL_API_KEY, ADMIN_KEY and CREATOR_WALLET (or MINT, or TEST_ANY_LAUNCH=1). Or run with DEMO=1.");
  process.exit(1);
}
const ROUND_MS = CFG.roundMinutes * 60_000;
const MIN_HOLD_MS = CFG.minHoldMinutes * 60_000;

// ---------- state ----------
function freshState() {
  return {
  mint: CFG.mint || null,
  launchAt: null,    // when the coin was detected; rounds are counted from here
  coin: null,        // {name, symbol}
  test: false,       // locked via TEST_ANY_LAUNCH rehearsal
  lots: {},          // wallet -> [{tokens, cost, t}]  (FIFO cost basis)
  round: null,       // current round
  rollover: 0,       // unpaid pot carried into next round (SOL)
  winners: [],       // finished rounds, newest first
  banned: [],
  trades: [],        // recent trades for the feed
  lastMcapSol: 0,
  history: [],       // [{t, mcap}] sampled every 30s, last ~2h
  totals: { paid: 0, rounds: 0, winners: 0, worstLoss: 0, worstWallet: null },
  wins: {},          // wallet -> {count, won}
  seen: {},          // signature -> 1 (dedupe, trimmed)
  };
}
let S = freshState();

function snapshot() { return JSON.stringify({ ...S, seen: {} }); }

async function redis(cmd) {
  const res = await fetch(CFG.redisUrl, {
    method: "POST",
    headers: { authorization: "Bearer " + CFG.redisToken, "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error || "redis http " + res.status);
  return j.result;
}

async function load() {
  let raw = null;
  if (REMOTE) {
    try { raw = await redis(["GET", REDIS_KEY]); console.log("Loaded state from Upstash"); }
    catch (e) { console.error("Upstash load failed:", e.message); }
  }
  if (!raw) { try { raw = fs.readFileSync(CFG.dataFile, "utf8"); } catch { /* first run */ } }
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    let ok;
    if (CFG.mint) ok = saved.mint === CFG.mint;                 // coin fixed by MINT
    else if (saved.test && !CFG.testAnyLaunch) ok = false;       // leftover rehearsal: start clean
    else ok = true;                                              // waiting, or already locked on
    if (ok) {
      S = { ...S, ...saved, seen: {} };
      console.log(`Restored: ${S.mint ? "tracking " + S.mint : "waiting for launch"}, ${S.winners.length} past rounds`);
    } else console.log("Saved state is for a different coin or a rehearsal; starting clean");
  } catch (e) { console.error("Saved state unreadable:", e.message); }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(CFG.dataFile), { recursive: true });
    const tmp = CFG.dataFile + ".tmp";
    fs.writeFileSync(tmp, snapshot());
    fs.renameSync(tmp, CFG.dataFile);
  } catch (e) { console.error("Local save failed:", e.message); }
}

let remoteBusy = false;
async function saveRemote() {
  if (!REMOTE || remoteBusy) return;
  remoteBusy = true;
  try { await redis(["SET", REDIS_KEY, snapshot()]); }
  catch (e) { console.error("Upstash save failed:", e.message); }
  finally { remoteBusy = false; }
}
function persist() { save(); saveRemote(); }

function roundStart(t) {
  const anchor = S.launchAt || 0;
  return anchor + Math.floor((t - anchor) / ROUND_MS) * ROUND_MS;
}
function newRound(t) {
  const start = roundStart(t);
  return { id: start, start, end: start + ROUND_MS, volume: 0, trades: 0, pnl: {} };
}
function pot(r) {
  return S.rollover + (r.volume * CFG.creatorFeePct / 100) * (CFG.potSharePct / 100);
}
function isBanned(w) { return CFG.exclude.has(w) || S.banned.includes(w); }

function leaderboard(r, n = 10) {
  return Object.entries(r.pnl)
    .filter(([w, p]) => p.realized < 0 && !isBanned(w))
    .sort((a, b) => a[1].realized - b[1].realized)
    .slice(0, n)
    .map(([wallet, p]) => ({ wallet, loss: -p.realized, sells: p.sells, eligible: -p.realized >= CFG.minLossSol }));
}

// ---------- round rollover ----------
function closeRoundIfDue(now = Date.now()) {
  if (!S.mint) return;                      // not launched yet
  if (!S.round) { S.round = newRound(now); return; }
  while (now >= S.round.end) {
    const r = S.round;
    const potSol = pot(r);
    const top = leaderboard(r, 1)[0];
    let rec = { id: r.id, start: r.start, end: r.end, volume: r.volume, trades: r.trades, pot: potSol };
    if (top && top.eligible) {
      const payout = Math.min(potSol, top.loss * CFG.payoutCapPct / 100);
      rec = { ...rec, wallet: top.wallet, loss: top.loss, payout, status: "unpaid", tx: null };
      S.rollover = potSol - payout;
      const T = S.totals, W = (S.wins[top.wallet] ||= { count: 0, won: 0 });
      T.paid += payout; T.winners++; W.count++; W.won += payout;
      if (top.loss > T.worstLoss) { T.worstLoss = top.loss; T.worstWallet = top.wallet; }
      console.log(`Round ${new Date(r.start).toISOString()} winner ${top.wallet} lost ${top.loss.toFixed(3)} SOL -> pays ${payout.toFixed(4)} SOL`);
    } else {
      rec = { ...rec, wallet: null, payout: 0, status: "rolled" };
      S.rollover = potSol;
      console.log(`Round ${new Date(r.start).toISOString()} no eligible loser, pot rolls over (${potSol.toFixed(4)} SOL)`);
    }
    S.totals.rounds++;
    S.winners.unshift(rec);
    S.winners = S.winners.slice(0, 500);
    S.round = newRound(r.end);
    persist();
  }
}

// ---------- trade processing ----------
// PumpPortal trade message: { signature, mint, traderPublicKey, txType: "buy"|"sell",
//   tokenAmount, solAmount, marketCapSol, ... }
function onTrade(m, now = Date.now()) {
  if (!m || !S.mint || m.mint !== S.mint || !m.txType) return;
  if (m.signature) {
    if (S.seen[m.signature]) return;
    S.seen[m.signature] = 1;
  }
  closeRoundIfDue(now);
  const r = S.round;
  const w = m.traderPublicKey;
  const tokens = +m.tokenAmount, sol = +m.solAmount;
  if (!w || !(tokens > 0) || !(sol >= 0)) return;
  if (m.marketCapSol) S.lastMcapSol = +m.marketCapSol;
  r.volume += sol; r.trades++;

  const lots = (S.lots[w] ||= []);
  let pnl = null;
  if (m.txType === "buy") {
    lots.push({ tokens, cost: sol, t: now });
  } else if (m.txType === "sell") {
    let left = tokens, realized = 0, counted = false;
    while (left > 1e-9 && lots.length) {
      const lot = lots[0];
      const take = Math.min(left, lot.tokens);
      const cost = lot.cost * (take / lot.tokens);
      const proceeds = sol * (take / tokens);
      if (now - lot.t >= MIN_HOLD_MS) { realized += proceeds - cost; counted = true; }
      lot.tokens -= take; lot.cost -= cost; left -= take;
      if (lot.tokens <= 1e-9) lots.shift();
    }
    // Tokens with no tracked buy (bought before tracking / transferred in) are ignored.
    if (counted) {
      const p = (r.pnl[w] ||= { realized: 0, sells: 0 });
      p.realized += realized; p.sells++;
      pnl = realized;
    }
    if (!lots.length) delete S.lots[w];
  }
  S.trades.unshift({ t: now, wallet: w, type: m.txType, sol, pnl, sig: m.signature || null });
  S.trades = S.trades.slice(0, 40);
}

// sample market cap for the chart
setInterval(() => {
  if (!S.lastMcapSol) return;
  S.history.push({ t: Date.now(), mcap: S.lastMcapSol });
  if (S.history.length > 240) S.history = S.history.slice(-240);
}, DEMO ? 3000 : 30_000).unref();

function walletInfo(w, now = Date.now()) {
  closeRoundIfDue(now);
  if (!S.round) return { wallet: w, tracked: false, banned: isBanned(w), roundPnl: 0, rank: null, of: 0, holding: 0, costBasis: 0, wins: { count: 0, won: 0 }, lossToFirst: 0 };
  const r = S.round, p = r.pnl[w];
  const board = Object.entries(r.pnl).filter(([x, v]) => v.realized < 0 && !isBanned(x)).sort((a, b) => a[1].realized - b[1].realized);
  const rank = board.findIndex(([x]) => x === w);
  const held = (S.lots[w] || []).reduce((a, l) => a + l.tokens, 0);
  const cost = (S.lots[w] || []).reduce((a, l) => a + l.cost, 0);
  return {
    wallet: w, tracked: !!(p || S.lots[w] || S.wins[w]), banned: isBanned(w),
    roundPnl: p ? p.realized : 0, rank: rank >= 0 ? rank + 1 : null, of: board.length,
    holding: held, costBasis: cost, wins: S.wins[w] || { count: 0, won: 0 },
    lossToFirst: board.length && rank !== 0 ? -board[0][1].realized - (p && p.realized < 0 ? -p.realized : 0) : 0,
  };
}

// trim dedupe cache
setInterval(() => {
  const keys = Object.keys(S.seen);
  if (keys.length > 20000) S.seen = Object.fromEntries(keys.slice(-5000).map((k) => [k, 1]));
}, 60_000).unref();

// ---------- live feed (PumpPortal) ----------
let feedStatus = "starting", ws = null;
function send(obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }
function subscribe() {
  if (S.mint) {
    send({ method: "subscribeTokenTrade", keys: [S.mint] });
    feedStatus = "live";
    console.log("Watching trades for", S.mint);
  } else {
    send({ method: "subscribeNewToken" });
    feedStatus = "waiting for launch";
    console.log(CFG.testAnyLaunch ? "Rehearsal: waiting for the next coin anyone launches" : "Waiting for " + CFG.creator + " to launch");
  }
}

// A new coin was created on pump.fun. Lock on if it's ours.
function onCreate(m, now = Date.now()) {
  if (S.mint || !m || !m.mint) return false;
  const ours = CFG.testAnyLaunch || (CFG.creator && m.traderPublicKey === CFG.creator);
  if (!ours) return false;
  S = { ...freshState(), banned: S.banned, mint: m.mint, launchAt: now, test: CFG.testAnyLaunch,
        coin: { name: m.name || null, symbol: m.symbol || null } };
  S.round = newRound(now);
  console.log(`LAUNCH DETECTED: ${m.name || ""} (${m.symbol || ""}) ${m.mint}${S.test ? " [rehearsal]" : ""}`);
  if (+m.initialBuy > 0 && +m.solAmount > 0) {   // creator's first buy is part of the create transaction
    onTrade({ signature: m.signature, mint: m.mint, traderPublicKey: m.traderPublicKey, txType: "buy",
              tokenAmount: m.initialBuy, solAmount: m.solAmount, marketCapSol: m.marketCapSol }, now);
  }
  send({ method: "unsubscribeNewToken" });
  subscribe();
  persist();
  return true;
}

function onMessage(m, now = Date.now()) {
  if (!m) return;
  if (m.txType === "create") { if (!S.mint) onCreate(m, now); return; }
  onTrade(m, now);
}

function connectLive(attempt = 0) {
  const sep = CFG.wsUrl.includes("?") ? "&" : "?";
  ws = new WebSocket(`${CFG.wsUrl}${sep}api-key=${encodeURIComponent(CFG.apiKey)}`);
  const me = ws;
  me.addEventListener("open", () => { attempt = 0; subscribe(); });
  me.addEventListener("message", (e) => {
    try { onMessage(JSON.parse(e.data)); } catch (err) { console.error("bad message", err.message); }
  });
  let retried = false;
  const retry = () => {
    if (retried || me !== ws) return;
    retried = true;
    feedStatus = "reconnecting";
    const wait = Math.min(60_000, 2000 * 2 ** attempt);
    console.log(`Feed dropped, reconnecting in ${wait / 1000}s`);
    setTimeout(() => connectLive(attempt + 1), wait);
  };
  me.addEventListener("close", retry);
  me.addEventListener("error", () => {
    if (retried) return;          // closing a failed socket can fire "error" again; don't loop
    retry();
    try { me.close(); } catch {}
  });
}

function resetState() {
  const old = S.mint;
  S = { ...freshState(), banned: S.banned };
  persist();
  if (!DEMO && ws && ws.readyState === 1) {   // re-subscribe for the new state
    if (old && old !== S.mint) send({ method: "unsubscribeTokenTrade", keys: [old] });
    subscribe();
  }
}

// ---------- demo feed ----------
function startDemo() {
  feedStatus = "demo";
  const wallets = Array.from({ length: 40 }, () => {
    const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789";
    return Array.from({ length: 44 }, () => a[Math.floor(Math.random() * a.length)]).join("");
  });
  let price = 3e-8; // SOL per token
  const tick = () => {
    price *= Math.exp((Math.random() - 0.5) * 0.08);
    const w = wallets[Math.floor(Math.random() * wallets.length)];
    const held = (S.lots[w] || []).reduce((s, l) => s + l.tokens, 0);
    const sell = held > 0 && Math.random() < 0.45;
    let tokens, sol;
    if (sell) { tokens = held * (Math.random() < 0.6 ? 1 : 0.5); sol = tokens * price; }
    else { sol = +(0.05 + Math.random() ** 2 * 3).toFixed(3); tokens = sol / price; }
    onTrade({
      signature: "demo" + Math.random().toString(36).slice(2),
      mint: CFG.mint, traderPublicKey: w, txType: sell ? "sell" : "buy",
      tokenAmount: tokens, solAmount: sol, marketCapSol: price * 1e9,
    });
    setTimeout(tick, 300 + Math.random() * 1500);
  };
  tick();
}

// ---------- http ----------
const PUB = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp" };

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((ok) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { ok(JSON.parse(d || "{}")); } catch { ok({}); } }); });
}

function publicState() {
  closeRoundIfDue();
  const now = Date.now();
  const r = S.round || { start: now, end: now, volume: 0, trades: 0, pnl: {} };
  return {
    demo: DEMO, feed: feedStatus, mint: S.mint, launched: !!S.mint, launchAt: S.launchAt, coin: S.coin, test: S.test, now,
    rules: { roundMinutes: CFG.roundMinutes, minHoldMinutes: CFG.minHoldMinutes, minLossSol: CFG.minLossSol, payoutCapPct: CFG.payoutCapPct },
    mcapSol: S.lastMcapSol,
    round: { start: r.start, end: r.end, volume: r.volume, trades: r.trades, pot: pot(r), rollover: S.rollover },
    leaderboard: leaderboard(r, 10),
    trades: S.trades.slice(0, 25),
    history: S.history,
    totals: S.totals,
    winners: S.winners.slice(0, 50),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
  if (url.pathname === "/api/state") return json(res, 200, publicState());
  if (url.pathname === "/api/wallet") {
    const w = (url.searchParams.get("w") || "").trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) return json(res, 400, { error: "that doesn't look like a solana wallet address" });
    return json(res, 200, walletInfo(w));
  }

  if (url.pathname.startsWith("/api/admin/")) {
    if (req.headers["x-admin-key"] !== CFG.adminKey) return json(res, 401, { error: "bad admin key" });
    const b = req.method === "POST" ? await body(req) : {};
    if (url.pathname === "/api/admin/paid") {
      const w = S.winners.find((x) => x.id === +b.id);
      if (!w || !w.wallet) return json(res, 404, { error: "round not found" });
      w.status = "paid"; w.tx = String(b.tx || "").trim() || null; persist();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/admin/ban") {
      if (b.wallet && !S.banned.includes(b.wallet)) S.banned.push(String(b.wallet));
      if (b.unban) S.banned = S.banned.filter((x) => x !== b.unban);
      persist(); return json(res, 200, { ok: true, banned: S.banned });
    }
    if (url.pathname === "/api/admin/reset") {
      if (req.method !== "POST" || b.confirm !== "RESET") return json(res, 400, { error: "type RESET to confirm" });
      resetState(); console.log("State reset from admin");
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/admin/state") return json(res, 200, {
      banned: S.banned, unpaid: S.winners.filter((w) => w.status === "unpaid"),
      mint: S.mint, coin: S.coin, test: S.test, launchAt: S.launchAt, feed: feedStatus,
      watching: CFG.mint ? "fixed MINT" : CFG.testAnyLaunch ? "rehearsal: any new coin" : "creator wallet " + CFG.creator,
    });
    return json(res, 404, { error: "unknown" });
  }

  let f = url.pathname === "/" ? "/index.html" : url.pathname === "/admin" ? "/admin.html" : url.pathname === "/docs" ? "/docs.html" : url.pathname;
  const file = path.normalize(path.join(PUB, f));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------- boot ----------
if (require.main === module) {
  (async () => {
    await load();
    closeRoundIfDue();
    setInterval(() => closeRoundIfDue(), 1000);
    setInterval(save, 10_000);
    if (REMOTE) setInterval(saveRemote, 30_000);
    const quit = async () => { save(); if (REMOTE) { remoteBusy = false; await saveRemote(); } process.exit(0); };
    process.on("SIGINT", quit);
    process.on("SIGTERM", quit);
    server.listen(CFG.port, () => {
      console.log(`loser running on http://localhost:${CFG.port} ${DEMO ? "(DEMO MODE)" : CFG.testAnyLaunch ? "(REHEARSAL)" : "(LIVE)"}${REMOTE ? " · saving to Upstash" : ""}`);
      DEMO ? startDemo() : connectLive();
    });
  })();
}

module.exports = { onMessage, onCreate, resetState, publicState, walletInfo, onTrade, closeRoundIfDue, leaderboard, S: () => S, CFG };
