# Next release — upload at the week roll (Monday 00:00 UTC)

Changes collect here during the week and go live together when the new week starts.
Last version confirmed live: **game v29** + website guide (uploaded Fri 2 Oct 2026; first week close with anchor + 4 prize
offers done Mon 5 Oct for the week of 28 Sep).

## Pending for the next week start — Mon 12 Oct 2026

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
  - Tested offline: 36 checks (team prizes/packs/boards, chat filters/rate limit/mute/delete, open challenge, borrow list,
    kennel order, nudge, no page errors) + the Fight Club, week-close and lending regression tests.

### Website (scrappyxrp.fun)
- `barkarena/index.html`: TEAM tag on the board, guide text for the learning opponent, open challenges, chat FAQ,
  borrow list, team wallets.

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
4. From 00:15 UTC: week close in `/admin` as last week (⚓ Anchor, then 🎁 Send per winner, issuer wallet in Xaman).
   The issuer is no longer a prize winner even if it ranks.
