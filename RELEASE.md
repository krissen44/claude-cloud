# Next release — upload at the week roll (Monday 00:00 UTC)

Changes collect here during the week and go live together when the new week starts.
Live (21 Oct, from the owner's backup of 19 Oct): game **v32.5** (bond fix, hit flash, new /clip) — no Dash yet (no
`dashday:` data on the server). Website: v31/v32.1. Shorts factory (new, 1 a day) on GitHub Actions, 05:10 UTC.

## v39.1 — Joey Wallet extension is live in the Chrome Web Store (same package)
- Checked against the official SDK `@joeywallet/wallet-sdk` 0.5.0 (7 Oct) and the XRPL CAIP-122 spec: our sign-in uses
  the same surface (`window.joey` / `window.xrpl.joey`, `connect({name, icon})`, `signIn({statement, nonce})`), handles
  both result shapes (CAIP-122 message, and `signedTx` for Ledger accounts) and verifies the signature exactly as the spec
  says (ripple-keypairs over the message bytes). The store itself is blocked from the build machine, so the extension
  was simulated with real keys: `tools/test/joey-ext.mjs` (secp256k1, Ed25519, Ledger, late injection, rejection, no
  extension, replay + foreign domain refused) — all pass.
- **New**: "extension not found" now shows a **🧩 Get Joey for Chrome** button (Chrome Web Store); the chooser says
  "Chrome, Brave, Edge"; the website's how-to + FAQ link the store page.

## v39 — Dash: Rocket from 1 Nov, Sleigh from 1 Dec, tester code, Advent doors to open (same package → `bark-arena-game-v39-komplett.zip` + `scrappyxrp-website-v39.zip`)
- **Why** (owner, 23 Oct): every door should hold its Scrappy, blurred until its day and then opened like a box; the
  overall places only say what can be won; Rocket Dash and Sleigh Dash both selectable, both blurred until they open —
  Rocket on **1 Nov**, Sleigh on **1 Dec** — with a tester code field on top.
- **Game**: the Dash tab is always there now (replaces the "hidden until 30 Nov" gate). Two buttons pick the look
  (`DASH.skin`, `ba_dashskin`); a look that isn't open yet shows its hangar blurred with a lock, the opening day + countdown
  and a **tester code** field — owner, 23 Oct: **the whole Dash page is blurred** (hangar, calendar, boards, pilots) under a
  lock panel that stays in view while scrolling, with a **live countdown ticker** (days · hrs · min · sec, `dashTickHtml`,
  `#dashTick`); at zero the page unlocks by itself. With the right code (checked by `/api/public/dash/code`, 8 wrong tries per address and hour)
  the page shows "🧪 TEST MODE" and you can fly it; the server replays test runs but **never books them** (no ranking, no
  bond XP). Team wallets may test without a code.
- **Rocket Dash = ranking only** (owner, 23 Oct): own boards (`rdashday:<day>`, `rdash:<week>`), no calendar, no prizes,
  no prize cards in its view; the Advent calendar and its prizes count **Sleigh runs only** (`dashday:`/`dash:`). Board and
  website take `?skin=rocket|sleigh` (website: Rocket board until December, then Sleigh with the calendar).
- **Sleigh Dash dressed for Christmas** (owner, 23 Oct): the hangar shows the game's painted winter plates as a slowly
  scrolling night town, your pilot flies past in the pixel sleigh, a string of blinking lights on top, snow falling over
  the whole page, snow-capped cards, a candy-cane frame + holly on the Advent calendar, future doors wrapped as red/green
  presents with ribbons, **pixel Christmas wreaths** (`dashWreathUrl`: fir ring, snow, berries, gold baubles, red bow) —
  two swaying on ribbons in the hero, one on every card. Looks only (`dashXmasHero`, `.dwrap.xmas`); Rocket keeps its space look.
- **Advent doors**: future doors = the prize Scrappy blurred behind a 🔒 (rarity shown); today's door = a wrapped gift
  box — tap it, the lid flies off and the Scrappy pops out (remembered per device, `ba_adv_open:<day>`); past doors show
  the Scrappy and the day's winner. Today's prize card appears after opening. **Overall prizes show place + rarity only**
  (the server no longer sends the planned token; admin still sees the plan).
- **Server**: `dashOpens` (env `DASH_OPEN_ROCKET` default 2026-11-01, `DASH_OPEN_SLEIGH` default = `DASH_ADVENT`),
  `/dash/start` takes `skin` + `code`, `DASH_TEST_CODE` (new env), board returns `opens`; env `DASH_OPEN` is gone.
  `server.js` passes the client address to the API for the code rate limit.
- **Website**: the Dash section shows from 1 Nov as "Scrappy Rocket Dash" (Sleigh + Advent "from 1 December"), future
  doors blurred with a lock, overall prizes rarity only.
- **Tester code**: `scrappy589` (owner, 23 Oct) is built into the server (`worker.js`, never in the page). Env
  `DASH_TEST_CODE` replaces it, `DASH_TEST_CODE=off` switches testing off. Preview shots: `node tools/test/dash-preview.mjs <dir>`.
- Tests: `tools/test/dash-gate.mjs` (rewritten), `tools/test/dash.mjs` (doors, box, rarity-only), dash-prize, v35, v36, ui-shots.

## v38.1 — Glitch hit for the energy thieves (same package)
- **Why**: after the v37 balance the three energy-drain traits (Matrix Glasses 55 dogs, Coder Glasses 150, Matrix Rain
  138 — the largest ability group) won only 16–19 % in simulation, worse than no ability (28 %).
- Now they also land a **glitch hit of 2–4 damage that no guard stops** (`glitch: [2, 4]` in the trait data, rules v2
  only, so old replays are unchanged); the AI casts them more readily. Simulation at bond 10: 36–39 % (heals 31–39 %,
  Lightning 55 %, lasers 62–75 %). Trait texts and the website guide say so.

## v38 — Scrappy Dash in new clothes (same package; opening days: see v39)
- **Why**: owner, 23 Oct: the Dash pixel graphics look old-fashioned and lack detail (flat rectangles, no shading).
- **Painted background plates** (`public/art/dash-<sleigh|rocket>-<sky|far|mid>.png`, 480 px wide, far/mid tile
  sideways, parallax .06 / .2): sleigh = dithered night sky with aurora, stars and a shaded moon · jagged snowy alpine
  range lit by the moon + pine forest · an old town with two churches, lit windows, snowy gables, fir trees with lights;
  rocket = nebula, spiral galaxy, ringed planet · lunar ridges and craters · moon base (domes, habitats, masts, solar
  fields). Painted by `tools/dash/plates.mjs` (seeded, reproducible); the owner can swap in own art of the same size.
- **Houses drawn once, in detail** (`dashHouseArt`): brick / planks / plaster / half-timbered walls, shading away from
  the moon, cornice + lumpy snow cover, icicles, garlands, framed windows with snowy sills and shutters, front doors with
  a lamp and wreath, brick chimneys with stone caps; moon base: metal panels, rivets, hazard band, glowing portholes,
  railings, vent hatches, lattice towers. Window life, light strings, smoke and the target arrow stay animated.
- **Pixel sprites** (`dashPx`): sleigh with gold runners + gift sack, rocket, gift, candy cane, bone, shield star,
  crow (2 frames), snow owl (2 frames), asteroid; live moon/earth shaded. Looks only — the simulation is unchanged
  (server replays still match: `tools/test/dash.mjs`).
- Offline build (`tools/dash/standalone.mjs`) inlines the plates.

## v37 — fairer competition, also for Sun 25 → Mon 26 Oct (same package, `bark-arena-game-v37-komplett.zip` replaces v36)
- **Why** (owner, 23 Oct: "the 1st has 100 % wins, the 2nd lost one fight — too much"): the backup of 19 Oct shows the
  top two at 124–8 and 125–6, each with one bond-10 dog (151–5, 227–5), most fights over before round 10. A simulation of
  every active ability at bond 10 (`kitsim`, 1,500 fights each, same player model) found the cause: abilities that do
  damage **through a guard** win 83 % (Lightning — a Rare trait on 127 dogs) to 92–93 % (the three lasers), every other
  ability 10–42 %. Guaranteed damage that nothing answers takes the rock-paper-scissors out of the fight (taunt, cast,
  taunt, cast…).
- **Rules v2** (engine, so page + referee + Club alike): an active ability **recharges for two rounds** after a cast
  (button shows "⏳ 2", `abReady`, `abSpend`, `f.cd`), and a **guard halves** damage that goes through a guard (Lightning,
  lasers; Legendary specials unchanged). The AI now guards when the player's beam is loaded. Same model after the change:
  Lightning 83 → 56 %, lasers 92 → 62–78 %, heals 35–42 %, no ability 28 %. Trait texts say "a guard halves it".
- **Hot streak**: every 5 ranked wins in a row = one heat step (max 3): the rival's bond may go one higher, rarer
  collection dogs and more Legendaries are drawn, and the rival gets **+2 health per step**; each win against a hot
  rival pays **+5 XP per step**. A loss resets it. Shown in the kennel streak chip and on the result card. The referee
  uses the verified streak (`fair.cur`) and tells the page the heat (`/fight/start` → `heat`), so they never disagree.
- **Replays** keep the rules they were fought with (`rules`, `E.heat`); fights recorded before play with the old rules
  on TV/Shorts (`repRules`).
- **Cleaner dog pictures** (owner's screenshot 23 Oct: a dog with Matrix Rain on the gold-ray background kept yellow
  wedges): the cut-out flood from the border can't reach background pieces that streaks or a grid cut off, and the body
  outline kept a 1–3 px fringe of background. New palette sweep in `cutout()`: every pixel outside the body's core
  (`silCore` = outline shrunk by 3 px) with exactly a colour of the removed background — and not a colour the body core
  uses — goes too. Check `tools/test/cutout.mjs` (demo dogs on solid / gold rays / rays + rain / bone pattern / night
  sky): background left over 1,383 → 0 (solid), 1,788 → 124 (rays), 3,171 → 934 (rays + rain, mostly the rain itself),
  4,256 → 0 (bones); no dog pixels lost. Old cut-outs in the browser cache (kennel, rival pool) are dropped once (`ba_cutv`).
- **Bell decisions explained** (owner, 23 Oct: "how did 10/18 beat 11/21?"): the HUD shows health as `10/18 · 56%`, and a
  fight that goes the distance says on the result card "🔔 Decided at the bell on health left: 56 % vs 52 %" (`hpText`, `bellLine`).
- Website guide: recharge + guard halves, hot streak. Bell rule spelled out (share of max health).
- Tests: `tools/test/v37.mjs` (recharge, half damage, referee heat, page + referee agree, old replays) + the suite.

## v36 — also for Sun 25 → Mon 26 Oct: one package with v34 + v35 + v36 → `bark-arena-game-v36-komplett.zip` (replaces the v35 ZIP) + `scrappyxrp-website-v36.zip`
- **Share card (owner: "a game card like a PnL trading card")**: a 1200×675 picture drawn in the page (`cardDraw`,
  canvas, pixel font): big green **+XP**, win rate, "▲ n % vs last week", record, rank, best streak, trainer level, the
  open dog on the arena plate with its rarity glow, player name + pack + badges, and the invite link
  `game.scrappyxrp.fun/?ref=<name>` (friends who join through it count as invites). Three kinds: **📸 Share my week**
  (kennel strip), **last week** (button in the week results), **📸 Share this win** (result screen of a ranked win: both
  dogs, HP left, KO, "UPSET WIN" vs a rarer dog). Modal with 📤 Share (phones: share sheet with the PNG), ⬇️ Save image,
  📋 Copy text. Test `tools/test/card.mjs` (env `PS2P` = Press Start 2P woff2 for true-to-life screenshots).
- **Welcome pack**: a new player (no fights, no trainer XP) gets **double bond XP for 3 days** and a checklist card
  (name, 3 ranked fights, join a pack) → **+3 ranked fights** once. Ladder XP is not doubled (fair play).
- **Comeback bonus**: after 7 days without a ranked/arena fight, the next kennel visit gives **+5 ranked fights** and a note.
- **Boss in the kennel**: one line with health bar, % and days left (tap → arena). The server announces the boss at
  **50 %** and **25 %** once each in the chat and on Discord (#arena-stats) — more players join in earlier.
- **🔁 Revenge**: after a ranked loss, one tap fights the same rival again (1 ticket).
- **Hall of Fame** (website `#fame`, server `/api/public/fame`): every finished week — podium with the prize NFT,
  best pack, SHA-256 and the XRPL anchor link. Hidden until there is a frozen week.
- **Pack chat**: the chat gets tabs 🌍 All / 🐾 Pack for pack members; pack channels (`chat:pack:<id>`) follow the same
  rules (no links, no seeds, mute, 4 s). `/admin` shows pack messages too (tagged), with delete/mute.
- **Trait album** (kennel fold "📖 TRAIT ALBUM"): every trait you fight with (own, borrowed or starter dog) is collected;
  8 layers with progress; a complete layer pays **+2 ranked fights** once; badges Collector (50), Full set, Encyclopedia
  (all 126) → 30 achievements.
- Website guide: 30 badges, trait album, welcome/comeback, share card, pack chat, Hall of Fame.
- Not touched (owner, 21 Oct): Fight Club — hardly used right now.
- Tests: `tools/test/v36.mjs` (boss alert once, Hall of Fame, pack chat privacy + admin, welcome ×2 + checklist,
  album + layer reward, comeback once, revenge) + `card.mjs`.

## v35 — for the week roll Sun 25 → Mon 26 Oct, together with v34 (one package: `bark-arena-game-v35-komplett.zip`)
- **Fix: a rival's picture showed as coloured noise** (owner's screenshot, #4464 in the swamp): an IPFS gateway can answer
  200 with a cut-off picture, and the server kept it in its cache for good. Now `imgOk` checks every picture (PNG must end
  with IEND, JPEG/GIF/WEBP likewise) before it is cached or served; a broken one is fetched from the other gateways, and a
  broken copy already in the cache is replaced on the next request. The page checks the same (`imgComplete`) and fetches
  directly otherwise. Also: no CSS `filter` on fighting sprites any more (aura glow, KO grey, Double Team) — animated
  pixel art with a filter can glitch on some graphics drivers; the glows are separate elements. Tests `img-check.mjs`,
  `fight-fuzz.mjs` (many fights, every scene, desktop + phone).
- **Bond up to 20** (was 10). Levels 11–20 take longer (`BOND.need`: 465 + 90 per level past 10, ≈ 8,700 XP from 10 to
  20). New perks: 12 +1 max health · 14 Deep Breath (Second Wind heals 5) · 16 +2 max health · 18 +1 starting energy ·
  20 Legend of the kennel (+2 max health). Server clamps 10 → `BOND_MAX` 20 everywhere (rivals, referee, replays, Club, registry).
- **Harder for well-trained dogs** (owner: "too easy for high levels"; the backup shows a bond-10 dog at 227 W / 5 L):
  rival bond band `rivalBand` — ±1 below 6, never below yours from 6, up to +2 from 10 (page + referee, same rule);
  more Legendary rivals (12 % → 18 % from bond 8, 25 % from 12, 35 % from 16) and the rarer of 2–3 drawn collection dogs
  from bond 8/14; past bond 10 the AI reads more boldly and answers the player's favourite move ("veteran" `ek`).
  `node tools/test/ai-sim.mjs` now runs bond 1/5/10/15/20.
- **Arena rivals = every player of the week**: all dogs of players with a ladder row, a kennel visit or a squad this week
  (team wallets out — the issuer holds the treasury), up to 90, shuffled round-robin so owners alternate; the page loads
  18 and more as they run low, and picks a different owner each round (today's squads a bit more often). Wild dogs only
  when nobody else played this week.
- **Achievements grow**: 10 new ones (streak 20/30, bond 15/20, 500/1,000 fights, 10 Club wins, 10 Scrappys, 5/20
  weekly badges) and **three new weekly badges every Monday** (drawn from 12 challenges by the week, the same for
  everyone: win 10 ranked, beat 2 Legendaries, 5 knockouts, an arena title, …) with progress bars in the kennel; each
  earned one counts on the ladder (`wk:<week>:<id>`, server accepts this week's and last week's).
- **Week results fit the screen**: wide two-column card (stats + packs | three boards), no scrolling on a laptop.
- Website guide: bond 20 + perks, tougher rivals, arena of the week, 27 badges + weekly badges.
- Tests: `tools/test/v35.mjs` (perks, rival band on the referee, arena pool, weekly badges, week results fit) + the suite.

## v34 — the owner's new look + a compact kennel (21 Oct) · package `bark-arena-game-v34-komplett.zip`
- **Owner's UI/animation work (21 Oct, made on v32.5, merged onto v33):** pixel-art fight backdrops (`public/art/*.png`,
  12 scenes; ranked/casual fights rotate through 10 — meadow, rain, snow, autumn, beach, desert, night, blossom, swamp,
  canyon — arena and club keep their own), weather/ambient particles per scene, a dark "home" look for the menu screens
  (`body.home`), snappier fights (shorter waits, `pose()` key-frame motions per move, new lunge/landing with a floating
  shadow, small cross hit marker instead of the jaws, short comic text), Legendary/Mythic glow (`.lglo/.mglo`) and a
  quick drop-in entrance, tab labels without emoji. Kept as made; Dash got a "Dash" tab in the same style.
- **Server:** `server.js` now serves `/art/*.png` (read once, cached a day) — without it the backdrops would load the game
  page instead of the picture.
- **Kennel, compact (owner: "dogs like tabs instead of one under the other"):** the dogs are a row of picture tabs (bond
  number on each, 🥇🥈🥉 for the top 3, scrolls sideways on phones); tapping one opens that dog below — big picture,
  rarity, bond + XP bar, record and win %, kit, **its bond paths** (the separate "Bond paths" list is gone) and one
  **⚔️ Fight** button (ranked with tickets left, else casual). The open dog is remembered (`ba_ksel`), until one is picked
  it's the top dog. Trainer + Today are one strip (level, ranked fights, streak; quests fold away). Kit rule / bond
  unlocks / TV opt-out, achievements, invites and lending fold away (`fold()`, open state kept while the page
  re-renders; lending opens by itself while a loan is running). Dog pickers in Arena, Club and Dash use small tiles.
  Page height with 12 dogs: desktop 2,621 → 1,400 px, phone 4,880 → 1,652 px.
- **Ladder: every active player (owner, 21 Oct)** — one list of all players who fought this week in a scrolling box
  (max ~460 px), sortable by XP / Wins / 🔥 Streak / Win % (remembered, `ba_lsort`), with W–L, win rate, streak, pack
  emoji, TEAM and 🏅 tags; your row stays visible at the edge (sticky) and "↓ Jump to me" scrolls to it. Server: `/ladder`
  adds `all` (old pages keep the top-10 boards).
- **Packs: tap for details** — compact pack cards (Ø wins, members, win rate, streak); tapping one opens its full numbers,
  the members this week (name, W, L, XP, streak; you highlighted) and its last weeks with the bonuses it won. Server:
  `/packs` adds `members`. The bonus rules fold away. Checks in `tools/test/ui-shots.mjs` (30 seeded players).
- **Fix: the day/week recap was see-through on the dark menu** (the owner's `body.home .card` is transparent): the recap is now a solid card over a dimmed, blurred page.
- Clip speed retuned for the faster fights (`WAIT_K` 1.05 / 1) so Shorts stay 10–14 s.
- Tests: everything re-run (see the commit); `tools/test/ui-shots.mjs` = screenshots of all menu tabs (desktop + phone).
- *(Replaced by v39: Rocket 1 Nov, Sleigh 1 Dec, tester code.)* **Dash goes up but stays hidden until 30 Nov 2026 (owner, 21 Oct):** no Dash tab, `/dash` opens the kennel
  (`DASH_OPEN_FROM`, `dashOpen()`); `?dash=sleigh` shows it for a preview; the server refuses runs before the opening
  except for team wallets (`dashOpenAt`, env `DASH_OPEN=YYYY-MM-DD` moves the date); the website hides its Dash section and
  link until then. 30 Nov = one warm-up day before the Advent calendar starts on 1 Dec. Test `tools/test/dash-gate.mjs`.
- **Upload:** game ZIP via "Neue Dateien hochladen" (it contains `public/art/`); website ZIP
  `scrappyxrp-website-v34.zip` → `public_html/` (only `barkarena/index.html`).

## Shorts rework (13 Oct, after the owner's YouTube review: reach fell from ~1,250 to 50–450 views per Short)
Why: every Short was the same template ("Nobody bet on the …" 11×), 3–5 a day, 17–25 s with a long end card, links in
descriptions (not clickable in Shorts), #Shorts in titles, game words outsiders don't know (Bond, Mythic, Epic).
- **Clip page `/clip` (in the game, `public/index.html`)**: cold open — the decisive round plays first, zoomed on the
  dogs and frozen; "⏪ HOW DID WE GET HERE?"; the three rounds before it; the same round again at the end, so the clip
  runs into its own start (loops). **10–14 s** (was 17–25). One big line on top, max 5 plain words (`clipHooks`: "THIS
  DOG HAS 1 HP", "COMMON vs LEGENDARY", "WAIT FOR THE LAST BITE", "12 DAMAGE. ONE BITE.", …) with ids so the factory can
  avoid repeats (`&avoid=`). No end card for the recorder; "Who would you pick? 👇" at the end. Rarity shown in plain words
  (Epic → super rare, Mythic → ultra rare), no Bond on screen. People opening a link still get ▶ and Watch again/Play.
  New formats on the page: `&fmt=leg&leg=<n>` (Legendary spotlight, entrance shown), `&fmt=boss&boss=<n>` (small dog vs the
  weekly boss), `&fmt=champ|hp1` (hooks for champion / closest win).
- **Factory `public/kit/factory.mjs` + workflow**: **1 Short a day** (was 3). Format by weekday (UTC): Mon Weekly Champion
  (last week's #1 in one of their fights), Wed Legendary Spotlight (#1…#20 in turn), Fri a small dog vs the weekly boss,
  Sun 1 HP Club (closest real win of the week), other days the best real fight; falls back to the best fight.
  `FORMAT=` forces one. Titles: one emotion per video from rotating templates (state `titles`, last 25 never repeat), no
  #Shorts, no Bond/Mythic/Epic. Description: "A real fight from Bark Arena: a free pixel dog battle game where every fighter
  is a real NFT. 🐾" + one line about this fight + a question, **no link**, 4–5 hashtags (`#pixelart #indiegame #dogs
  #gaming #XRPL`; Legendary: `#pixelart #pixelartist #indiegame #legendary`). Pinned comment = the question only.
  TikTok/IG texts: same title idea, no crypto words, ≤ 5 / 8 tags.
- Tests: `tools/test/clipcold.mjs` (lengths, ≤ 5-word hooks, avoid list, spotlight/boss, viewer buttons),
  `tools/test/shorts.mjs` (end to end), `tools/test/shorts-fmt.mjs` (formats, rotation, fallbacks).
- **Going live:** the clip page is part of the game → hotfix **v32.5** (`bark-arena-game-v32.5-komplett.zip` = v32.4 + the
  new `/clip`, no Dash) or the v33 package. The factory and workflow run from the repo's **default branch**
  (`claude/upbeat-hypatia-cht3ou`) — pushed there on 13 Oct with the owner's OK (commit cbf323c), active from the next 05:10 UTC run. The new factory also works with the old clip page
  (titles/texts/one a day right away; the 10–14 s cold open once the game is updated).
- Owner's to-dos on YouTube (not code): links into the channel header (scrappyxrp.fun/links) and each Short's "Related
  video" (the tutorial); reply to comments; channel description "Daily pixel dog fights & lofi"; spread the lofi Shorts
  to one a day and upload a 30-minute "Rainy Night" (the factory doesn't make the lofi videos).

## Hotfix v32.4 (12 Oct, upload right away, replaces v32.3): dogs still turned white on iPhone
- **Bug:** the owner reports the white dog after a hit is still there with v32.2/v32.3. Changing the sprite's own
  `filter` — by class (v32.1) or as a Web Animation (v32.2) — could stay stuck in iPhone Safari.
- **Fix:** the sprite's filter is never changed during a fight any more. The hit flash is a separate white silhouette
  (`.hitw`, the sprite image as CSS mask) laid over the dog, faded out in 0.3 s and removed (`hitFlash`). Also: the
  Legendary/Mythic aura no longer switches filter on hurt (`:not(.hurt)` removed), the charge pose no longer animates a filter.
- `bark-arena-game-v32.4-komplett.zip` = hotfix branch commit c8963bf (v32.1 + bond fix + this, no Dash). Test
  `tools/test/hitflash.mjs` (desktop + phone width: silhouette aligned, sprite filter untouched, removed after rapid hits).
  Not testable on real WebKit here — the owner checks on an iPhone. Same change in the v33 package.

## Hotfix v32.3 (12 Oct, uploaded or superseded by v32.4): the bond fix didn't reach #3615 live
- **Bug:** after v32.2 the owner's #3615 still showed Bond 1 in the new wallet. On sign-in the game uploads the save
  (`cloudPull` → `/api/save` → `bondRecord`) *before* the kennel loads, so the new wallet's Bond-1 save was recorded first
  and the scan of old saves never ran for that dog.
- **Fix:** `bondSeed` — before the registry is written or read, each dog is looked up once in all saves (most trained
  copy in another wallet wins, entry marked `scanned`). Entries v32.2 already wrote wrongly are repaired the same way.
  #3615 gets its bond back on the next kennel load (↻ Refresh or sign in again) after the upload.
- `bark-arena-game-v32.3-bondfix-komplett.zip` = hotfix branch commit 6dd30c7 (no Dash). Test `bond-transfer.mjs` got
  both cases (save before kennel, wrong v32.2 entry). Same fix in the v33 package.

## Hotfix v32.2 (12 Oct, uploaded by the owner): v32.1 + the bond fix only, **no Scrappy Dash**
- **Also in v32.2: dogs stayed white on iPhones after a hit** (a player's screen recording, iPhone Safari): the hit flash
  was a CSS class with `filter: brightness(4)` toggled on the image while its idle/guard animation ran; WebKit kept the
  flashed picture after the class was removed. Now the flash is a short Web Animation of the filter (`hitFlash`) that
  ends on the dog's normal filter, followed by a forced repaint. Chrome/Android were never affected.
- `bark-arena-game-v32.2-bondfix-komplett.zip` = commit 546417b (v32.1) + the bond-travels-with-the-NFT fix below
  (local branch `hotfix/bond-carry`, commit 6415890). Contains no Dash code. Tested: `bond-transfer.mjs`, `market.mjs`.
  The v33 package for Monday contains the same fix, so uploading the hotfix first changes nothing there.

## Fix (owner, 12 Oct): the bond level travels with the NFT — in the same package for Monday 19 Oct
- **Bug:** the owner sent a Pixel Scrappy to another wallet and it arrived at Bond 1. A dog's training (bond level, XP,
  record, bond paths) lived only in the save of the wallet that trained it.
- **Fix:** the server keeps the latest training **per NFT** (blob `bonds`), written from the cloud save of the wallet
  that holds the dog — and only by the newest holder on record, so a seller whose kennel wasn't reloaded since the
  sale can't change it any more. When a wallet loads its kennel, every dog that came from elsewhere carries its training
  along (`/me/kennel` → `carry`): the game adopts the higher bond, XP, record and bond paths and shows
  "🐾 Bond carried over — … Bond 6". A fresh Bond-1 save of the buyer can't wipe it before it's adopted. Dogs that
  changed hands **before** this fix (like the owner's #3615) are found once in the old owner's save on the server
  (the most trained one wins), so they get their bond back on the next kennel load after the upload.
- Test: `tools/test/bond-transfer.mjs` (A trains #3615 to bond 6 → sends it to B → B's kennel/game shows bond 6 with XP,
  record and path; an old save is found; B's fresh save and A's stale save can't overwrite it). `lend.mjs`, `market.mjs`,
  `dash.mjs` still pass. (The test mock reads `HOLD_FILE` so a test can move dogs between wallets.)

## v33 — Scrappy Dash mini game · for Monday 19 Oct (built 12 Oct, owner's idea "Scrappy Sleigh Dash")
- **New tab "🛷 Dash"** (also straight at `game.scrappyxrp.fun/dash`): a one-tap endless runner. The player's own
  Scrappy (its NFT picture) flies a sleigh over snowy night roofs. **Hold** = climb, let go = sink, **quick tap** (< 0.18 s)
  = drop a gift. A gift that falls into a **glowing chimney** scores 25 × combo (combo up to ×5); a gift on a roof or a
  wrong chimney breaks the combo. Pick up gift boxes (+2 gifts, max 9), candy canes (+5) and a rare ❄ shield (one free
  crash). Tall chimneys, roofs and (from 7 s) crows end the run.
  **No safe lane at the top (owner's playtest, 12 Oct):** flying along the upper edge farmed points almost risk-free
  (a bot hugging the top survived 72 s / 2,242 pts vs 20 s / 508 for normal play). Now time spent above y 70 builds up
  `hi`: more crows come in at the sleigh's own height, and **snow owls** (rocket: comets) sweep the top band fast, with a
  blinking ❗ at the edge first and a one-time "SNOW OWL! — the sky isn't safe" note. Hugging the top now ends in
  ~11 s (~190 pts); normal play is unchanged. Test `tools/test/dash-camp.mjs` + a camping run in `dash.mjs`. Speed 150 → 420 px/s (+4.2/s), so a run lasts about
  30–90 s. Score = distance/10 + deliveries + pickups. Keys: Space/↑ hold, ↓ drop, Esc quit. Phones get a taller field.
- **Christmas look (owner: "more decoration, blinking lights, more life"):** every house gets its own dressing —
  light strings along the roof (chase / blink / twinkle, four colour sets), icicles, garlands, wreaths on the wall,
  smoke curling from the chimneys; windows hold flickering candles, little trees with blinking lights, advent stars,
  people who come to the window now and then (some in a Santa hat) and wave when the sleigh flies by. Sky: twinkling
  stars that flare into crosses, a glowing full moon with a breathing halo, a soft aurora, shooting stars, far windows
  that switch on and off. The sleigh has blinking bulbs and a bell; the Dash tab header has falling snow and a glowing moon.
- **Glitter milestones (owner: "sparkling animations when you collect a certain amount or reach points"):** at 250,
  500, 1,000, 1,500, 2,000, 3,000, 4,000, 5,000, 7,500, 10,000 points (then every 2,500), every 10th candy cane
  ($SCRAP coin), every 5th delivery and the first ×5 combo: glitter rain over the whole field, a sparkle burst around
  the dog, a golden shimmer, a popping gold banner ("1,000 POINTS — GREAT!", "10 CANDY CANES — SWEET!",
  "5 GIFTS DELIVERED — HO HO HO!") with dancing sparkles, a bell jingle, and the sleigh trails glitter for 2–3 s
  (the score blinks gold). Every pickup and delivery also gives a small glint.
- **🎄 Advent Dash — a prize every day for 24 days + an overall ranking (owner: "every day something to win until
  Christmas — daily ranking and an overall ranking"):** from **1 Dec to 24 Dec** (env `DASH_ADVENT`, default 2026-12-01)
  the best run of each UTC day wins (`DASH_DAY_PRIZE`, default "a Pixel Scrappy"; `DASH_DAY_PLACES`, default 1), and
  after the 24th the **overall ranking = each player's best run of every day, added up** — top 5 win (see below) — so coming back every day pays. Team wallets never
  win. The Dash tab shows an **Advent calendar** (24 doors: today's glows, past ones show the day's winner, ⭐ where you
  played), **today's ranking** (+ yesterday's top 3) and the **Advent overall** ranking (before December: this week's
  board and a "starts 1 Dec" teaser). `/admin` → "🎄 Advent Dash": a day is frozen 30 min after it ends, the winner
  is listed with a treasury pick and "🎁 Send (Xaman)" — same flow as the weekly prizes; the winner gets a prize card in
  the kennel ("Advent Dash day 3 (2026-12-03)") and accepts it.
- **Scrappy bonus + overall top 5 (owner: "players with a Scrappy should get a points bonus, but not so high that
  players without one still have a chance; the overall top 5 win: 1st Epic, 2nd & 3rd Rare, 4th & 5th Uncommon"):**
  a run flown with an **own** Pixel Scrappy is booked with a bonus by its rarity — Common +5 %, Uncommon +6 %, Rare +7 %,
  Epic +8 %, Legendary/Mythic +10 % (`DASH_BONUS` in `worker.js`). The server looks the dog up in the player's holdings
  at `/dash/start` (borrowed, starter, demo or someone else's dog = no bonus) and books `raw × (100 + bonus) / 100` after
  the replay. Shown on the pilot cards ("+7 % points"), in the HUD ("+7%") and on the result card ("436 + 5 % Scrappy
  bonus"). The overall ranking's **top 5** win, one rarity per place: env `DASH_GRAND_PRIZES` (default
  `Epic,Rare,Rare,Uncommon,Uncommon`) — shown in the calendar text, as 🎁 tags on the overall board and on the website;
  `/admin` pre-picks a treasury piece of that rarity for each place (daily winners get the most common piece left) and
  warns when the treasury has none. (`DASH_GRAND_PRIZE` / `DASH_GRAND_PLACES` are gone.)
- **What you can win, every day + claiming right on the page (owner: "show what you can win each day; winners claim
  on the site"):** `/admin` → "🎄 Advent Dash" now starts with a **🔎 treasury check, live from the issuer wallet** (free
  Pixel Scrappys by rarity vs. what the event needs: 24 daily winners + Epic, Rare, Rare, Uncommon, Uncommon) and a
  **🎁 prize plan**: "✨ Auto-plan" gives the overall places their rarity and the 24 days the rest (most common first,
  so it gets better towards Christmas; hand-built Legendaries #1–20 never); every pick can be changed, "💾 Save plan".
  Sent prizes stay fixed. The calendar (game + website) shows each day's Scrappy — past/today in full, coming days
  blurred with their rarity — plus "🎁 Today's prize" and the 5 overall prizes with pictures. Sending a prize pre-picks
  the planned piece. **Claim on the website:** `/barkarena/` lists the winners; a waiting prize has "🎁 Claim" → Xaman
  QR / "Open in Xaman" (only the winner's wallet can sign the free offer, so no sign-in is needed) or the Joey hint;
  it turns "✅ collected" when signed. In the game the prize card also shows in the Dash tab.
- **Fair rankings — every run is replayed on the server.** With real prizes a score check isn't enough: the run's
  simulation is now deterministic (fixed 1/60 s ticks, dice from a seed the server hands out, no sin/random inside;
  `//@dash` section of `public/index.html`), the page sends only its taps (press/release/drop per tick), and the server
  replays them (`fight-engine.js` → `loadDash`) and books **its own** score. A score raised in the page, a run longer
  than the time since its start, someone else's run id or a reused one are refused. Tested: the browser and the server
  get exactly the same score (desktop and phone field). Left open: a bot that plays in real time with perfect taps.
- **Challenging but "one more run":** close-call bonus (+15 for skimming a tall chimney or a crow by < 10 px), a
  target on the HUD ("#2 ▸ 4,210" — the next score to beat on today's ranking) and a glitter banner when you pass
  someone ("PASSED DASHER — NOW #2 TODAY", "#1 TODAY!"). Difficulty measured with an autopilot over 200 seeded runs:
  median ~22 s, best ~60–70 s; the first seconds are calm, then it keeps getting faster.
- **Fix:** `DASH_THEME` (and the new `DASH_*` variables) are now passed from Hostinger to the API — before, the server
  never saw `DASH_THEME`.
- **Free, unlimited, no tickets.** Signed-in runs go to a **weekly Dash board** (best run of the week, resets Monday
  00:00 UTC, last week's top 3 shown). Guests/demo can play for fun. The dog earns a little **bond XP** (score ÷ 150, max
  15 per run, 40 per day; own dogs only, not borrowed/demo). No ladder XP, no influence on fights' fairness.
- **Anti-cheat (light):** `/api/dash/start` hands out a run id; `/api/dash/end` refuses a run longer than the time since
  its start, a score above 260 points per second of play (+500), someone else's run id or a reused one.
- **After Christmas it becomes "🚀 Rocket Dash"** automatically (from **27 Dec 2026 00:00 UTC**): same mechanics, rocket to
  the moon, bones into glowing moon-base hatches, $SCRAP coins (only a picture — nothing is paid out), antenna towers
  and asteroids. Env **`DASH_THEME=sleigh|rocket`** on Hostinger overrides the date (e.g. rocket until December, sleigh
  from 1 Dec). Preview either skin with `?dash=rocket` / `?dash=sleigh`.
- **Website** `/barkarena/`: section "🛷 Scrappy Sleigh Dash" with this week's top 5 (`/api/public/dash`, switches its
  text to Rocket Dash with the server) + "▶ Play the Dash" button, TOC link.
- Tests: `tools/test/dash.mjs` (run ids + seeds, faked score/time/inputs refused, browser bot runs replayed by the
  server on desktop and phone width, daily/overall rankings, Advent calendar, frozen days, team skipped),
  `tools/test/dash-prize.mjs` (a frozen day's prize offered via Xaman, seen and accepted by the winner only).
- Upload: full project ZIP `bark-arena-game-v33-komplett.zip` (Node.js app, "Neue Dateien hochladen"),
  `scrappyxrp-website-v33.zip` → `public_html/` (replaces `barkarena/index.html`).

## v32.1 hotfix — upload right away (only `public/index.html`), fixes a live link
- **Discord "▶️ Watch the fight" link (`/clip?id=…`) showed both dogs but never started.** The /clip page was built for
  the Shorts recorder, which starts playback itself (`CLIP.go()`). Now a person who opens the link gets a big
  "▶ Watch the fight" button (it also unlocks the sound); the end card adds "↻ Watch again" and "🐾 Play Bark Arena"
  (`scrappyxrp.fun/barkarena/?src=clip`). The recorder (headless, `navigator.webdriver`) sees neither, so the Shorts
  look the same. Test: `tools/test/clipview.mjs` (seeded v32 replay plays to the end; recorder path unchanged).
- **Ladder tags fixed:** the TEAM and 🏅 achievement tags in the ladder rows were squeezed and overlapping —
  `.lb span:nth-child(…)` (meant for the rank and name columns) also hit the tags inside the name. Now `.lb>span`,
  rows centred, tags sized for the row.
- **Lending market visible to holders:** the market card (with “Borrow”) is only for players without a Pixel Scrappy,
  so a holder (e.g. the owner testing with a second wallet) saw nothing and thought the listings were gone. The lend
  card now shows “On the market now” — every open offer, view only. Test: `tools/test/market.mjs`.
- **Holders can borrow too** (owner: “shouldn't players who have Scrappys be able to borrow as well?”): the
  `borrower_holds` check is gone from `/lend` (lend by name) and `/lend/take` (market); still max **1 borrowed dog**
  per player (`borrower_busy`), max 3 lent out per owner. A holder's lend card is now “🤝 LEND & BORROW”: the market
  offers carry a Borrow button (hidden while they already borrow one). Borrowed dogs don't add tickets, can't go into
  the Club or arena defence (unchanged). The “I'm looking for a dog” list stays for players without a Scrappy.
  Website FAQ updated. Tests: `market.mjs` (holder borrows, fights, kennel 4 own + 1 borrowed), `lend.mjs`.
- Upload: Hostinger's Node.js deploy (“Neue Dateien hochladen”) needs the **full project ZIP** — a ZIP with only
  changed files is refused (“Nicht unterstütztes Framework oder ungültige Projektstruktur”). Use
  `bark-arena-game-v32.1-komplett.zip` (package.json, server.js, worker.js, fight-engine.js, public/, node_modules/).
  `-nur-dateien.zip` is only for the file manager.
  `scrappyxrp-website-v32.1.zip` → `public_html/` (replaces `barkarena/index.html`).
  (`bark-arena-game-v32.zip` was rebuilt with it, for a full redeploy.)

## v32 — LIVE since 9 Oct (owner uploaded early; was planned for Monday 19 Oct) (built 9 Oct, owner's go: "the rest sounds good, build it" — everything except $SCRAP)
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

## v31.3 — LIVE since 9 Oct (inside the v32 upload)
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
