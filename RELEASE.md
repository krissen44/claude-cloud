# Next release — upload at the week roll (Monday 00:00 UTC)

Changes collect here during the week and go live together when the new week starts.
Last version confirmed live: **game v31 + website** (uploaded by the owner on Mon 5 Oct 2026, ~16:00 UTC, together
with v30). The Shorts factory runs on GitHub Actions (first run 5 Oct 16:05 UTC: success; clips posted by the owner).

## Hotfix v31.1 — ready (bug found by the owner on 5 Oct)
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
