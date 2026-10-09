# Next release — upload at the week roll (Monday 00:00 UTC)

Changes collect here during the week and go live together when the new week starts.
Last version confirmed live: **game v31.2** (uploaded by the owner on 8 Oct 2026; includes the v31.1 ticket hotfix and
its automatic day-one bonus). Website: v31 package (5 Oct). Shorts factory on GitHub Actions, daily 05:10 UTC.

## v32 — for Monday 19 Oct (built 9 Oct, owner's go: "the rest sounds good, build it" — everything except $SCRAP)
- **Fair play — the server referees ranked and arena fights.** `/api/fight/start` rebuilds both dogs on the server
  (ledger + metadata + the owners' cloud saves, bond ≤ save + 1), `/api/fight/round` takes both moves and only then
  hands out that round's dice seed (`resolveSeeded`, same engine), so the page can't pick its dice. The server books
  every result (blob `fair:<week>`: XP, wins, streak, fights, ghost runs, desyncs, how often the rival "threw").
  Arena ghost tournaments run on the server (`/api/fight/ghost`). `/api/stats` is capped at the verified week
  (+60 XP / +2 wins / +1 streak slack) from `FAIR_SINCE` (default 2026-10-19); a week's first verified fight keeps
  whatever the ladder already had (players from before the upload). `/admin` → "🛡️ Fair play": claimed vs verified
  and flags. `FAIRPLAY=off` switches the cap off. Old page / server unreachable → the page falls back to its own dice
  (then that fight isn't verified). Replays of refereed fights carry seeds; TV and Shorts play both kinds.
- **Bond paths:** at bond 4 and 8 each dog picks one of two perks (classic +2 max health, or 4: Iron Guard — guard
  snaps back for 3; 8: Quick Start — +1 starting energy). Kennel card "🧭 Bond paths", switch any time between fights.
  Applies in ranked, arena, Club (server), replays and TV.
- **Weekly boss:** one of the 20 Legendaries per week (rotates), one health bar for everybody (first 4,000 HP, then
  1.1 × the damage the last boss took, 2,500–60,000). Every refereed ranked/arena fight hits it with the damage the
  player's dog dealt (max 500 per player per day). Falls before Monday → +3 ranked fights for everyone who hit it,
  chat + Discord name the final blow and the top 3. Arena tab card, result screen "+N damage to the boss", website
  section "👹 Boss" (`/api/public/boss`).
- **Achievements:** 17 badges (first win, giant killer, legend slayer, streak 5/10, champion, bond 5/10, 50/250
  fights, Club win, pack, boss hunter, final blow, 3 Scrappys, recruiter, podium). Toast when unlocked, kennel card,
  count next to the name on the ladder. Podium/recruiter/final blow are granted by the server.
- **Invites:** kennel card "📣 Invite friends" with `scrappyxrp.fun/barkarena/?ref=<name>` (the website passes `ref`
  to the game). When the friend holds a Pixel Scrappy of their own and has fought 5 times: both +3 ranked fights,
  Recruiter badge (max 20 per inviter). Only brand-new players can be invited.
- **Starter dog:** a player without a Pixel Scrappy gets one of the treasury's non-Legendary pieces for 7 days (once).
  The NFT doesn't move; ranked, arena, ladder and boss like everyone — **no weekly NFT prize** (week close skips
  starter-only players). Ends early when they get their own. Afterwards a "went home — get your own" card.
- **Discord:** set `DISCORD_WEBHOOK` and the game posts the week results (Monday 00:15 UTC, with the new boss), a
  daily summary (fights, trainers, arena champions, boss HP), the fallen boss, open Club challenges (max 1 per player
  per 30 min). A 5-minute tick in `server.js` (`worker.scheduled`) does the timed posts and freezes finished weeks on time.
- **Lending market (owner's idea, 9 Oct):** holders list up to 3 dogs (3/7/14 days, short note) in the lend card;
  players without a Scrappy see "🏪 Lending market" in their kennel and borrow with one tap (needs a player name;
  same rules as lending by name: no own Scrappy, one borrowed dog, max 3 loans per owner). A listing stays: hidden
  while lent, back when the loan ends; the owner can remove it. Chat announces listings (1/h per owner) and borrows.
  API `/lend/list`, `/lend/unlist`, `/lend/take`; `/lend` returns `listings` + `market`. Test `tools/test/market.mjs` (19 checks).
- **Fights on Discord (owner's wish, 9 Oct):** (1) the factory's **clip of the day as a video** — when a clip's `.json`
  arrives (`/api/admin/clips/upload`), `server.js` posts the YouTube cut (or the smaller TikTok cut if the first is over
  9.5 MB) with hook, story line and question, link `scrappyxrp.fun/barkarena/?src=dc`; `DISCORD_CLIPS` = clips per day
  (default 1, `0` = off). (2) **live highlights** of real players' fights with a link that plays the fight
  (`game.scrappyxrp.fun/clip?id=…`): upsets (2+ rarity tiers, or beating a Legendary), arena finals won, Club duels —
  max 1 per 30 min, 8 a day; players with Bark Arena TV off never appear. Week post now names the three prize winners.
- **Fix:** the `TEAM` environment variable never reached the API (server.js didn't pass it on) — now it does.
- Tests: `tools/test/v32.mjs` (44 checks), plus v30, tv, tickets, fc, lend, season-api still green.

**Upload (Mon 19 Oct):**
1. Game ZIP to the Hostinger Node.js app (all files incl. `node_modules/`), restart.
2. New env vars (Hostinger → Node.js app → Environment variables), one Discord webhook per channel (Discord: Server
   settings → Integrations → Webhooks → New Webhook → name "Bark Arena", pick the channel → Copy Webhook URL):
   `DISCORD_WEBHOOK_FIGHTS` → #fights (highlights + clip of the day), `DISCORD_WEBHOOK_STATS` → #arena-stats (week
   results, daily summary, boss), `DISCORD_WEBHOOK_CLUB` → #search-arena-fight (open Club challenges). `DISCORD_WEBHOOK`
   is the fallback for any channel left empty.
   Optional: `FAIRPLAY=off` (only if something goes wrong with the referee), `TEAM` now really works.
3. Website: `barkarena/index.html` → `public_html/barkarena/` (boss section, invite links, guide + FAQ).
4. Check: sign in → kennel shows 🏅 Achievements + 📣 Invite friends; arena tab shows the 👹 boss; play one ranked
   fight → result shows "+N damage to the boss"; `/admin` → "🛡️ Fair play" lists you with claimed = verified.

## v31.3 — for Monday 12 Oct (not live yet)
- **Kennel/arena/club dog cards: the "BOND n" label was unreadable** — `.pick span` (grey text) overrode the white text of
  `.lvl`, so it showed as an empty dark-blue pill. One CSS line in `public/index.html`: `.pick .lvl{color:#fff}`.
  Found while recording the tutorial. Upload: `public/index.html` (part of the game ZIP).
- **Joey Wallet first, everywhere (owner's wish):** game wallet chooser now lists Joey app (⭐ Recommended), Joey
  extension, then Xaman; sign-in/demo/prize texts name Joey first. Website: hero, OG description, "Get your fighter"
  step 1 (links joeywallet.xyz), how-to step 2, FAQ; `/pixelscrappy/` banner. Tutorial video re-recorded with Joey first.
  Upload: `public/index.html` (game ZIP), `barkarena/index.html` → `public_html/barkarena/`, `pixelscrappy/index.html`
  → `public_html/pixelscrappy/`.
- **Link page `scrappyxrp.fun/links/` (linktree alternative):** `website/links/index.html`, static, site look (sticker
  cards, Scrappy blue). Website, Bark Arena (passes `?src=` on, e.g. `/links/?src=tt` → `/barkarena/?src=tt`), Pixel
  Scrappy + Scrappy on xrp.cafe, $SCRAP on FirstLedger, DexScreener chart, SCRAP/XRP AMM pool, issuer with copy button,
  Discord, X, YouTube, TikTok; logo = the original Scrappy (`links/scrappy.jpg`), Scrappy collection image
  `links/scrappy-nft.jpg`. Upload: the `links/` folder (index.html + 2 images) → `public_html/links/`. Use it as the bio link everywhere.
- **How-to-play tutorial video** for YouTube (not part of the upload): `tools/test/tutorial.mjs` records the real website
  and game on a mock server (`tools/test/tut-mock.mjs`) with chapter cards, step cards for wallet + mint, captions and a
  chiptune bed → `bark-arena-tutorial.mp4` (1920×1080) + `chapters.txt`.

## v31.2 — LIVE since 8 Oct: Shorts with separate YouTube and TikTok cuts
- After week 1 of Shorts: YouTube ~1,200 views per Short (9.3k in 3 days), TikTok mostly 0. Likely TikTok throttles
  crypto content and favours native sounds. Now every fight becomes **two videos**: the **YouTube cut** (full fight,
  chiptune, "Every dog is an NFT on the XRP Ledger · Mint your fighter" end card) and a **TikTok/Reels cut** (only the
  last 4 rounds, ~8–10 s, faster, no music — add a trending sound in the TikTok app — no crypto words or wallet tags on
  screen, end card "Follow for daily fights · Play free · link in bio"). TikTok/Instagram texts without #XRP/#NFT etc.
- Hook line no longer cut off by the apps' icons (padded right, smaller font for long hooks).
- The factory now favours underdog wins and close fights (best performers); exhibitions mostly pit a star against a
  small dog. `/admin` → "📱 Clips" shows two download buttons and texts per platform.
- Clips stay **real players' fights of the day** (if the day was quiet: unused real fights of the last week; an
  exhibition only when there is nothing else). Titles, texts, hashtags and the pinned-comment question are now written
  from the fight itself, e.g. "Alpha's Scrappy #3821 (Uncommon, Bond 1) took down BarkBoss's Scrappy #4344 (Mythic)" ·
  "An Uncommon just beat a Mythic 🤯 Would you have bet on Alpha's Scrappy #3821? 👇" · #underdog #plottwist …
- Upload: game ZIP → Node.js app, restart (the factory on GitHub already uses the new version).

## Hotfix v31.1 — LIVE since 8 Oct (bug found by the owner on 5 Oct)
- **New players got only 5 ranked fights on day one** (should be 5 starting + the daily grant, and +1 per extra
  Scrappy). Two causes: since v26 a brand-new save was treated like a week start, which replaced the starting tickets;
  and the daily grant was counted before the wallet's dogs were loaded (a holder of 17 got 5 instead of 10). Fixed:
  first day = 5 + grant; after the kennel loads, today's grant is topped up once to what the dogs allow. Players hit by
  it get the missing tickets on their next visit. Tested: new holder 12 (3 dogs), affected player +2, others unchanged.
- **Players hit by it get the missed fights automatically**: the first bonus check after the upload scans once for
  holders who started since the week of 28 Sep and grants each their day-one grant (5–10 fights), collected once the
  next time they open the game **from tomorrow on** (7 days), on top of the normal grant, with a "sorry" note. Nothing
  to click. (`/admin` → "🎟️ Ticket bonus" shows it and can grant more by hand.)
- Upload: game ZIP (`public/index.html`, `server.js`, `worker.js` changed) → Node.js app, restart.

## Live since 5 Oct 2026 (v30 + v31)

### Game (game.scrappyxrp.fun)
- **v30 — after the week-2 data** (players won 76 % of fights, top players 88–95 %, issuer wallet on the ladder,
  0 Club duels, 0 loans, 27 of 34 players without a name):
  - **The opponent learns and gets harder with bond.** It remembers each player's style across fights (kept in the
    save), notices when it is being baited ("play a pattern, then counter its counter" won 67–71 % before, now ~40–46 %)
    and switches its answer. The higher the dog's bond, the more it follows its reads, the better it times its ability
    (heals when hurt, hits when no guard is expected, shields against bites), guards a loaded enemy ability and plays the
    score in the last two rounds. Always-bite now loses 94 % at bond 10. Rules, damage and dogs are unchanged; the Fight
    Club (player vs player) is untouched.
  - **Team wallets**: the issuer wallet shows as TEAM on the ladder, website board and chat, but never takes a prize and
    doesn't count for its pack. More team wallets: Hostinger env `TEAM=rA…,rB…` (optional).
  - **In-game chat** (💬 bottom right, signed-in players): one room, last 80 messages, no links except scrappyxrp.fun /
    xrp.cafe (anti-phishing), wallet secrets refused, one message per 4 s. It also announces open Club challenges and
    borrow requests. `/admin` → new "💬 Chat" card: delete messages, mute wallets.
  - **Fight Club open challenges**: "📣 Post an open challenge" — everyone in the Club tab sees it and can accept;
    the chat announces it. No more need to know a name or send a link.
  - **Borrow requests**: players without a Scrappy tap "🙋 I'm looking for a dog" (needs a name); holders see the list
    in their lend card and fill it in with one tap; the chat announces it.
  - **Kennel ranking**: dogs sorted by bond with 🥇🥈🥉 and #places, plus "Top dog"; switch to Rarity or Number.
  - **Name nudge**: after a win, players without a name get a "✏️ Set a name" button.
  - **Prizes by rarity in `/admin`**: the treasury list shows each Scrappy's rarity (and a count per tier); every
    unsent prize is pre-picked — the rarest free Scrappy for 1st, the next for 2nd, 3rd, then the pack prize. Any pick
    can be changed. The hand-built Legendaries #1–20 are only used when you tick the box. New "🎁 Send all" button:
    the QR codes come one after another, you just scan each in Xaman (issuer wallet).
  - Tested offline: 36 checks (team prizes/packs/boards, chat filters/rate limit/mute/delete, open challenge, borrow list,
    kennel order, nudge, no page errors) + the Fight Club, week-close and lending regression tests.

- **v31 — Shorts for reach**: every finished fight is kept as a small replay (moves + dice, no video). Every morning
  the **Shorts factory on the VPS** turns the best fights of the day into 3 portrait clips (1080×1920, ~15–25 s, with
  sound and a quiet chiptune): a hook line on top that fits the fight ("Down to 2 HP… watch this 😤", "A 1-of-20
  Legendary drops in 🌟", "Two real players. One ring. 🥊"), the fight, an end card "Mint your fighter ·
  scrappyxrp.fun/barkarena · link in bio". With each clip: YouTube title + text, TikTok text, Instagram text and a
  question for the pinned comment. **`/admin` → "📱 Clips"**: watch, download, copy texts, tick where posted.
  **`/admin` → "📈 Reach"**: website visits per platform, how many saw/clicked the mint, went into the game, and the new
  players per platform. Also new: `game.scrappyxrp.fun/tv` (all fights back to back), players can switch off that their
  fights are shown ("Don't show my fights" in the kennel). Tested: replays end exactly like the live fight / the Club
  duel; the factory made real 1080×1920 MP4s with sound from a duel and an exhibition and uploaded them; admin cards,
  website tracking and the installer route.

### Website (scrappyxrp.fun)
- `barkarena/index.html`: TEAM tag on the board, guide text for the learning opponent, open challenges, chat FAQ,
  borrow list, team wallets. **v31:** "Get your fighter" section high up (3 steps + the xrp.cafe mint widget), hero
  button "🐾 Get your fighter", a welcome banner for visitors from TikTok/YouTube/Instagram (`?src=tt|yt|ig`), visit and
  click counting for "📈 Reach", "Try the free demo" opens the game's demo.

### Planned (Season 2)
- Fight Club: matchmaking queue, Elo, own ladder.

### Website (scrappyxrp.fun)
- `barkarena/index.html`: guide/FAQ for real arena rivals, player names, defence XP, the Fight Club beta, prizes and
  the ledger proof (prizes + tx + hash under "Last week — final").

## Upload checklist (Mon 12 Oct)
1. Upload the game ZIP (`package.json`, `package-lock.json`, `server.js`, `worker.js`, `fight-engine.js`, `public/`,
   `node_modules/`) to the Hostinger Node.js app and restart it. Optional: env `TEAM` for extra team wallets.
2. Upload `barkarena/index.html` to `public_html/barkarena/`.
3. Check: sign in → 💬 opens the chat, send "hi"; Club tab → "📣 Post an open challenge", a second wallet sees it under
   "OPEN CHALLENGES"; kennel shows 🥇 on the best-bonded dog; `/admin` shows the "💬 Chat" card.
4. **Shorts factory (once, after steps 1–3):** runs on **GitHub Actions** (free, no VPS): `.github/workflows/shorts.yml`,
   daily 05:10 UTC. Needs: the repo's default branch = `claude/upbeat-hypatia-cht3ou` (scheduled workflows only run
   from the default branch) and the repository secret `ADMIN_KEY`. First run by hand: Actions → "Shorts factory" →
   Run workflow. (Alternative on a VPS: `curl -fsSL https://game.scrappyxrp.fun/kit/shorts.sh -o shorts.sh && bash shorts.sh`.) Set the bio links: TikTok
   `scrappyxrp.fun/barkarena/?src=tt`, Instagram `…?src=ig`, YouTube channel link `…?src=yt`.
5. From 00:15 UTC: week close in `/admin` (⚓ Anchor, then check the pre-picked prizes and "🎁 Send all"; scan each QR
   with the issuer wallet in Xaman). The first load of the treasury reads each piece's metadata once — may take a moment.
   The issuer is no longer a prize winner even if it ranks.
