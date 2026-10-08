# Scrappy XRP — Bark Arena game + scrappyxrp.fun website

Project context for Claude Code. The owner speaks **German**: answer in German, keep code, comments and
commit messages in English. They deploy by uploading ZIPs to **Hostinger**, so finish work with a ZIP of
exactly the files to upload and say where each goes.

## What's in this repo

| Path | What it is | Where it runs |
|---|---|---|
| `server.js`, `worker.js`, `public/index.html`, `package.json` | **Bark Arena**, the Pixel Scrappy NFT fighting game | Hostinger Node.js app → `https://game.scrappyxrp.fun` |
| `website/` | Pieces of the **scrappyxrp.fun** site (static files) | Hostinger `public_html/` |

Git branches used so far: `claude/dreamy-pasteur-du9fm3` (up to v29), `claude/upbeat-hypatia-cht3ou` (v30+) — repo `krissen44/claude-cloud`.

**Release rule (owner's decision):** changes are **not uploaded one by one**. They collect during the week and go live
together at the **week roll (Monday 00:00 UTC)**. Record every change in `RELEASE.md` (what, why, upload steps) and
hand over one combined package for the week start; don't tell the owner to upload mid-week.

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
- **Wallets** (owner's wish: **Joey Wallet is named first and marked recommended everywhere** — game, website, videos): "Connect wallet" in the game opens a chooser: **Joey app** ⭐ Recommended (WalletConnect v2,
  QR on desktop / `wc:` link on phones), **Joey extension** or **Xaman** (QR / deeplink) (provider `window.joey`, npm `@joeywallet/wallet-sdk`,
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
- **`fight-engine.js`** — runs the game's own engine on the server: the pure sections of `public/index.html` are
  marked `//@engine … //@/engine` and loaded into a `node:vm` sandbox (`loadEngine` → `defFromMeta`, `start`, `round`).
  **Keep those sections free of DOM/UI code**; the server refuses to start if fewer than 8 are found.
- **`public/index.html`** — the whole game client in one file (≈2,300 lines: CSS, a big `DATA` JSON on line ~243
  with fighters/traits/combat/legendaries/sets, engine, UI). Progress lives in `localStorage` (`ba_save_v1:<account>`).

### Environment variables (Hostinger)
`ISSUER=rGAVUGyhdbxQs1G7nwCCFU4w8P4HfgFKD6`, `TAXON=369` (empty/`*` = any taxon), `XUMM_API_KEY`, `XUMM_API_SECRET`,
`RETURN_URL=https://game.scrappyxrp.fun/`, `ADMIN_KEY` (admin dashboard; unset = admin off), optional `TEAM` (extra team wallets, comma-separated; the issuer always counts as team), `ACCESS_KEY`, `SESSION_SECRET`, `DATA_DIR`, `IPFS_GATEWAY`,
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
| `/profile` (POST `{name}`) | ✔ | Set/clear the display name (409 `name_taken`, 400 `bad_name`) |
| `/arena/rivals` | ✔ | Up to 30 Scrappys held by other players, today's registered squads first `{token,id,uri,lvl,owner,squad}` |
| `/arena/squad` (POST `{ids}`), `/arena/result` (POST `{id, attackerWon}`) | ✔ | Register today's squad / report an arena fight vs another player's dog |
| `/arena/defense`, `/arena/defense/claim` (POST `{upTo}`) | ✔ | Pending defence bond XP for the caller / mark it collected |
| `/chat[?since=id]` (GET), `/chat` (POST `{text}`) | ✔ | In-game chat: last 80 messages (no wallets in the feed), plain text, no links except scrappyxrp.fun/xrp.cafe, no family seeds, 1 msg / 4 s; 403 `muted` |
| `/club/me` (incl. `lobby` = open challenges), `/club/create` (POST `{dogId, opponent?, open?}`), `/club/state?id=`, `/club/join` (POST `{id,dogId}`), `/club/cancel`, `/club/move` (POST `{id, move}`), `/club/leave` | ✔ | Fight Club beta: the server is the referee (see below) |
| `/save` (GET/POST) | ✔ | Full browser save per wallet (cloud backup + cross-device sync), file `DATA_DIR/saves/<account>.json` |
| `/lend/seek` (POST `{on}`) | ✔ | A non-holder with a name puts themselves on the "looking for a dog" list (7 days); `/lend` GET returns `seeking` + `seekers` |
| `/lend` (GET; POST `{dogId,to,days}`), `/lend/end` (POST `{id}`), `/lend/report` (POST `{id,bond,trainer}`), `/lend/claim` (POST `{upTo}`) | ✔ | Lending: loans given/taken + rewards waiting for the owner; borrower reports XP earned with the dog |
| `/public/results[?week=]` | – | Frozen results of a finished week: canonical `json` string + `sha256` + `anchor` tx + prizes (CORS `*`) |
| `/prizes`, `/prizes/claim` (POST `{week,place}`), `/prizes/status?uuid=` | ✔ | The player's prize offers; claim → Xaman NFTokenAcceptOffer payload for the ledger sell offer |
| `/admin/season`, `/admin/anchor` (POST `{week}`), `/admin/prize` (POST `{week,place,nftId}`), `/admin/xaman?uuid=` | `?key=ADMIN_KEY` | Week close: results, treasury, Xaman payloads signed by the issuer wallet, payload status |
| `/admin/chat`, `/admin/chat/del` (POST `{id}`), `/admin/chat/mute` (POST `{account,on}`) | `?key=ADMIN_KEY` | Chat moderation (also on the `/admin` page) |
| `/replay` (POST), `/tv` (GET; POST `{off}`), `/src` (POST `{src,at}`) | ✔ | Upload a finished fight as replay (moves + dice) / Bark Arena TV opt-out / first-touch source of a new player |
| `/public/replays[?n=&skip=]`, `/public/replay?id=`, `/public/dogimg?t=`, `/public/hit` (POST `{src,ev}`) | – | TV + Shorts playlist, one replay, collection image (disk cache), website funnel ping (`view/mintview/mint/play/demo`) |
| `/bonus` (GET), `/bonus/claim` (POST) | ✔ | Extra ranked fights (admin-granted, or once automatically by `bonusAuto` = v31.1 day-one compensation, blob `tixbonus_auto`), collected once on the kennel load (`loadBonus`, note card), blob `tixbonus` |
| `/admin/tickets/scan?since=`, `/admin/tickets/grant` (POST `{grants:[{account,n}], from?, note?}`) | `?key=ADMIN_KEY` | Holders who started since a week (first weekly row) + their day-one grant; grant from a day on (default tomorrow, 7 days) |
| `/admin/funnel` | `?key=ADMIN_KEY` | Website visits per source/day + players per source (`srcs` blob) |
| `/admin/clips` (GET list), `/admin/clips/upload?name=` (PUT), `/admin/clips/file?name=[&download]`, `/admin/clips/posted` / `delete` (POST) | `?key=ADMIN_KEY` | Shorts clips — **handled in `server.js`** (Node only, files in `DATA_DIR/clips`, kept 30 days) |
| `/admin/export[?download=1]`, `/admin/csv` | `?key=ADMIN_KEY` | Everything as JSON backup (summary, per-player rows, raw store + saves) / players as CSV. Dashboard page: **`/admin`** |

### Game rules (as implemented — keep the website guide in sync)
- **Fight**: 10 rounds, healthiest (% HP) at the bell wins. HP 16 + rarity bonus (Unc/Rare +1, Epic +2, Legendary +2, Mythic +3).
  Energy starts 2, +1/round, max 9. **Bite** 4–7, 15% miss, +2 vs taunt. **Guard** blocks bite, +1 energy and
  **snaps back 2** (`C.guard.snap_vs_bite ?? 2`). **Taunt** +2 energy, chips 2 through guard. **Frenzy** from round 7: +1…+4 bite damage.
- **Kit**: only the 3 rarest of 8 traits fight, max 1 active ability. Mythic sets add a set bonus; Legendaries use hand-built kits.
- **Opponent AI (v30)** (`ai()`, `predictFoe()`, `aiLearn()`, `aiPickAbility()`, all in an `//@engine` section): predicts the
  player's next move from this fight (order-1/2 context + frequency) **and from earlier fights** (`AIM` = per-player
  transition counts, kept in the save as `SAVE.data.ai`, loaded in `startFight`, only learned from the real player, never
  in ghost sims). It scores three answers to its read (counter / counter-the-counter-player / one more, `f.lv`, carried
  over in `AIM.lv`) and plays the one that works, so baiting a pattern stops paying. Skill `aiSkill(foe)` = .30 at bond 1
  → .975 at bond 10: follows reads more often, casts abilities when they pay (heal when hurt, damage when no guard is
  expected, shields vs bites), reads the board (guards a loaded foe ability) and plays the score in the last 2 rounds.
  Never peeks at the current move (except the intended 30% "Insight" trait). Benchmark `node tools/test/ai-sim.mjs`
  (player win % at bond 1/5/10, ±3 noise): random ≈46–50 everywhere, always-bite 23/14/6, alternating 10/5/2, counter-the-counter 41/39/46
  (old AI: 67–71), adaptive 48/47/43. Real players won 76 % (top 88–95 %) against the old AI in week 2. Re-run after AI/rule changes.
- **Rivals (ranked fights)**: random collection dogs (#21–5000, `COLLECTION_SIZE`), fetched in the background into a rotating pool
  (`OPP`), ~12% Legendaries, never a token in `/taken`; demo dogs only until the pool loads. Bond level ±1 of yours.
- **Rivals (arena)**: only Scrappys other signed-in players hold (`/api/arena/rivals`, from `holdings[].dogs` + the
  owner's cloud save for the real bond level), labelled "#123 from <name|short wallet>" (`RIVALS`, `ensureRivals`,
  `ghostOpp`, `rivalLabel`). No other players yet / demo → a "wild" collection dog without owner. No invented handles anywhere.
- **Arena defence XP**: picking a squad registers it for the UTC day (`/api/arena/squad`, `arenaRegister`). Rivals come
  from registered squads first. Each arena fight against another player's dog is reported (`/api/arena/result`,
  `arenaReport`); if that dog is in its owner's squad today, the owner gets bond XP queued (18 win / 6 loss, cap 120 per
  dog per day, max 12 reports per attacker per day). The owner collects it on the next kennel load (`/api/arena/defense`
  → `claimDefense` → `SAVE.bondXp`, then `/api/arena/defense/claim`) with a notice. Bond XP only — no trainer XP/ladder.
- **Team wallets**: the issuer (+ `TEAM` env) plays for testing — shown with a TEAM tag on ladder, public board, chat
  and in frozen results (`team: true`), but skipped for prizes and not counted in pack standings (`isTeam`).
- **Chat**: 💬 button bottom-right on menu screens for signed-in players (hidden in the ring), `CHAT`, `chatSync`,
  `chatPoll` (4 s open / 25 s closed for the unread badge), `chatSend`. System messages announce open Club challenges
  and borrow requests (`chatSystem`). Stored as blob `chat` (`STORE.blobGet/blobSet`; D1 table `blobs`).
- **Kennel ranking**: sort buttons Bond (default; medals 🥇🥈🥉 then #n, by bond level, XP, W−L) / Rarity / Number
  (`KSORT`, `bondOrder`, saved in `localStorage.ba_ksort`). "Top dog" line in the kennel card.
- **Name nudge**: after a ranked win or a live arena run with a win, a player without a name gets "✏️ Set a name" (`nameNudge`).
- **Player names**: optional display name (`/api/profile`, 3–16 chars `[A-Za-z0-9 _.-]`, unique case-insensitive, no
  wallet look-alikes), set via ✏️ in the wallet card; shown in ladder, public board, arena labels and admin.
- **Tickets**: 5/day + 1 per extra owned Scrappy (max 10), bank max 15 — unused ones carry to the next day but **not into a new week** (Monday starts at the daily grant, `newWeek` in `checkDay`). Ranked XP: win 30, loss 12, +10 vs rarer.
  Casual = no XP and does **not** touch the streak.
- **Streak**: consecutive wins in ranked fights and live arena fights only (`streakAfter`).
- **Bond** levels 1–10 (`need = 60 + (l-1)*45`), perks at 2/4/6/8/10. Trainer level every 250 XP. 3 daily quests.
- **Arena**: **3 knockout tournaments per UTC day** (`ARENA_RUNS`), squad up to 3, quarter/semi/final, XP 0/35/60/100
  shared across the squad, ghosts half XP. A tournament counts when it starts. Demo is unlimited.
- **Packs** (server-enforced): 4 packs, max 10 members, ranked by **wins per member**. One pack a week: joining with no
  pack is instant and locks the week (`lockWeek`); switching or leaving is only queued for Monday 00:00 UTC
  (`pending`, `"-"` = leave). Weekly bonuses Fang/Hide/Spirit, one per pack, defend +10%/+20%, barred after 3 weeks.
- **Fight Club (beta, Season 1)**: duel by name (`opponent` = display name) or invite link `/?duel=<id>` (opens the
  Club tab after sign-in). Both send a move (`bite|guard|taunt|ab0-2`); the server resolves the round with the shared
  engine and a random seed, stores `{t,a,b,seed,auto}` and both pages replay rounds with `resolveSeeded` (A = left =
  challenger). 20 s per round (`CLUB_TURN_MS`), missed round = auto-guard, 2 misses = forfeit, leave = forfeit, invites
  expire after 15 min, max 3 open per player. **Open challenges** (`open: true`) show for everyone in the Club tab
  (`lobby`, "📣 OPEN CHALLENGES", newest 12) and are announced in the chat. Own record (`clubAdd/clubGet`), no tickets, no XP. Client: `SC`,
  `scClubView`, `scEnter`, `scStep`, `scControls` in `public/index.html`; the old ROOM (P2P) code stays for hosts with a
  realtime room. Season 2: matchmaking, Elo, Club ladder.
- **Week close (verifiable results + prizes)**: 15 min after Monday 00:00 UTC a finished week is frozen once
  (`weekResult` → `db.results[week]` = canonical JSON of players, packs, prize winners + SHA-256). `/admin` shows it:
  "⚓ Anchor" = Xaman QR for an AccountSet from the issuer with memo `barkarena/results` `{week, sha256, results URL}`;
  "🎁 Send" = Xaman QR for NFTokenCreateOffer (Flags 1 sell, Amount "0", Destination = winner) with an NFT from the
  **treasury = Pixel Scrappys held by the issuer wallet**. `/admin/season` returns each treasury piece with its rarity
  (`treasuryRarity`: metadata `Rarity`, #1–20 = hand-built Legendary, `rank` 7…1); the admin page pre-picks unsent prizes
  rarest-first (1st, 2nd, 3rd, pack, lender lines; hand-built Legendaries only with the checkbox) and has
  "🎁 Send all" (one Xaman QR after another, `sign(…, onDone)`). Prizes: top 3 of the XP ladder + the most active member
  (wins+losses) of the winning pack who isn't already top 3. Winners see a card in the kennel (`PRIZE`, `prizeCards`,
  `prizeClaim`) → Xaman NFTokenAcceptOffer, or accept in any wallet (claim then detects ownership). The website shows
  prizes + tx + hash under "Last week — final". No key on the server — every ledger write is a Xaman signature.
- **Lending** (Season 1): a holder lends a dog (by player name, 1–14 days, max 3 out) to a player who holds **no**
  Pixel Scrappy (max 1 borrowed). NFT never moves; `db.loans`. Ends early by either side, or when the owner no longer
  holds the dog. Borrower's kennel shows it (`f.borrowed`, bond level from the owner's cloud save via `SAVE.setBond`);
  `SAVE.award` → `lendGain` → `/lend/report`: the bond XP goes to the dog, **25 %** of the borrower's trainer XP to the
  owner (cap 150/day), queued in `db.lendq`, collected on the owner's next kennel load (`loadLending`). Borrowed dogs
  can fight ranked + arena, not the Club, and don't register for arena defence. Non-holders can tap "🙋 I'm looking
  for a dog" (needs a name; blob `lendseek`, 7 days); holders see the names in their lend card (tap = fill in). Prize share: a prize won with ≥ 50 % of
  the week's XP on one borrowed dog adds a line `L<place>` for the lender in week close (admin decides to send it).
- **Stage visuals (v27)**: `stage()` picks a backdrop by `stageTheme()` — `meadow` (ranked/casual), `arena` (`arenaRun`),
  `club` (`clubMode`) — built in `scenery()` (CSS-animated DOM: birds, tufts, pennants SVG, crowd, spotlights, neon).
  The fx canvas (`fxInit(canvas, theme)`, `loop`, `drawMark`) draws particles, `marks` (ring, star, streak, wave,
  bubble, flash) and an ambient layer per theme. `play()` maps engine events to effects (`chomp`, `fxBubble`, `fxWave`
  + `sayBubble`, `anim(..,'dodge'|'charge')`, `stageMood` for dusk/frenzy, `koFx` + `confetti` at the end). Never put
  visuals inside the `//@engine` sections. `RM` = prefers-reduced-motion → no ambient, no shake.
  v28: bites use `lungeTo` (WAAPI, real distance, holds at the rival) + `lungeBack` on impact/miss/round end; jaws =
  SVG `chomp()`, `biteMarks()`, `comic()`. Abilities: `abStyle(ab)` maps ability id/effect to a style; `abCast` (on the
  caster at the moves event), `abShot` (replaces the laser/bolt event), `abImpact` (instead of jaws), `wardFx` (shield
  event). A fighter has at most one active, so `abOf(side)` = `actives[0]`. Effects aim at `dogBox()` (the sprite's
  current box, so they follow a jumping dog). Mythic/Legendary: `auraInit` (classes `aura-leg`/`aura-myth`, `.lrays`,
  `.mring`), `introFx` (drop-in, pillar, banner `.leg`/`.myth`, `S.fanfare`, blocks input ~1.3 s), `auraTick` sparkles.
  v29 sounds (all WebAudio synth in `S`): `chomp`, `leap`, `land`, `crowd` (arena/club only), `ko`, and one per
  signature move (`thunder`, `choir`, `stampede`, `rocket`, `dip`, `crash`, `splash`, `prism`, `twin`, `munch`, `matrix`,
  `runes`, `voidHum`, `alchemy`, `ward`, `crystal`, `charge`).
- **Replays (v31)**: every finished non-demo fight is recorded unless the player opted out (`SAVE.data.tvOff`, kennel
  button, server blob `tvoff`): `REC.cur` in `startFight`, `recRolls` wraps `resolve` in `go()` and keeps the engine's
  `Math.random` draws (rounded to 1e-6 and *used* rounded, so `rollsReplay` reproduces the fight exactly), `recSend` in
  `play()` → `/api/replay`. Club duels are recorded by the server in `clubFinish` (seeds). Stored as `FILES` json
  `replay:<id>` + index blob `replays` (600; 80 in the blob without FILES). Names come from the server, never the client.
- **Bark Arena TV `/tv`** (`tvBoot`, `tvLoop`, `tvPlay`, `tvBoard`; `tvMode`, `TV.theme` overrides `stageTheme`; `play()`
  returns early in tvMode): replays back to back with overlay, ladder card every 4 fights, exhibitions when empty.
  800×450 CSS px. `tools/stream/setup.sh` = optional 24/7 YouTube stream from a VPS (Xvfb + PulseAudio + ffmpeg RTMP);
  not in use — the owner chose Shorts.
- **Shorts clips `/clip`** (`clipBoot`, `clipDry`, `clipDrama`, `clipHook`, `CLIP`): one fight in portrait 450×800 CSS px
  (recorded at 720×1280, encoded 1080×1920), hook line on top (from the fight: upset, comeback, Legendary, Club, final,
  big hit, KO), end card "Mint your fighter · scrappyxrp.fun/barkarena · link in bio". `?id=<replay>` or exhibitions
  (best of 40 drawn ghost fights by `clipDrama`, +4 for an underdog win; 75 % star vs small dog). `WAIT_K = .8` speeds it up.
  Apps' UI zones (top 8 %, bottom 20 %, top-right icons → hook padded right) kept free. **`&v=tt` = TikTok/Reels cut**:
  only the last 4 rounds (earlier ones resolved off screen), `WAIT_K = .7`, no crypto words or wallet tags on screen,
  end card "Follow for daily fights · Play free · link in bio"; YouTube cut keeps the NFT/XRPL end card.
- **Shorts factory** (`public/kit/factory.mjs`): runs daily at 05:10 UTC on **GitHub Actions**
  (`.github/workflows/shorts.yml`, secret `ADMIN_KEY`, state of used fights in an actions cache; schedules only run from
  the default branch). VPS alternative: installer `public/kit/shorts.sh` (served at `/kit/*`, systemd timer). It picks the best replays of the last 36 h (else
  exhibitions), records via CDP screencast + WebAudio tap (headless, no X/Pulse), quiet chiptune bed (`MUSIC=0` off),
  ffmpeg loudnorm −14 LUFS, uploads mp4/jpg/json to `/api/admin/clips/upload`. **Two cuts per fight**: `<tag>.mp4`
  (YouTube, chiptune) and `<tag>-tt.mp4` (TikTok/Reels, no music so the owner adds a trending sound). Selection favours
  underdog wins (+6), close fights, one Legendary vs a smaller dog; Club and Legendary-vs-Legendary rank lower (week-1
  YouTube data: underdog clips ~1.2k views, L-vs-L/Club 270–390). Captions: YouTube title/text with the NFT/XRPL pitch
  (`?src=yt`), TikTok + Instagram texts **without crypto words** (TikTok throttles finance/crypto), comment per platform.
  Owner's wish: **real players' fights** — today's best, else unused real fights of the last 7 days, exhibitions last.
  Texts are written from the fight (`story()`: upset / comeback / final / club / big bite / KO / Legendary / fight / draw →
  "<winner> took down <loser>", HP, round, rarity, bond) with matching hashtags (`STORY_TAGS`, Legendary name as a tag)
  and a question for the pinned comment about that very fight. The owner posts by hand.
- **Funnel**: website `barkarena/index.html` reads `?src=`, shows a welcome banner, a "Get your fighter" section with
  the xrp.cafe mint embed (public mint is live), pings `/api/public/hit` (sendBeacon, text/plain = no preflight),
  appends `src` to game links; the game stores the first `?src=` (`ba_src`) and posts it once per wallet (`/api/src`).
  `?demo=1` opens the game in demo mode. `/admin` → "📈 Reach".
- **Recaps**: daily recap when tickets are 0 and all 3 tournaments used; weekly results on the first visit of a new
  week (only for players active in the week that just ended).

### Version history (what was fixed and why)
v1 kennel showed 0 NFTs → ipfs.io returned **429** from Hostinger's shared IP → gateway fallback, disk cache,
browser fallback, parallel gateway race (v2–v3) · v4–v5 rivals from the whole collection, never players' dogs ·
v6/v11 arena limit (now 3 tournaments/day) · v7 packs made real on the server (were seeded fake numbers) ·
v8 daily recap · v9 weekly results · v11 streak inflation fixed (casual wins + per-dog arena counting) ·
v12 playtest fixes ("Fight again" re-used the same rival; demo dogs leaked in; recap for newcomers) ·
v13 exploit fix (always-bite won 77%) → pattern-reading AI + guard snap-back; recap counted abandoned tournaments ·
v14 one-pack-a-week rule, losses tracked, full pack stats table · v15 `ACCESS_KEY` gate · v16 `/api/public/board` · v17 wallet chooser + Joey extension sign-in · v18 Joey app over WalletConnect (confirmed working live by the owner) ·
v19 cloud saves + `/admin` · v20 real arena rivals + player names · v21 arena defence XP · v22 "buy this rival" link ·
v23 server fight engine + Fight Club beta · v24 week close: results hash on the XRPL + treasury prizes · v25 lending · v26 no tickets into a new week · v27 animated backdrops + fight effects · v28 bites, signature-move effects, Mythic/Legendary entrances · v29 sounds for all of it ·
v30 (after week-2 data: players won 76 %, top players 95 %) learning opponent AI scaled by bond, team wallets out of prizes/packs,
in-game chat, open Club challenges, borrow requests, kennel bond ranking, name nudge, prizes pre-picked by rarity ·
v31 fight replays, Bark Arena TV page, Shorts clips + daily factory on a VPS, website funnel (welcome, mint section, source tracking).

### Testing locally
Offline harness with mocked XRPL/IPFS/Xaman + Playwright lives in **`tools/test/`** (see `HANDOFF.md` for usage). ```bash
ISSUER=rI PORT=3000 DATA_DIR=/tmp/ba node server.js      # starts; XRPL/IPFS calls need internet
node --check server.js && node --check worker.js
```
For offline tests, wrap the server in a script that replaces `globalThis.fetch` (fake `account_nfts` from
xrplcluster/ripple.com and fake IPFS JSON/PNG), forge a session token with the `session.secret` from `DATA_DIR`
(HMAC-SHA256, see `mintSession`), put `{token, account}` into `localStorage.ba_session`, and drive it with Playwright.
Always syntax-check the inline game script after editing `public/index.html`.

### Known limitations / open decisions
- Stats, XP and streaks are computed in the browser and trusted by the server (clamped only) — a determined user can fake them.
- The AI memory lives in the player's save: clearing it (Reset progress / new device without cloud save) resets what the opponent learned.
- Chat is polling, not push (4 s); no private messages; moderation = admin delete/mute only.
- Replays are uploaded by the client: dice could be faked to make a fake fight appear on TV/Shorts (only cosmetic).
- YouTube/TikTok uploads are manual: automatic posting needs Google's API audit / TikTok app review (owner decided: post by hand).
- First day gives 5 starting tickets + the daily grant (max 15). The grant is set before the wallet is read; `SAVE.registerDogs` (after the kennel loads) tops up the difference once per day (`d.grantDay`). v31.1 fixed new holders getting only 5.
- Fight Club duels live in server memory (`DUELS`): a server restart drops open/running duels (records are kept).
  The D1/Cloudflare path has no shared memory across isolates, so the Club is Node-only for now.

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
- **`website/links/`** — link page (linktree alternative) at `https://scrappyxrp.fun/links/`: website, Bark Arena, both
  xrp.cafe collections (`scrappy`, `pixel-scrappy`), $SCRAP (issuer `rGHtYnnigyuaHehWGfAdoEhkoirkGNdZzo`, currency hex
  `7363726170…` = "scrap") on FirstLedger + DexScreener + the SCRAP/XRP AMM pool, Discord, YouTube `@Scrappyxrp`,
  TikTok `@scrappy_xrp`, X `@scrappyxrp`. Logo = the original (real) Scrappy, `links/scrappy.jpg`. `?src=` is passed on to the Bark Arena link.
- The `/whitelist/` folder on Hostinger should be deleted (no longer used).

### Open questions for the owner
- Current floor price of Pixel Scrappy (card shows "see xrp.cafe").
- Is the public mint over? Then replace the "Mint" section on `/pixelscrappy/` with "Trade on xrp.cafe".
- The game went public (Bark Arena linked everywhere). `ACCESS_KEY` must be removed on Hostinger; the gate code stays
  for a future closed test.
