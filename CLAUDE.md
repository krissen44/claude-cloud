# Scrappy XRP — Bark Arena game + scrappyxrp.fun website

Project context for Claude Code. The owner speaks **German**: answer in German, keep code, comments and
commit messages in English. They deploy by uploading ZIPs to **Hostinger**, so finish work with a ZIP of
exactly the files to upload and say where each goes.

## What's in this repo

| Path | What it is | Where it runs |
|---|---|---|
| `server.js`, `worker.js`, `public/index.html`, `package.json` | **Bark Arena**, the Pixel Scrappy NFT fighting game | Hostinger Node.js app → `https://game.scrappyxrp.fun` |
| `website/` | Pieces of the **scrappyxrp.fun** site (static files) | Hostinger `public_html/` |

Git branch used so far: `claude/dreamy-pasteur-du9fm3` (repo `krissen44/claude-cloud`).

## Collection facts

- **Pixel Scrappy**: 5,000 NFTs on the XRPL. Issuer `rGAVUGyhdbxQs1G7nwCCFU4w8P4HfgFKD6`, **taxon 369**.
  Metadata `ipfs://bafybeid7e5yfl4x2mr5hlhs2z574ohmmcx4eewarnwbv7a3euln7sgz3de/<n>.json`.
- #1–#20 are hand-made Legendaries (built-in kits in `DATA.legendaries`), 49 Mythics, 126 traits over 8 layers.
- The issuer wallet also holds taxons 589 and 10001 (other collections) — only 369 is Pixel Scrappy.
- The site serves every image at `/pixelscrappy/nfts/<n>.png` (fallback `/pixelscrappy/scrappy-5000/01_bilder/<n>.png`).
- xrp.cafe: `https://xrp.cafe/collection/pixel-scrappy`. Scrappy blue: `#1b8ce3`; site accent `#0f76c6`, ink `#0e1726`.

---

## Bark Arena (the game)

### Architecture
- **Wallets**: "Connect wallet" in the game opens a chooser: **Xaman** (QR / deeplink), **Joey app** (WalletConnect v2,
  QR on desktop / `wc:` link on phones) or **Joey extension** (provider `window.joey`, npm `@joeywallet/wallet-sdk`,
  `signIn` → CAIP-122). WalletConnect project ID (Reown, not secret, domain-allowlisted to game.scrappyxrp.fun):
  `CONFIG.WC_PROJECT_ID` in `public/index.html`. `public/wc.js` = esbuild bundle of `@walletconnect/sign-client` +
  `qrcode` (recipe in `tools/wc/`), loaded only on demand. Joey app has no WC sign-in method, so it signs
  `xrpl_signTransaction` of a 1-drop self-payment (temREDUNDANT, never submittable) with the nonce in a memo; the
  server verifies it like the Ledger challenge (`txBlob` or `signedTx`).
- **`server.js`** — plain Node 20 `http` server. npm deps (only for Joey signature checks): `ripple-keypairs`,
  `ripple-binary-codec` — the Hostinger ZIP ships `node_modules/` so no install step is needed. Serves `public/index.html` at `/` and forwards
  `/api/*` to `worker.js`. Provides the storage the worker needs:
  - `STORE` → JSON file `DATA_DIR/store.json` (players, weekly rows, holdings, packs), flushed every 2 s, atomic write.
  - `KV` → in-memory cache with TTL.
  - `FILES` → disk cache `DATA_DIR/cache/` for NFT metadata and images (they never change; avoids IPFS 429s).
  - `session.secret` in `DATA_DIR` unless `SESSION_SECRET` is set.
  - **Private-beta gate**: if `ACCESS_KEY` is set, page + API need the cookie from one visit to `/?key=ACCESS_KEY`;
    everyone else gets a "coming soon" page (API: 403). `/api/public/*` stays open.
  - `DATA_DIR` defaults to `~/bark-arena-data` (outside the app folder, so Hostinger redeploys don't wipe it).
- **`worker.js`** — the API. Written Cloudflare-Worker style (`export default { fetch }`), also supports D1
  (`env.DB`) — the Node server passes `env.STORE` instead. Keep both code paths when changing storage.
- **Cloud save**: `SAVE.save()` stamps `updatedAt` (not for automatic day/week roll-overs, `save(true)`) and queues a
  push to `/api/save` 3 s later (`cloudQueue`/`cloudPush`, keepalive on page hide). On sign-in `cloudPull()` adopts the
  server save if it is newer, else uploads the local one. The kennel image cache (`ba_dogs:*`) is not synced.
- **`public/index.html`** — the whole game client in one file (≈2,300 lines: CSS, a big `DATA` JSON on line ~243
  with fighters/traits/combat/legendaries/sets, engine, UI). Progress lives in `localStorage` (`ba_save_v1:<account>`).

### Environment variables (Hostinger)
`ISSUER=rGAVUGyhdbxQs1G7nwCCFU4w8P4HfgFKD6`, `TAXON=369` (empty/`*` = any taxon), `XUMM_API_KEY`, `XUMM_API_SECRET`,
`RETURN_URL=https://game.scrappyxrp.fun/`, `ADMIN_KEY` (admin dashboard; unset = admin off), optional `ACCESS_KEY`, `SESSION_SECRET`, `DATA_DIR`, `IPFS_GATEWAY`,
`META_HOSTS`, `ORIGIN`, `PORT`.

### API (`/api/...`)
| Route | Auth | Purpose |
|---|---|---|
| `/check?account=r…` | – | Setup self-test: config, NFTs found, metadata/image fetch, NFTs grouped by issuer/taxon |
| `/auth/start` (POST), `/auth/status?uuid=` | – | Xaman SignIn payload → session token (HMAC, 7 days) |
| `/auth/joey/start` (POST), `/auth/joey/verify` (POST) | – | Joey Wallet sign-in: one-time nonce (5 min) → CAIP-122 "Sign in with XRPL" signature, or for Ledger accounts a Sequence-0 self-payment with the nonce in a memo; checks domain (RETURN_URL/ORIGIN hosts), key↔address, nonce, freshness → same session |
| `/ladder[?week=YYYY-MM-DD]` | optional | Weekly top 10 (xp/wins/streak) + caller's rank (`mine`) |
| `/public/board` | – | Public standings for the website: this week + last week, players and packs; CORS `*`, cached 60 s |
| `/me/kennel[?fresh=1]` | ✔ | Player's Pixel Scrappys from the ledger; records holdings; `hint` when nothing matches |
| `/meta?uri=`, `/img?u=` | ✔ | Metadata / image via IPFS gateways (raced in parallel) + disk cache |
| `/taken` | ✔ | Token numbers held by any signed-in player (never drawn as rivals) |
| `/packs`, `/pack` (POST join/leave/cancel) | ✔ | Real pack membership + standings for 9 weeks |
| `/stats` (POST) | ✔ | Weekly wins/losses/xp/streak (server keeps the max) |
| `/save` (GET/POST) | ✔ | Full browser save per wallet (cloud backup + cross-device sync), file `DATA_DIR/saves/<account>.json` |
| `/admin/export[?download=1]`, `/admin/csv` | `?key=ADMIN_KEY` | Everything as JSON backup (summary, per-player rows, raw store + saves) / players as CSV. Dashboard page: **`/admin`** |

### Game rules (as implemented — keep the website guide in sync)
- **Fight**: 10 rounds, healthiest (% HP) at the bell wins. HP 16 + rarity bonus (Unc/Rare +1, Epic +2, Legendary +2, Mythic +3).
  Energy starts 2, +1/round, max 9. **Bite** 4–7, 15% miss, +2 vs taunt. **Guard** blocks bite, +1 energy and
  **snaps back 2** (`C.guard.snap_vs_bite ?? 2`). **Taunt** +2 energy, chips 2 through guard. **Frenzy** from round 7: +1…+4 bite damage.
- **Kit**: only the 3 rarest of 8 traits fight, max 1 active ability. Mythic sets add a set bonus; Legendaries use hand-built kits.
- **Opponent AI** (`ai()` / `predictFoe()`): counters patterns from the player's move history (order-1/2 context +
  frequency), never peeks at the current move (except the intended 30% "Insight" trait). Simulation baseline
  (2,000 fights each): random 46%, always-bite 35%, alternating 21–22%, bite/taunt 4%. Re-run a simulation after AI/rule changes.
- **Rivals**: random collection dogs (#21–5000, `COLLECTION_SIZE`), fetched in the background into a rotating pool
  (`OPP`), ~12% Legendaries, never a token in `/taken`; demo dogs only until the pool loads. Bond level ±1 of yours.
- **Tickets**: 5/day + 1 per extra owned Scrappy (max 10), bank max 15. Ranked XP: win 30, loss 12, +10 vs rarer.
  Casual = no XP and does **not** touch the streak.
- **Streak**: consecutive wins in ranked fights and live arena fights only (`streakAfter`).
- **Bond** levels 1–10 (`need = 60 + (l-1)*45`), perks at 2/4/6/8/10. Trainer level every 250 XP. 3 daily quests.
- **Arena**: **3 knockout tournaments per UTC day** (`ARENA_RUNS`), squad up to 3, quarter/semi/final, XP 0/35/60/100
  shared across the squad, ghosts half XP. A tournament counts when it starts. Demo is unlimited.
- **Packs** (server-enforced): 4 packs, max 10 members, ranked by **wins per member**. One pack a week: joining with no
  pack is instant and locks the week (`lockWeek`); switching or leaving is only queued for Monday 00:00 UTC
  (`pending`, `"-"` = leave). Weekly bonuses Fang/Hide/Spirit, one per pack, defend +10%/+20%, barred after 3 weeks.
- **Recaps**: daily recap when tickets are 0 and all 3 tournaments used; weekly results on the first visit of a new
  week (only for players active in the week that just ended).

### Version history (what was fixed and why)
v1 kennel showed 0 NFTs → ipfs.io returned **429** from Hostinger's shared IP → gateway fallback, disk cache,
browser fallback, parallel gateway race (v2–v3) · v4–v5 rivals from the whole collection, never players' dogs ·
v6/v11 arena limit (now 3 tournaments/day) · v7 packs made real on the server (were seeded fake numbers) ·
v8 daily recap · v9 weekly results · v11 streak inflation fixed (casual wins + per-dog arena counting) ·
v12 playtest fixes ("Fight again" re-used the same rival; demo dogs leaked in; recap for newcomers) ·
v13 exploit fix (always-bite won 77%) → pattern-reading AI + guard snap-back; recap counted abandoned tournaments ·
v14 one-pack-a-week rule, losses tracked, full pack stats table · v15 `ACCESS_KEY` gate · v16 `/api/public/board` · v17 wallet chooser + Joey extension sign-in · v18 Joey app over WalletConnect (confirmed working live by the owner).

### Testing locally
```bash
ISSUER=rI PORT=3000 DATA_DIR=/tmp/ba node server.js      # starts; XRPL/IPFS calls need internet
node --check server.js && node --check worker.js
```
For offline tests, wrap the server in a script that replaces `globalThis.fetch` (fake `account_nfts` from
xrplcluster/ripple.com and fake IPFS JSON/PNG), forge a session token with the `session.secret` from `DATA_DIR`
(HMAC-SHA256, see `mintSession`), put `{token, account}` into `localStorage.ba_session`, and drive it with Playwright.
Always syntax-check the inline game script after editing `public/index.html`.

### Known limitations / open decisions
- Stats, XP and streaks are computed in the browser and trusted by the server (clamped only) — a determined user can fake them.
- First day gives 10 tickets (5 starting + 5 daily grant).
- Fight Club tab shows "Coming soon" (needs a realtime room; not available on Hostinger).

---

## Website (scrappyxrp.fun)

- **Main page** is a built React/Vite + Tailwind app. We don't have its source — only the build.
  `website/index.html` now loads **`/assets/index-scrappy-v3.js`**, a patched copy of `index-lzWr3Fc6.js`
  (originals kept in `website/assets/`). Patches (search for these in the bundle): collections array `te` got a
  first entry `pixel-scrappy` (items 5000, `floorXrp:null` → shows "see xrp.cafe"); image map `jd` supports
  `img` + `pixel` (#259, pixelated); grid `sm:grid-cols-2 lg:grid-cols-3`; eyebrow "Three collections on xrp.cafe";
  **Whitelist removed** from the menu array `de` and the footer; **Bark Arena** (`/barkarena/`) added to the menu array
  `de` and the footer (v3). If the site is ever rebuilt from source, redo these there.
- **`website/pixelscrappy/`** — collection page (static HTML). Added: animated pixel-lettering hero "PIXEL SCRAPPY"
  with #259, nav, whitelist link removed. `pixel-title.js` renders `.pxtitle[data-px]` as SVG from a 5×7 bitmap font
  (A–Z, `$`, `!`), text kept for screen readers, animation off with reduced motion. `scrappy-theme.css` copies the
  main page's look (white header with ink rule, sticker cards with 2px ink border + hard shadow, pill buttons, dotted
  paper background) — load it after a page's own styles.
- **`website/barkarena/`** — game page at `https://scrappyxrp.fun/barkarena/`, **public**: indexable, canonical + OG tags,
  linked from the main page (menu + footer) and the pixel page (nav, footer, "Your Pixel Scrappy can fight" banner). Live leaderboard from `https://game.scrappyxrp.fun/api/public/board` (this/last week, refresh 60 s),
  detailed how-to-play and FAQ. Numbers in the guide mirror the game rules above — update both together.
- The `/whitelist/` folder on Hostinger should be deleted (no longer used).

### Open questions for the owner
- Current floor price of Pixel Scrappy (card shows "see xrp.cafe").
- Is the public mint over? Then replace the "Mint" section on `/pixelscrappy/` with "Trade on xrp.cafe".
- The game went public (Bark Arena linked everywhere). `ACCESS_KEY` must be removed on Hostinger; the gate code stays
  for a future closed test.
