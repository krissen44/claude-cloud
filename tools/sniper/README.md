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
   Sicherheitsprüfungen, einmal pro Token.
6. **Verkauft nach dem Prinzip „Einsatz raus, Rest läuft":**
   - Bei **+100 %** verkauft er **genau so viel, dass der Einsatz zurück ist** (+5 % für Gebühren).
     Je höher der Kurs dann steht, desto weniger muss er verkaufen und desto mehr bleibt liegen.
   - Der Rest ist ein **Moonbag**: Er kostet nichts mehr und wird **nie verkauft**, egal wie der Kurs schwankt.
   - Einzige Ausnahme: Ist der Pool tot (90 % des XRP sind raus), räumt der Bot den Rest weg. Dann ist die
     Trustline-Reserve von 0,2 XRP mehr wert als der Token.
   - **Solange der Einsatz noch nicht zurück ist**, schützt er ihn: bei −50 %, bei Rug-Alarm (40 % des
     Pool-XRP weg) oder nach 24 Stunden verkauft er alles.
7. **Räumt auf.** Nach einem vollständigen Verkauf löscht er die Trustline. Das gibt die 0,2 XRP Reserve wieder frei.

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
6. Statusseite im Browser: `http://localhost:3100/?key=<STATUS_KEY>` (aktualisiert sich alle 15 s).

Stoppen: `Strg + C`. Offene Positionen bleiben gespeichert (`~/xrpl-sniper-data/state.json`) und
werden beim nächsten Start weiter überwacht. Während der Bot aus ist, wird **nichts** verkauft.

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
| `TRACK_WALLETS` | leer | `rAdresse:Name,rAdresse2:Name2` – deren Käufe werden mitgemacht |
| `COPY_BUY_XRP` / `COPY_MIN_XRP` | 1 / 5 | Einsatz pro Copy-Kauf / erst ab so großen Käufen der Wallet |
| `REQUIRE_BLACKHOLE` | 1 | nur Tokens, deren Issuer nichts mehr nachdrucken kann |
| `DRY_RUN` | 0 | `1` = nur so tun, ohne echte Käufe |

## Test

`npm test` spielt im simulierten Ledger 11 Szenarien durch (Einsatz raus + Moonbag, kleiner Pool wächst,
Copy-Trade, Rug, Clawback, Blackhole spät/nie, Stop-Loss, gelöschter Pool, Guthabengrenze, weggelaufener Preis). `node test/txcheck.mjs` prüft,
dass alle Transaktionen gültig sind und signiert werden können.
