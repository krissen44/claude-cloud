# Next release — upload at the week roll (Monday 00:00 UTC)

Changes collect here during the week and go live together when the new week starts.
Last version confirmed live: **game v19** (cloud saves + `/admin`) + **website launch package** (Bark Arena public).

## Pending for the next week start

### Game (game.scrappyxrp.fun)
- **v20 — real arena rivals + player names**: arena opponents are other players' Scrappys ("#123 from <name>"),
  invented handles removed; optional unique display name (✏️ in the wallet card) shown in ladder, arena, website.
- **v21 — arena defence XP**: the squad picked for the day is registered; when others meet those dogs in their arena,
  the dogs earn bond XP (18 win / 6 loss, max 120 per dog per day), collected on the owner's next visit.

- **v22 — "buy this rival"**: after every fight against a real collection dog, a link to that exact NFT on xrp.cafe
  (`/api/public/nft?t=`, from a daily collection index built with Clio `nfts_by_issuer`: token → NFTokenID + owner).
  ⚠️ Check once live that `https://xrp.cafe/nft/<NFTokenID>` opens the piece (URL pattern not verifiable from here).

- **v23 — Fight Club beta (Season 1)**: the Club tab is open. Challenge a player by name or send an invite link
  (`/?duel=…`); both choose at once, 20 s per round, out of time = guard, two misses or leaving = forfeit; own Club record,
  no tickets, no XP. The server is the referee: it runs the game's own engine (`fight-engine.js` loads the
  `//@engine` sections of `public/index.html`) and both screens replay its rounds. New file: **`fight-engine.js`**.
  Tested with two/three browsers: same fight on both screens, records, invite link, give up, two-miss forfeit.

- **v24 — week close: verifiable results + weekly prizes**: 15 min after the week roll the finished week is frozen
  (final standings + prize winners + SHA-256). In `/admin` → "Week close": **⚓ Anchor** (Xaman QR, AccountSet with the
  hash as memo, issuer wallet, no XRP moves) and per winner **🎁 Send** (Xaman QR, free sell offer of a treasury Scrappy,
  only the winner can accept). Winners get a card in their kennel with "Accept" (Xaman) — or accept in any wallet.
  The website shows the prizes, the transaction and the hash under "Last week — final".
  Also fixed: the public board could answer 500 for a second after a name change (cache entry parse).
  Tested with a mocked ledger + Xaman: freeze, hash check, anchor once only, offer, accept, wrong-player blocked.

- **v25 — lending**: holders lend a Scrappy (by player name, 1–14 days, up to 3 at once) to a player without one. The
  NFT never moves. The borrower fights ranked + arena with it; its bond XP goes to the dog, the owner gets 25 % of the
  borrower's trainer XP (max 150 a day), collected on the next visit. If a borrower wins a weekly prize mostly with a
  borrowed dog, week close shows an extra "🤝 Lender share" line for the lender (you decide whether to send it).
  Tested: holder can't borrow, one dog one loan, XP arrives at the owner, give back, prize-share line.
- **v26 — no tickets into a new week**: unused ranked fights still bank into the next day (max 15), but not across
  the week roll — Monday starts with just the daily grant. Keeps the weekly ladder fair (no hoarding on Sunday).
  Website guide updated ("Banked: up to 15, into the next day — not into a new week").
- **v27 — fight animations**: three living backdrops — the **meadow** for ranked fights (turning sun, birds,
  butterflies, swaying grass, drifting petals), a **stadium at dusk** for arena tournaments (floodlights, waving pennants,
  a bobbing crowd that jumps on big hits, camera flashes) and a **night ring** for the Fight Club (sweeping spotlights,
  neon sign, ropes, haze). The light shifts as the rounds go on; frenzy rounds glow red. New moves on screen: bites
  wind up and snap jaws shut on impact with an impact star and shockwave, guards raise a shield bubble, taunts bark
  ("WOOF!") with sound waves, misses are dodged, abilities charge up with a glow, heals and energy rise as sparkles,
  big hits flash and shake the stage, a knocked-out dog sees stars while the winner celebrates. Visual only — rules,
  engine and the server's Fight Club referee are unchanged. Respects "reduce motion" on the device.
- **v28 — bites, signature moves, Mythic/Legendary entrances**: the biting dog now leaps all the way to its rival,
  stays in its face while the round plays and springs back once the bite lands: cartoon jaws snap shut, a bite imprint
  and "CHOMP!/SNAP!/CRUNCH!!" pop up (misses: "WHIFF!"). Every ability has its own effect — laser eyes in their colour,
  lightning from the sky (Lightning), a pillar of light (Genesis), a stampede across the field (Bull Run), a moon on
  a high arc (To The Moon), a crashing chart (Buy the Dip), a red crash arrow (Bear Market), a tidal wave (The Whale),
  rainbow beams (Spectrum), a twin that jumps along (Double Team), food popping up for heals (cake, banana, bowl …),
  green code rain (Matrix), rune circles (Open Brain), a black hole (Event Horizon), a gold alchemy circle
  (Transmute), shields with emblems (Validate ✓, Oath ✚, Gilded), a diamond crystal (Diamond Hand). **Mythic and
  Legendary** dogs drop in from the sky with a light pillar, a "★ LEGENDARY ★" / "✦ MYTHIC ✦" banner and a fanfare,
  and keep an aura for the whole fight (gold rays and sparkles / a violet ring) — in every fight, arena included.
  Visual only; Fight Club still replays identically on both screens (tested).
- **v29 — sounds for the new effects**: a snapping bite (crunching on big hits), a leap and a landing, the crowd roaring
  on big hits and wins (arena and Fight Club), a KO slide-whistle with dizzy tweets, and a sound per signature move
  (thunder, light choir, stampede, rocket + boom, falling chart, crash, wave, prism sparkle, twin whoosh, munching food,
  matrix blips, eerie runes, black-hole hum, alchemy bells, shield chime, crystal ping). All synthesized in the browser,
  no sound files; the 🔊 button still mutes everything.

### Planned (Season 2)
- Fight Club: matchmaking queue, Elo, own ladder.

### Website (scrappyxrp.fun)
- `barkarena/index.html`: guide/FAQ for real arena rivals, player names, defence XP, the Fight Club beta, prizes and
  the ledger proof (prizes + tx + hash under "Last week — final").

## Upload checklist (Monday)
1. Hostinger game app → environment variables: `ADMIN_KEY` is already set (live since v19); make sure **`ACCESS_KEY` is removed**.
2. Upload the game ZIP (`package.json`, `package-lock.json`, `server.js`, `worker.js`, **`fight-engine.js`**, `public/`, `node_modules/`) and restart the app.
3. Upload `barkarena/index.html` to `public_html/barkarena/`.
4. Check: open the game in a private window, sign in, set a name (✏️), open the arena tab (squad registered, rivals
   "from <name>"), and look at `/admin` (new Name column). Fight Club: create an invite link, open it in a second
   browser with another wallet, fight a few rounds.
5. Week close right after the upload (from 00:15 UTC the week that just ended can be closed): open `/admin` → "Week close". The treasury line should
   list the issuer's Pixel Scrappys. Anchor the week (scan with Xaman **logged into the issuer wallet**), then send each
   prize. ⚠️ The issuer wallet needs 2 XRP owner reserve free per open offer until the winner accepts.
6. Lending check: lend a dog from a holder wallet to a test wallet without Scrappys (it needs a player name).
