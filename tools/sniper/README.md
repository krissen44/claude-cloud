# XRPL Launch Sniper

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
4. **Buys for 1 XRP** (adjustable). If the price already ran more than 25 %, it doesn't buy.
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
   - **A rug is never waited for:** if the pool's XRP drops 40 %, it sells at once, without approval.
   - Market cap = all issued tokens × current pool price. The bot reads the XRP/USD price from the
     XRP/RLUSD pool on the ledger; if it can't, it asks to be safe.
8. **Cleans up.** After a full sale it deletes the trust line, which frees the 0.2 XRP reserve.

Every buy and sale is in the log, on the status page (open trades and moonbags apart) and optionally in Discord.

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
