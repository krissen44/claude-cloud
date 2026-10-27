# XRPL Launch Sniper + Arbitrage Bot

Buys new memecoins on the XRPL right at launch and sells them by fixed rules.

## What it does

1. **Spots every launch.** FirstLedger, Horizon and the other launchpads start a token by creating an
   XRP/token AMM pool (`AMMCreate`). The bot listens to the ledger live and sees every new pool in the
   same ledger (≈ 4 seconds).
2. **Only pools from 100 XRP.** If a launch starts smaller, the bot watches it for 10 minutes. If the pool
   grows past 100 XRP in that time, it buys; otherwise it lets it go.
3. **Checks for rug signs.** It only buys when everything is fine:
   - The issuer is **blackholed** (can't mint more tokens). The bot waits up to 2 minutes for that.
   - No clawback (the issuer can't take tokens back), no freeze.
   - No transfer fee.
   - At least 20 % of all tokens sit in the pool (otherwise the dev can crash the price with the rest).
4. **Buys for 1 XRP** (adjustable) with **one** transaction: an immediate-or-cancel offer that crosses the
   AMM and creates the trust line by itself (no separate TrustSet, so the buy lands one ledger earlier).
   If the price already ran more than 35 %, nothing is bought.
5. **Wallet tracking (optional):** add wallets you want to follow. When such a wallet buys a token for at
   least 5 XRP, the bot buys it too – with the same safety checks, once per token. **Copy buys sell by their
   own rules** (no moonbag):
   - at **+100 %** half,
   - the rest **30 % below the peak**,
   - at **−50 %** everything,
   - if the pool's XRP drops **40 %** (rug): everything at once,
   - after **24 hours** whatever is left.
6. **Launch buys sell by "stake out, the rest rides":**
   - At **+100 %** it sells **exactly enough to get the stake back** (+5 % for fees). The higher the price
     is by then, the less it has to sell and the more stays in the bag.
   - The rest is a **moonbag**: it costs nothing any more and is **never sold**, however the price moves.
   - Only exception: if the pool is dead (90 % of its XRP gone), the bot clears the rest – the 0.2 XRP trust
     line reserve is then worth more than the token.
   - **Until the stake is back** it protects it: at −50 %, on a rug alarm (40 % of the pool's XRP gone) or
     after 24 hours it sells everything.
7. **Asks you about big tokens.** If a token has a **market cap from $100,000**, the bot doesn't sell by
   itself. It asks you on the status page (and in Discord) and waits:
   - **✅ Sell**: it makes the sale the rule wanted, at the current price.
   - **✋ Keep (legit)**: the token is yours from now on; the bot no longer sells it by itself. The status
     page has the buttons "Sell half", "Sell all" and "Back to automatic" for it.
   - The card has links to check the token: the issuer's website (if set), XRPScan, FirstLedger and an
     X search for the token name. The bot can't judge socials – that's your part.
   - **Runner:** if a launch starts with **at least 300 XRP** in the pool and the pool's XRP doubles within
     **60 minutes**, the bot marks it as a 🚀 runner and asks before **every** sale, whatever the market cap.
     Launch buys only (for copy buys the bot doesn't know the start).
   - **The first sale never waits** (`AUTO_FIRST_SALE=1`): taking the stake out goes through at once, even
     for runners and big market caps. Only the sales after that ask you.
   - **A rug is never waited for:** if the pool's XRP drops 40 %, it sells at once, without approval.
   - Market cap = all issued tokens × current pool price. The bot reads the XRP/USD price from the
     XRP/RLUSD pool on the ledger; if it can't, it asks to be safe.
8. **Cleans up.** After a full sale it deletes the trust line, which frees the 0.2 XRP reserve.

The status page also has **📊 Stats**: launches seen, skips by reason, buys and failed buys (slippage),
approval requests – the numbers to tune the filters with.

Every buy and sale is in the log, on the status page (open trades and moonbags apart) and optionally in Discord.

## Data collection

The bot records as much as it can, in `DATA_DIR/data/` (kept across updates):

- **Every launch is followed for 24 h – bought or not.** Price and pool XRP at 1/5/15/30 min and 1/3/6/24 h,
  best and worst price (and when), whether the pool died, plus the trading in the pool from the live stream
  (buys, sells, distinct buyers, volume in/out, liquidity added/removed). So you can see what the skipped
  launches would have done.
- The checks of each launch (blackhole, clawback, freeze, approval-only trust lines, fees, supply share,
  issuer domain), the decision and its reason.
- Every own action: buy (expected vs. received, slippage, delay after the launch), each sale, close, approval
  requests and your answers, copy signals, runner marks, settings changes.

On the status page: **🔬 Launch outcomes** (last 7 days, grouped by decision and by start liquidity: share
that reached 2×/5×/10×, still above start after 1 h, died, median best multiple) and downloads:
`launches.csv` (one row per launch, opens in Excel), `launches.json`, `events.jsonl`.

### Launch protections (anti-snipe)

If an issuer that is not blackholed yet has the token frozen, requires approved trust lines or charges a
transfer fee, the bot treats it as a launch protection phase and waits up to `PROTECT_WAIT_MIN` (60 min)
instead of skipping. It sees every ledger transaction, so the moment the issuer lifts the protection (any
transaction from the issuer) it re-checks at once and buys in the first open ledger. Normal launches are not slowed
down by this – they are bought in the first possible ledger as before.

If a buy **fails because of a protection** (result like `tecFROZEN`, `tecNO_AUTH`, or the issuer still shows
protection flags), the bot doesn't give up: it keeps the token, waits for the issuer to lift it and buys
once (one retry per token). A failure because the price ran away (slippage) is not retried.
It does not try to get around a protection. Once the issuer is blackholed those flags can't change any more, so then they are final.

## Honestly

- **50 → 500 XRP in a month can't be planned.** Most new coins lose value fast. The bot lives on a few hits
  of +200 % … +1000 % paying for the many small losses. Whether that works depends on the market. Only use
  money you can afford to lose.
- Many bots buy XRPL launches in the first ledger. This one is fast, but not the fastest.
- The filters catch many rugs, not all (e.g. when the dev spreads tokens over many wallets).
- After 1–2 weeks, look at the wins/losses on the status page and tune the settings.

## Money math with 50 XRP

| | XRP |
|---|---|
| Wallet base reserve (locked) | 1 |
| Balance never spent (`MIN_BALANCE_XRP`) | 10 |
| Per open position: stake + trust line reserve | 1 + 0.2 |
| → open trades at once with 50 XRP | about 30, capped at 25 (`MAX_OPEN`) |
| Every moonbag locks 0.2 XRP reserve | 50 moonbags = 10 XRP |

Moonbags don't count towards `MAX_OPEN`, but their reserve comes off the balance. The balance floor makes
sure the bot never spends more than allowed.

## Setup on a VPS (Ubuntu) in one step

**Use a new wallet just for the bot** – never your main wallet or any project/issuer wallet. Its key is
stored in plain text in `.env` on the server.

In the server console (e.g. Hostinger "Web console"):
```
cd /root && curl -fsSL https://codeload.github.com/krissen44/claude-cloud/tar.gz/refs/heads/claude/awesome-einstein-jnon4n | tar xz --strip-components=2 --wildcards '*/tools/sniper' && cd sniper && bash setup-vps.sh
```
The script installs Node.js, asks for the bot wallet's address and its key (12/24 words, family seed or Xaman
secret numbers – hidden input; it checks that the key matches the address), generates the login password,
opens the firewall, tests the XRPL connection and starts the bot 24/7 with pm2. At the end it shows the bot
address and the status page. Then send the XRP to the bot wallet.

### HTTPS with your own domain

The domain needs a DNS A record `@` → the server's IP. Then:
```
cd /root && curl -fsSL https://codeload.github.com/krissen44/claude-cloud/tar.gz/refs/heads/claude/awesome-einstein-jnon4n | tar xz --strip-components=2 --wildcards '*/tools/sniper' && cd sniper && bash setup-https.sh your-domain.tld
```
Installs Caddy (free certificate, renews itself), serves the status page at `https://your-domain.tld`, closes
port 3100 (`BIND=127.0.0.1`) and switches `PUBLIC_URL` for Discord.

### Login

The status page has a login page. Password = `STATUS_PASSWORD`, else `STATUS_KEY`. Set your own with
`bash set-password.sh` (logs out every device). You stay logged in for 30 days; after 8 wrong tries an IP
has to wait 15 minutes.

### Updates

Run the download command again (without `bash setup-vps.sh`), then `pm2 restart sniper`. `.env`, open
positions and settings are kept.

### Daily use

- Live log: `pm2 logs sniper` (Ctrl+C only closes the view)
- Restart: `pm2 restart sniper` · Stop: `pm2 stop sniper`
- While the bot is stopped **nothing** is sold. Open positions are kept (`~/xrpl-sniper-data/state.json`)
  and watched again after the start.

## Settings on the status page

Top right **⚙️ Settings**: almost all values below can be changed there. They apply at once, no restart, and
are stored in `DATA_DIR/settings.json` (so updates keep them). There is also **"Pause buying"**: no new buys,
open positions are still sold by the rules. Every change is logged (and sent to Discord). An empty field =
back to the default. Wallet key, password, port and server settings are `.env` only.

## Settings (`.env`)

All values are explained in `.env.example`. The main ones:

| Value | Default | Meaning |
|---|---|---|
| `BUY_XRP` | 1 | XRP per launch |
| `MIN_BALANCE_XRP` | 10 | always kept |
| `MIN_POOL_XRP` / `POOL_WAIT_MIN` | 100 / 10 | pools from 100 XRP only, watch smaller ones for 10 min |
| `TAKE_PROFIT` / `TAKE_PROFIT_PART` | 100 / auto | at +100 % take the stake back, the rest rides |
| `TRAILING_STOP` | 0 | never sell the moonbag (e.g. `50` = sell the rest 50 % below its peak) |
| `STOP_LOSS` | 50 | sell everything at −50 % while the stake isn't back (`0` = off) |
| `MCAP_APPROVAL` | 100000 | from this market cap (USD) sell only with your OK (`0` = off) |
| `RUNNER_START_XRP` / `RUNNER_GROWTH` / `RUNNER_WINDOW_MIN` | 300 / 100 / 60 | start ≥ 300 XRP + pool XRP doubled within 60 min → every sale needs your OK |
| `TRACK_WALLETS` | empty | `rAddress:Name,rAddress2:Name2` – their buys are copied |
| `COPY_BUY_XRP` / `COPY_MIN_XRP` | 1 / 5 | stake per copy buy / only for buys of the wallet from this size |
| `COPY_TAKE_PROFIT` / `_PART` / `COPY_TRAILING_STOP` / `COPY_STOP_LOSS` / `COPY_RUG_POOL_DROP` / `COPY_MAX_HOLD_H` | 100 / 50 / 30 / 50 / 40 / 24 | sell rules for copy buys |
| `REQUIRE_BLACKHOLE` | 1 | only tokens whose issuer can't mint more |
| `PAUSE_BUYS` | 0 | `1` = no new buys |
| `DRY_RUN` | 0 | `1` = pretend only, no real trades |

## Running elsewhere

It's plain Node.js (18+): `npm start` with a `.env` next to it. It has to run **around the clock**, otherwise
it misses launches and, worse, sales. A small VPS is the most reliable; a PC works while it stays on.
A Hostinger Node.js web app is not recommended – those apps are often put to sleep without visitors.

## Tests

`npm test` runs 17 scenarios on a simulated ledger (approval by market cap / runner / keep / rug anyway,
stake out + moonbag, small pool grows, copy trades with half/trailing stop/max hold, rug, clawback, late/no
blackhole, stop loss, deleted pool, balance floor, runaway price, live settings + pause).
`node test/txcheck.mjs` checks that every transaction is valid and can be signed.

---

# Arbitrage bot (`arb.js`)

A second bot in the same folder, with **its own wallet** and its own pm2 process (`arb`). Its page is
`<status site>/arb`, behind the same login.

## How it works

- **Pools:** reads the list of all AMM pools from the ledger once (`ledger_data type=amm`, cached), then the
  balances (`amm_info`, XRP pools first). After that every balance comes from the metadata of the live
  transaction stream – exact and without polling. Pools it didn't know are learned when they trade.
- **Search after every ledger:** loops XRP → A → … → XRP of 2–5 pools (`ARB_MAX_HOPS`) that use at least one
  pool that just moved, with the exact AMM math incl. fees, and the input size that earns most (between
  `ARB_MIN_SIZE` and `ARB_MAX_SIZE`, never touching `ARB_FLOOR`).
- **One all-or-nothing Batch per cycle** (XLS-56, like the bwif bots): payment 1 spends the stake XRP → … → T,
  payment 2 sells all of T → … → XRP with `DeliverMin` = stake + fee + `ARB_LOCK_PROFIT` (0 = break-even).
  If the second can't deliver that, **nothing** happens and only the batch fee (≈ 0.00005 XRP) is spent.
  A loop is sent when it is expected to earn `ARB_MIN_PROFIT` (0.0002 XRP) after the fee.
- **Small and parallel, on Tickets** (like bwif's small bot, which wins ~25 % of its tries with 0.1–0.4 XRP):
  sizes `ARB_MIN_SIZE`–`ARB_MAX_SIZE` (0.1–2 XRP); up to `ARB_PARALLEL` (5) batches go into the same ledger,
  each on a different loop with no shared pool. Every batch uses three Tickets (outer + 2 inner) instead of
  sequence numbers; a loop that fails uses up only the outer one. The bot keeps `ARB_TICKETS` ready
  (default 3 per batch + 3 = 18, 0.2 XRP reserve each until used) with `TicketCreate`. `ARB_PARALLEL=0` = the
  old one-at-a-time mode on sequence numbers.
- **Held token T:** any token of the loop the wallet has a trust line for. Trust lines are added
  automatically for the tokens that show up most in good loops and in the rivals' batches (`ARB_MAX_LINES`,
  0.2 XRP reserve each).

## Token list (default: only the list)

`ARB_LIST_ONLY` (on) = the bot trades **only** the tokens in `ARB_TOKENS` – loops, trust lines, everything.
The default list is the owner's pick of the top memecoins on FirstLedger with big XRP pools (38 tokens,
27 Oct 2026: FUZZY, ARMY, PHNIX, BCHAMP, DROP, ATM, SLT, PROFIT, FARM, 666, Teddy, GOAT, SEAL, 589, BERT,
JELLY, Horizon, TOTO, PHX, GRIM, OLX, SCHWEPE, SIGMA, scrap, XRPM, XOX, DeepTide, CBIRD, SPY, Xmen, bwif,
Laugh, UGA, TIME, SPC, HIYO, XYZ, LIHUA); for names with copies the issuer with the deepest XRP pool was
taken. Edit it in ⚙️ Settings → The list (one `NAME.rIssuer` per line; empty = back to the default). Trust
lines of other tokens that hold nothing are given back. The page suggests tokens to add (deep pools, hype,
the rivals' tokens) – they are never traded until you add them.

**Bridges** (`ARB_BRIDGE`, on): a loop may pass through a token off the list whose XRP pool holds at least
`ARB_BRIDGE_MIN_XRP` (1,000) XRP and whose issuer is clean – only inside the same all-or-nothing batch, never
held, no trust line (e.g. FUZZY → WIND → DROP → PHNIX, the kind of loop the bwif bots win most). Off = only list
tokens in a loop. Busy ledgers: up to `ARB_MAX_FEE_DROPS` (20,000 drops) per batch, but only for loops that
still earn after that fee.

**Hard reset:** `bash reset-arb.sh` (in the sniper folder) stops the bot, deletes all its data (stats, trades,
learning, pool cache, page settings) and starts it fresh. The wallet in `.env` stays.

## Learning (target win rate)

Every batch that lands is a win or a miss, and every miss is explained:
- **beaten** – someone else moved one of our pools earlier in the same ledger (they were faster; the pool is
  contested). The loop may be tried again after 3 ledgers.
- **math off** – nothing got in the way and it still failed (our model is wrong for that route, e.g. a hidden
  fee). The route is blocked for ~20 minutes and the miss counts against its token.

From these results (older ones fade with `ARB_LEARN_HALF_LIFE_H`, 72 h) the bot estimates for every new loop
the chance that it goes through = (no pool of it gets moved first) × (our math is right for it), per pool,
route, held token and margin class (how far above break-even it looked). Only loops at or above
`ARB_TARGET_WIN` (90 %) are sent as sure trades. Routes it hasn't tried `ARB_LEARN_MIN_TRIES` (6) times yet
are tried up to `ARB_EXPLORE_DAY` (100) times a day to learn – cheap, a miss costs only the fee. The page shows
the win rate of the sure trades separately from the learning tries, the misses by reason, the rate per margin
class and the weakest routes, pools and tokens.

## Focus mode (default on)

Only the tokens that matter are traded and get trust lines up front (so a found loop can run at once):
- **top** – the `ARB_TOP_N` (50) tokens with the most XRP in their pool,
- **hype** – pools whose XRP grew `ARB_HOT_GROWTH` % (30) within `ARB_HOT_WINDOW_H` (6 h) with at least
  `ARB_HOT_MIN_TRADES` (20) trades – fresh launches included; they stay `ARB_HOT_KEEP_H` (24 h),
- **rivals** – tokens the bwif bots just used,
- **yours** – `ARB_TOKENS` (e.g. `FUZZY.rhCAT4hRdi2Y9puNdkpMzxrdKa5wkppR62`).
`ARB_FOCUS_ONLY` (on) limits the loops to focus tokens only. Lines follow the focus (priority: yours, rivals,
hype, top) up to `ARB_MAX_LINES` (50); a token that left it gives
its line back once the balance is zero. The page shows the focus list with liquidity, growth and trades.

## Fees and sequence numbers

A busy ledger costs more than the minimum: the bot reads the open-ledger fee level every ledger and pays what
gets the batch into the ledger directly (×1.25), between `ARB_FEE_DROPS` and `ARB_MAX_FEE_DROPS`; above that it
skips. Batches run on Tickets, so trust lines and `TicketCreate` (sequence numbers) never clash with them; the
free tickets are re-read from the ledger every ~50 ledgers and after any ticket error.

## Improvements over the bwif bots

- Exact reserves from the stream instead of polling; optimal size per cycle; any token of the loop can be
  the held one.
- **Learns from rivals:** watches the bwif bots (`ARB_WATCH`), records their cycles and profit, and adds
  trust lines for the tokens they hold.
- **Safety:** tokens whose issuer charges a transfer fee or froze the token are never used (our math would be
  wrong → endless failed batches); a loop that didn't go through is cooled down for 10 ledgers, a token with 3
  failures for 1 hour; a daily fee cap (`ARB_MAX_FEES_DAY`); parallel batches never share a pool and together
  stay within the free XRP.
- **Data:** every opportunity (taken or not), every attempt, every rival cycle → `opportunities.csv`,
  `trades.csv`, `rivals.csv` on the page.

## Setup

After the sniper is running:
```
cd /root && curl -fsSL https://codeload.github.com/krissen44/claude-cloud/tar.gz/refs/heads/claude/awesome-einstein-jnon4n | tar xz --strip-components=2 --wildcards '*/tools/sniper' && cd sniper && bash setup-arb.sh
```
It asks for the arbitrage wallet (address + key, hidden), tests the connection and starts `arb` with pm2.
Then send the XRP to that wallet. Settings: `/arb` → ⚙️ Settings (pause, min. profit, sizes, hops, fees, lines,
rivals). Tests: `node test/arb-sim.mjs` (simulated ledger that runs the signed batches all-or-nothing).

**Honestly:** the bwif bots made ≈ +1,000 XRP in October with two bots and much more capital and experience.
Competing for the same loops means many of ours will be taken first (cost: the fee). The data will show how
much is left for us.
