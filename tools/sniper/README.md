# XRPL Launch-Sniper

Kauft neue Memecoins auf der XRPL direkt beim Launch und verkauft nach festen Regeln.

## Was er macht

1. **Erkennt jeden Launch.** FirstLedger, Horizon und die anderen Launchpads starten einen Token,
   indem sie einen AMM-Pool XRP/Token anlegen (`AMMCreate`). Der Bot hört live im Ledger mit und
   sieht jeden neuen Pool im selben Ledger (≈ 4 Sekunden).
2. **Prüft auf Rug-Anzeichen.** Gekauft wird nur, wenn alles stimmt:
   - Der Issuer ist **blackholed** (kann keine neuen Tokens mehr erzeugen). Der Bot wartet bis zu 2 Minuten darauf.
   - Kein Clawback (Issuer kann Tokens nicht zurückholen), kein Freeze.
   - Keine Transfer-Gebühr.
   - Mindestens 20 XRP im Pool.
   - Mindestens 20 % aller Tokens liegen im Pool (sonst kann der Entwickler mit dem Rest den Kurs zerstören).
3. **Kauft für 1 XRP** (einstellbar). Ist der Preis schon um mehr als 25 % weggelaufen, kauft er nicht.
4. **Verkauft automatisch:**
   - Bei **+100 %** verkauft er die Hälfte. Damit ist der Einsatz meistens schon zurück.
   - Den Rest hält er, solange der Kurs steigt, und verkauft ihn, sobald der Wert **30 % unter dem Höchststand** liegt.
   - Bei **−50 %** (vor dem ersten Gewinn) verkauft er alles.
   - **Rug-Alarm:** Fällt das XRP im Pool um 40 % unter den Stand beim Kauf, verkauft er sofort alles.
   - Nach **24 Stunden** verkauft er, was noch übrig ist.
5. **Räumt auf.** Nach dem Verkauf löscht er die Trustline. Das gibt die 0,2 XRP Reserve wieder frei.

Jeder Kauf und Verkauf steht im Log, optional auf der Statusseite und in Discord.

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
| → gleichzeitig offene Positionen bei 50 XRP | ca. 30, begrenzt auf 25 (`MAX_OPEN`) |

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
| `TAKE_PROFIT` / `TAKE_PROFIT_PART` | 100 / 50 | bei +100 % die Hälfte verkaufen |
| `TRAILING_STOP` | 30 | Rest verkaufen 30 % unter dem Höchststand |
| `STOP_LOSS` | 50 | bei −50 % alles verkaufen |
| `REQUIRE_BLACKHOLE` | 1 | nur Tokens, deren Issuer nichts mehr nachdrucken kann |
| `DRY_RUN` | 0 | `1` = nur so tun, ohne echte Käufe |

## Test

`npm test` spielt im simulierten Ledger 9 Szenarien durch (Pump, Rug, Clawback, Blackhole spät/nie,
Stop-Loss, gelöschter Pool, Guthabengrenze, weggelaufener Preis). `node test/txcheck.mjs` prüft,
dass alle Transaktionen gültig sind und signiert werden können.
