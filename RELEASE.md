# Next release — upload at the week roll (Monday 00:00 UTC)

Changes collect here during the week and go live together when the new week starts.
Last version confirmed live: **game v19** (cloud saves + `/admin`) + **website launch package** (Bark Arena public).

## Pending for the next week start

### Game (game.scrappyxrp.fun)
- **v20 — real arena rivals + player names**: arena opponents are other players' Scrappys ("#123 from <name>"),
  invented handles removed; optional unique display name (✏️ in the wallet card) shown in ladder, arena, website.
- **v21 — arena defence XP**: the squad picked for the day is registered; when others meet those dogs in their arena,
  the dogs earn bond XP (18 win / 6 loss, max 120 per dog per day), collected on the owner's next visit.

### Website (scrappyxrp.fun)
- `barkarena/index.html`: guide/FAQ for real arena rivals, player names and defence XP.

## Upload checklist (Monday)
1. Hostinger game app → environment variables: `ADMIN_KEY` is already set (live since v19); make sure **`ACCESS_KEY` is removed**.
2. Upload the game ZIP (`package.json`, `package-lock.json`, `server.js`, `worker.js`, `public/`, `node_modules/`) and restart the app.
3. Upload `barkarena/index.html` to `public_html/barkarena/`.
4. Check: open the game in a private window, sign in, set a name (✏️), open the arena tab (squad registered, rivals
   "from <name>"), and look at `/admin` (new Name column).
