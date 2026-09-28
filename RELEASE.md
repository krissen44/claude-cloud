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

### Planned for Season 1 (owner's decisions, 2026-09-28)
- **Server fight engine + Fight Club beta**: duels by invite link or player name, simultaneous moves via HTTP polling,
  20 s per round, timeout = auto-guard, two misses = forfeit, own Fight Club record, no ranked XP yet.
  Season 2: matchmaking queue, Elo, own ladder.
- **Verifiable ladder**: weekly hash of the final results as a memo on the ledger — signed via **Xaman QR in /admin**
  (no key on the server).
- **Treasury prizes**: the 50 floor-sweep NFTs sit in the **issuer wallet**; each week **top 3 of the XP ladder + the most
  active member of the winning pack** get one, via NFTokenCreateOffer (sell, Amount 0, Destination = winner), signed by
  Xaman QR in /admin.
- **Lending**: holders lend a dog to non-holders (database delegation, NFT never moves); the dog keeps its bond XP, the
  holder gets **25 % of the borrower's trainer XP** with that dog and a **share of prizes** the borrower wins.

### Website (scrappyxrp.fun)
- `barkarena/index.html`: guide/FAQ for real arena rivals, player names and defence XP.

## Upload checklist (Monday)
1. Hostinger game app → environment variables: `ADMIN_KEY` is already set (live since v19); make sure **`ACCESS_KEY` is removed**.
2. Upload the game ZIP (`package.json`, `package-lock.json`, `server.js`, `worker.js`, `public/`, `node_modules/`) and restart the app.
3. Upload `barkarena/index.html` to `public_html/barkarena/`.
4. Check: open the game in a private window, sign in, set a name (✏️), open the arena tab (squad registered, rivals
   "from <name>"), and look at `/admin` (new Name column).
