# loser: lose the most, win the pot

Every round (1 hour by default), the wallet that **lost the most SOL trading your coin** wins a share of the creator fees.

No dependencies are needed. You only need **Node.js 22 or newer**.

---

## 1. See it working (demo, 1 minute)

```bash
DEMO=1 node server.js
```

Open http://localhost:3000. It runs on fake trades with 2-minute rounds, so you can watch winners get picked.
The admin page is at http://localhost:3000/admin and the demo key is `demo`.

`node test.js` checks the loss math.

## 2. Before launch (everything is set up before the coin exists)

1. **Get a PumpPortal API key.** Go to pumpportal.fun → Lightning Transaction API → Getting Started → Create Wallet & API Key. **Put about 0.05 SOL in that wallet.** The live feed costs 0.01 SOL per 10,000 trades.
2. **Pick an admin key**, which can be any long random password.
3. **Check pump.fun's current creator fee %** for `CREATOR_FEE_PCT`. The pot shown on the site is an estimate based on it.
4. **Note the wallet you will launch the coin from** (the one you connect to pump.fun). That goes in `CREATOR_WALLET`.

## 3. Rehearse, then go live

**Rehearsal.** Set `TEST_ANY_LAUNCH=1` (plus the key settings) and start the site. It locks onto the next coin *anyone* launches on pump.fun and tracks it for real: trades, losses, leaderboard. When you're happy, open `/admin`, type RESET and click **Reset everything**.

**Go live before launching.**

```bash
CREATOR_WALLET=<wallet you launch from> \
PUMPPORTAL_API_KEY=<key> \
ADMIN_KEY=<your secret> \
CREATOR_FEE_PCT=<pump.fun creator fee %> \
node server.js
```

The site shows **launching soon**. The moment that wallet creates a coin on pump.fun, the site locks onto it automatically: the CA appears, the buy button works, and round 1 starts right then. Nothing to paste, no restart. `/admin` shows whether it's waiting or tracking.

Switching from rehearsal to `CREATOR_WALLET` drops the rehearsal data automatically. If the coin already exists, `MINT=<CA>` still works instead of `CREATOR_WALLET`.

### Hosting

The server has to stay running 24/7, because it has to see every trade to track losses. Vercel and Netlify **won't work**, because they shut apps down between requests.

**Free setup: Render + a pinger + Upstash**
1. **Render** (render.com): New → Web Service → connect your GitHub repo. Pick the **Free** instance. Build command: leave empty. Start command: `node server.js`. Add the settings above under Environment.
2. **Keep it awake.** Free Render apps go to sleep after 15 minutes without visitors, and while asleep the site misses trades. Make a free account at **cron-job.org** (or UptimeRobot) and have it open `https://<your-app>.onrender.com/health` **every 5 minutes**.
3. **Keep your data.** Free Render apps lose their files whenever they restart. Make a free Redis database at **upstash.com** (no card needed), open it, and copy the **REST URL** and **REST token** into Render as `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. The site then saves to Upstash every 30 seconds and after every round, and reloads from it on restart.

The free Render plan gives 750 hours a month, which is enough for **one** app running all month. Don't run a second free app on the same account.

The free plan can also restart without warning. It comes back within a minute or so. Trades made while it's down aren't seen: sells of tokens bought during that time won't count toward a loss, and a sell that happens during that time is missed entirely.

**Paid setup (more reliable):** Railway (about $5/month) or any small VPS. There, add a persistent volume and set `DATA_FILE=/data/state.json`, or use Upstash the same way.

## 4. Paying winners (every round)

1. Claim your creator fees on pump.fun as usual.
2. Open `/admin` and enter your admin key. It lists each unpaid winner, their wallet and exactly how much to send.
3. Send the SOL from your wallet, paste the transaction signature, and click **Mark paid**.
   The public "Hall of losers" then shows a **paid ↗** link to Solscan. That link is your proof, so screenshot it for X.

Payouts are done by hand on purpose, so the server never holds a private key. If the site gets hacked, nobody can drain your wallet.

## Rules and anti-abuse settings

| Setting | Default | What it does |
|---|---|---|
| `ROUND_MINUTES` | 60 | Round length |
| `MIN_HOLD_MINUTES` | 5 | Tokens must be held this long before selling them counts as a loss. Stops instant buy-dump farming |
| `MIN_LOSS_SOL` | 0.05 | Minimum loss needed to win |
| `PAYOUT_CAP_PCT` | 50 | Winner gets at most this % of what they lost, and the rest rolls into the next pot. **This is the key anti-exploit rule: nobody can profit by losing on purpose** |
| `POT_SHARE_PCT` | 100 | % of creator fees that go into the pot. Set it to 80 if you want to keep 20% |
| `EXCLUDE_WALLETS` | none | Comma-separated wallets to never pay, e.g. your own wallet |

How losses are counted:
- Only **realized** losses count, meaning you have to actually sell at a loss
- Cost is tracked **first in, first out** from the wallet's buys of this coin
- Tokens bought before the server started, or transferred in from another wallet, are ignored, so they can't be used to fake a loss
- You can ban a wallet from `/admin` if someone games it

## Files

- `server.js`: trade tracking, loss math, rounds, API
- `public/index.html`: the public site
- `public/admin.html`: payout and ban panel
- `test.js`: loss-math checks
