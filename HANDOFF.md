# Handoff — Bark Arena / scrappyxrp.fun (cloud session → local Claude Code)

Read **CLAUDE.md** first (architecture, API, rules, version history) and **RELEASE.md** (what ships next and how).
This file only adds what isn't there: where things stand, the owner's decisions, how to test, and what's next.
Branch: `claude/dreamy-pasteur-du9fm3` on `krissen44/claude-cloud`. Last code commit: sounds v29.

## Owner & working rules
- Owner writes **German** → answer in German; code, comments, commits in English.
- Deploys by **uploading ZIPs to Hostinger** (no git deploy). Always finish with the exact ZIP(s) + where each file goes.
- **Release rule:** nothing goes live mid-week. All changes collect in `RELEASE.md` and ship together at the week roll
  (Monday 00:00 UTC). Never tell the owner to upload mid-week.
- Owner likes to see results: screenshots / short videos of UI changes, a downloadable package at the end.

## Where things stand (2026-10-05)
- **Live on Hostinger:** game v19 (cloud saves + `/admin`) and the website launch package (Bark Arena public).
- **Ready to ship — this week roll (Mon 5 Oct):** v20–v29, packaged as
  - `bark-arena-game-2026-10-05.zip` = `package.json`, `package-lock.json`, `server.js`, `worker.js`, **`fight-engine.js`** (new),
    `public/` (`index.html`, `wc.js`), `node_modules/` → Hostinger Node.js app of game.scrappyxrp.fun, then restart the app.
  - `scrappyxrp-website-2026-10-05.zip` = `barkarena/index.html` → `public_html/barkarena/`.
  - Rebuild them from the repo root:
    `zip -r bark-arena-game-2026-10-05.zip package.json package-lock.json server.js worker.js fight-engine.js public node_modules`
    and `cd website && zip ../scrappyxrp-website-2026-10-05.zip barkarena/index.html`.
  - Checklist (also in RELEASE.md): `ACCESS_KEY` removed, `ADMIN_KEY` set, upload + restart, smoke test (sign in, set a
    name, arena rivals "from <name>", `/admin` Name column, Fight Club invite link in a second browser, lending to a
    non-holder test wallet), then from 00:15 UTC **week close in `/admin`**: anchor the hash, send prizes — both are Xaman
    QRs signed with the **issuer wallet** (needs 2 XRP free reserve per open prize offer).

## What v20–v29 contain (one line each; details in CLAUDE.md / RELEASE.md)
v20 arena rivals = other players' dogs + optional unique player names · v21 arena defence bond XP for registered squads ·
v22 "buy this rival" xrp.cafe link (verify the `https://xrp.cafe/nft/<NFTokenID>` URL pattern once live) ·
v23 Fight Club beta, server referee via `fight-engine.js` (runs the `//@engine` sections of index.html in `node:vm`) ·
v24 week close: frozen results + SHA-256 anchored as XRPL memo, treasury prizes (top 3 XP + most active member of the
winning pack) as 0-XRP destination sell offers · v25 lending to non-holders (bond XP to the dog, 25 % trainer XP to the
owner, lender prize-share line) · v26 banked tickets don't carry into a new week · v27 animated backdrops (meadow /
stadium / night ring) + fight effects · v28 leaping bites with SVG jaws, a distinct effect per ability, Mythic/Legendary
drop-in entrance + aura · v29 synthesized sounds for all of it (crowd, KO, one per signature move).

## Owner decisions on record (Season 1)
- Ledger writes only via **Xaman QR in /admin** — never a private key on the server.
- Prizes weekly: **top 3 of the XP ladder + most active member of the winning pack**; treasury = **issuer wallet**.
- Lending: **bond XP to the dog + 25 % of the borrower's trainer XP (trainer level only, not ladder) + prize share**
  (NFTs can't be split → extra "🤝 Lender share" line in week close; admin decides).
- Fight Club Season 1 = invite link / player name, 20 s rounds, auto-guard, 2 misses = forfeit, own record, no XP.
  Season 2 = matchmaking, Elo, Club ladder.
- **XRP wagering in the Fight Club: advised against** (gambling law — chance element). Alternative offered: free-entry
  Club Cup with treasury prizes, or stakes without money value (rating points). Owner hasn't decided.
- Teaser videos: owner wants **gameplay only, no text overlays**, MP4 with sound.

## Open items / ideas not started
- Owner questions: current floor price; is the public mint over (→ replace "Mint" on `/pixelscrappy/`)?
- Feedback pending on the new effects/sounds (owner may want some louder/softer/changed).
- Offered, not ordered: 9:16 teaser for Instagram/TikTok, music-free gameplay cut, pack-specific backdrops, weather,
  per-Legendary custom animations, Club Cup.
- Known limitation: stats/XP are client-computed (server clamps only); Fight Club duels are in memory (restart drops them).

## Testing (offline, no real XRPL/IPFS/Xaman) — `tools/test/`
Setup once: `cd tools/test && npm install && npx playwright install chromium` (or set `CHROMIUM=/path/to/chromium`).
Each script takes a scratch dir for its data: `node tools/test/<script>.mjs /tmp/ba-test`.
- `live.mjs` — starts the real `server.js` with `fetch` mocked (3 fake Scrappys per wallet, fake IPFS JSON/PNG,
  Clio `nfts_by_issuer`). `season-mock.mjs` adds an issuer treasury, `nft_sell_offers` and a fake Xaman API
  (payloads auto-sign); wallets starting `rNo…` hold nothing.
- `fc.mjs` — two/three browsers: Fight Club by name + invite link, same fight on both screens, give up.
- `season-api.mjs` — week close: freeze, hash check, anchor once, prize offer, claim, wrong player blocked.
- `lend.mjs` — lending end-to-end incl. prize-share line. `sp.mjs` — screenshots of every signature move,
  bite and Mythic/Legendary intros. `bite.mjs` — bite frames.
- `teaser.mjs <dir> <ffmpeg>` — records gameplay via CDP screencast (1280×720) + the game's WebAudio via a
  MediaRecorder tap, muxes MP4 (`bark-arena-gameplay.mp4`). ffmpeg: `pip install imageio-ffmpeg` →
  `python3 -c "import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())"`.
- Session tokens are forged with `session.secret` = `testsecret` written into the data dir (see scripts).
- Gotchas learned: kill stale mock servers before re-running (an old server on the same port serves old code);
  block external requests in Playwright (`page.route` abort) or screenshots wait ~1 s for blocked fonts;
  `page.screenshot({clip})` is much faster than `locator.screenshot()` for timing-sensitive frames;
  async errors inside `play()` don't fire `pageerror` — listen for `unhandledrejection`.
- Always: `node --check server.js worker.js fight-engine.js`, syntax-check the inline script of `public/index.html`,
  and `loadEngine('public/index.html')` must still find ≥ 8 `//@engine` sections.
