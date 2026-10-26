# XRPL Launch-Sniper

Kauft neue Memecoins auf der XRPL direkt beim Launch und verkauft nach festen Regeln.

## Was er macht

1. **Erkennt jeden Launch.** FirstLedger, Horizon und die anderen Launchpads starten einen Token,
   indem sie einen AMM-Pool XRP/Token anlegen (`AMMCreate`). Der Bot hört live im Ledger mit und
   sieht jeden neuen Pool im selben Ledger (≈ 4 Sekunden).
2. **Nur Pools ab 100 XRP.** Startet ein Launch kleiner, beobachtet ihn der Bot 10 Minuten lang. Wächst
   der Pool in der Zeit über 100 XRP, kauft er. Sonst lässt er ihn liegen.
3. **Prüft auf Rug-Anzeichen.** Gekauft wird nur, wenn alles stimmt:
   - Der Issuer ist **blackholed** (kann keine neuen Tokens mehr erzeugen). Der Bot wartet bis zu 2 Minuten darauf.
   - Kein Clawback (Issuer kann Tokens nicht zurückholen), kein Freeze.
   - Keine Transfer-Gebühr.
   - Mindestens 20 % aller Tokens liegen im Pool (sonst kann der Entwickler mit dem Rest den Kurs zerstören).
4. **Kauft für 1 XRP** (einstellbar). Ist der Preis schon um mehr als 25 % weggelaufen, kauft er nicht.
5. **Wallet-Tracking (optional):** In `TRACK_WALLETS` trägst du Wallets ein, denen du folgen willst.
   Kauft so eine Wallet einen Token für mindestens 5 XRP, kauft der Bot ihn auch: mit denselben
   Sicherheitsprüfungen, einmal pro Token. **Copy-Käufe verkauft er nach eigenen Regeln** (kein Moonbag):
   - bei **+100 %** die Hälfte,
   - den Rest **30 % unter dem Höchststand**,
   - bei **−50 %** alles,
   - fällt das XRP im Pool um **40 %** (Rug): sofort alles,
   - nach **24 Stunden** verkauft er, was übrig ist.
6. **Launch-Käufe verkauft er nach dem Prinzip „Einsatz raus, Rest läuft":**
   - Bei **+100 %** verkauft er **genau so viel, dass der Einsatz zurück ist** (+5 % für Gebühren).
     Je höher der Kurs dann steht, desto weniger muss er verkaufen und desto mehr bleibt liegen.
   - Der Rest ist ein **Moonbag**: Er kostet nichts mehr und wird **nie verkauft**, egal wie der Kurs schwankt.
   - Einzige Ausnahme: Ist der Pool tot (90 % des XRP sind raus), räumt der Bot den Rest weg. Dann ist die
     Trustline-Reserve von 0,2 XRP mehr wert als der Token.
   - **Solange der Einsatz noch nicht zurück ist**, schützt er ihn: bei −50 %, bei Rug-Alarm (40 % des
     Pool-XRP weg) oder nach 24 Stunden verkauft er alles.
7. **Fragt bei großen Tokens nach.** Hat ein Token eine **Market Cap ab 100.000 $**, verkauft der Bot
   nicht selbst. Er fragt dich auf der Statusseite (und in Discord) und wartet:
   - **✅ Verkaufen**: Er führt den Verkauf aus, den die Regel wollte, zum aktuellen Preis.
   - **✋ Behalten (legit)**: Der Token gehört ab jetzt dir. Der Bot verkauft ihn nicht mehr von selbst.
     Auf der Statusseite gibt es dafür die Buttons „Hälfte verkaufen", „Alles verkaufen" und „Wieder automatisch".
   - Auf der Karte stehen Links zum Prüfen: die Website des Issuers (falls hinterlegt), XRPScan,
     FirstLedger und eine X-Suche nach dem Token-Namen. Socials prüfen kann der Bot nicht selbst, das machst du.
   - **Runner:** Startet ein Launch mit **mindestens 300 XRP** im Pool und verdoppelt sich das XRP im Pool
     innerhalb von **60 Minuten**, markiert der Bot ihn als 🚀 Runner. Ab dann fragt er bei **jedem**
     Verkauf nach, egal wie hoch die Market Cap gerade ist. Das gilt nur für Launch-Käufe, nicht für Copy-Käufe
     (bei denen kennt der Bot den Start nicht). Einstellbar mit `RUNNER_START_XRP`, `RUNNER_GROWTH`, `RUNNER_WINDOW_MIN`.
   - **Ein Rug wird nie abgewartet:** Fällt das XRP im Pool um 40 %, verkauft er sofort, auch ohne Genehmigung.
   - Market Cap = alle ausgegebenen Tokens × aktueller Pool-Preis. Den Dollarkurs von XRP liest der Bot
     aus dem XRP/RLUSD-Pool im Ledger. Kann er den Kurs nicht lesen, fragt er sicherheitshalber.
8. **Räumt auf.** Nach einem vollständigen Verkauf löscht er die Trustline. Das gibt die 0,2 XRP Reserve wieder frei.

Jeder Kauf und Verkauf steht im Log, auf der Statusseite (laufende Trades und Moonbags getrennt)
und optional in Discord.

## Ehrlich gesagt

- **50 → 500 XRP in einem Monat ist nicht realistisch planbar.** Die meisten neuen Coins verlieren schnell
  an Wert. Der Bot lebt davon, dass wenige Treffer mit +200 % … +1000 % die vielen kleinen Verluste
  bezahlen. Ob das klappt, hängt vom Markt ab. Setze nur Geld ein, dessen Verlust du verkraftest.
- Bei XRPL-Launches kaufen viele Bots im ersten Ledger. Dieser Bot ist schnell, aber nicht der schnellste.
- Die Filter fangen viele Rugs ab, aber nicht alle (z. B. wenn der Entwickler seine Tokens über viele Wallets verteilt).
- Nach 1–2 Wochen auf der Statusseite nachsehen, was die Gewinne/Verluste zeigen, und dann die Werte anpassen.

## Geld-Rechnung bei 50 XRP

| | XRP |
|---|---|
| Grundreserve der Wallet (gesperrt) | 1 |
| Mindestguthaben, wird nie verkauft (`MIN_BALANCE_XRP`) | 10 |
| Pro offener Position: Einsatz + Trustline-Reserve | 1 + 0,2 |
| → gleichzeitig offene Trades bei 50 XRP | ca. 30, begrenzt auf 25 (`MAX_OPEN`) |
| Jeder Moonbag sperrt 0,2 XRP Reserve | 50 Moonbags = 10 XRP |

Moonbags zählen nicht zu `MAX_OPEN`. Ihre Reserve geht aber vom Guthaben ab. Das Mindestguthaben
sorgt dafür, dass dabei nie mehr ausgegeben wird als erlaubt.

## Einrichten

**Wichtig: eine neue Wallet nur für den Bot.** Niemals die Haupt-Wallet oder die Issuer-Wallet von
Pixel Scrappy verwenden. Der Seed steht im Klartext in `.env` auf dem Rechner, auf dem der Bot läuft.

1. In Xaman (oder Joey) eine **neue Wallet** anlegen und den **Family Seed** (`s…`) notieren.
2. 50 XRP auf diese neue Wallet schicken.
3. Node.js 18 oder neuer installieren (https://nodejs.org).
4. ZIP entpacken, im Ordner `.env.example` nach `.env` kopieren und `WALLET_SEED=` eintragen.
   `STATUS_KEY` auf ein eigenes Passwort ändern.
5. Starten:
   ```
   npm start
   ```
   Im Fenster erscheint `🤖 Sniper running – wallet r…`. Ab jetzt kauft und verkauft er selbst.
6. Statusseite im Browser: `http://localhost:3100/?key=<STATUS_KEY>` (aktualisiert sich alle 20 s).
   Die Buttons zum Genehmigen funktionieren nur mit gesetztem `STATUS_KEY`. Damit du vom Handy genehmigen
   kannst, muss die Seite von außen erreichbar sein (VPS: Port 3100 öffnen, `PUBLIC_URL` eintragen).
   Mit `DISCORD_WEBHOOK` bekommst du jede Anfrage als Nachricht mit Link.

Stoppen: `Strg + C`. Offene Positionen bleiben gespeichert (`~/xrpl-sniper-data/state.json`) und
werden beim nächsten Start weiter überwacht. Während der Bot aus ist, wird **nichts** verkauft.

## Einrichtung auf einem VPS (Ubuntu) in einem Schritt

In der Server-Konsole (z. B. Hostinger „Web console“) eingeben:
```
cd /root && curl -fsSL https://codeload.github.com/krissen44/claude-cloud/tar.gz/refs/heads/claude/awesome-einstein-jnon4n | tar xz --strip-components=2 --wildcards '*/tools/sniper' && cd sniper && bash setup-vps.sh
```
Das Skript installiert Node.js, fragt nach der Adresse der Bot-Wallet und ihrem Schlüssel (12/24 Wörter,
Family Seed oder Xaman-Zahlen, unsichtbare Eingabe; es prüft, dass der Schlüssel zur Adresse passt), erzeugt den Statusseiten-Key,
öffnet die Firewall, testet die Verbindung zum XRPL und startet den Bot dauerhaft mit pm2. Am Ende stehen
die Bot-Adresse und der Link zur Statusseite da.

### HTTPS mit eigener Domain

Die Domain braucht im DNS einen A-Eintrag `@` → IP des Servers. Dann in der Konsole:
```
cd /root && curl -fsSL https://codeload.github.com/krissen44/claude-cloud/tar.gz/refs/heads/claude/awesome-einstein-jnon4n | tar xz --strip-components=2 --wildcards '*/tools/sniper' && cd sniper && bash setup-https.sh deine-domain.tld
```
Installiert Caddy (kostenloses Zertifikat, erneuert sich selbst), leitet `https://deine-domain.tld` auf die
Statusseite, schließt Port 3100 (`BIND=127.0.0.1`) und stellt `PUBLIC_URL` für Discord um.

## Wo laufen lassen?

Es ist ganz normales Node.js, es läuft überall, wo Node läuft. Es muss aber **rund um die Uhr**
laufen, sonst verpasst er Launches und, schlimmer, Verkäufe.

- **Eigener PC:** geht, solange er an bleibt (Energiesparmodus aus).
- **Kleiner VPS** (z. B. Hostinger VPS, Hetzner, ~5 €/Monat), am stabilsten. Dort mit `pm2` dauerhaft starten:
  ```
  npm install -g pm2
  pm2 start index.js --name sniper
  pm2 save && pm2 startup
  pm2 logs sniper
  ```
- **Hostinger Node.js-App** (wie das Spiel): nur bedingt. Solche Apps werden oft schlafen gelegt,
  wenn keiner die Seite aufruft. Dann verpasst der Bot Launches und Verkäufe. Nicht empfohlen.

## Einstellungen (`.env`)

Alle Werte stehen mit Erklärung in `.env.example`. Die wichtigsten:

| Wert | Standard | Bedeutung |
|---|---|---|
| `BUY_XRP` | 1 | XRP pro Launch |
| `MIN_BALANCE_XRP` | 10 | so viel bleibt immer übrig |
| `MIN_POOL_XRP` / `POOL_WAIT_MIN` | 100 / 10 | nur Pools ab 100 XRP, kleinere 10 Min. beobachten |
| `TAKE_PROFIT` / `TAKE_PROFIT_PART` | 100 / auto | bei +100 % den Einsatz zurückholen, Rest läuft |
| `TRAILING_STOP` | 0 | Moonbag nie verkaufen (z. B. `50` = Rest bei −50 % vom Hoch verkaufen) |
| `STOP_LOSS` | 50 | bei −50 % alles verkaufen, solange der Einsatz noch nicht zurück ist (`0` = aus) |
| `MCAP_APPROVAL` | 100000 | ab dieser Market Cap (USD) nur mit deinem OK verkaufen (`0` = aus) |
| `RUNNER_START_XRP` / `RUNNER_GROWTH` / `RUNNER_WINDOW_MIN` | 300 / 100 / 60 | Start ab 300 XRP + Pool-XRP verdoppelt in 60 Min. → jeder Verkauf nur mit OK |
| `TRACK_WALLETS` | leer | `rAdresse:Name,rAdresse2:Name2` – deren Käufe werden mitgemacht |
| `COPY_BUY_XRP` / `COPY_MIN_XRP` | 1 / 5 | Einsatz pro Copy-Kauf / erst ab so großen Käufen der Wallet |
| `COPY_TAKE_PROFIT` / `_PART` / `COPY_TRAILING_STOP` / `COPY_STOP_LOSS` / `COPY_RUG_POOL_DROP` / `COPY_MAX_HOLD_H` | 100 / 50 / 30 / 50 / 40 / 24 | Verkaufsregeln nur für Copy-Käufe |
| `REQUIRE_BLACKHOLE` | 1 | nur Tokens, deren Issuer nichts mehr nachdrucken kann |
| `DRY_RUN` | 0 | `1` = nur so tun, ohne echte Käufe |

## Test

`npm test` spielt im simulierten Ledger 16 Szenarien durch (Genehmigung ab Market Cap / Runner / Behalten / Rug trotzdem, Einsatz raus + Moonbag, kleiner Pool wächst,
Copy-Trade mit Hälfte/Trailing-Stop/Haltezeit, Rug, Clawback, Blackhole spät/nie, Stop-Loss, gelöschter Pool, Guthabengrenze, weggelaufener Preis). `node test/txcheck.mjs` prüft,
dass alle Transaktionen gültig sind und signiert werden können.
