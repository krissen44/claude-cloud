// Settings page: trading values can be changed from the status page and apply at once.
// Changes are stored as overrides in DATA_DIR/settings.json and win over .env. Leaving a field
// empty removes the override (back to the .env value or the built-in default).
// Wallet key, login, port, data folder and XRPL servers are deliberately NOT editable here.

import fs from 'node:fs';
import path from 'node:path';

// [key, label, type, default, help, min, max]   type: num | bool | text | part | cur | wallets
export const GROUPS = [
  ['💰 Geld', [
    ['PAUSE_BUYS', 'Käufe pausieren', 'bool', '0', 'Kauft nichts Neues, verkauft aber weiter nach den Regeln'],
    ['BUY_XRP', 'Einsatz pro Launch (XRP)', 'num', '1', '', 0.1, 1000],
    ['MIN_BALANCE_XRP', 'Mindestguthaben, nie ausgeben (XRP)', 'num', '10', '', 0, 1e6],
    ['MAX_OPEN', 'Max. offene Trades', 'num', '25', 'Moonbags zählen nicht', 1, 500],
    ['MAX_BUYS_PER_DAY', 'Max. Käufe pro Tag', 'num', '40', '', 0, 1000],
  ]],
  ['🆕 Welche Launches', [
    ['MIN_POOL_XRP', 'Mindest-Liquidität (XRP im Pool)', 'num', '100', '', 0, 1e7],
    ['POOL_WAIT_MIN', 'Kleinere Launches beobachten (Min.)', 'num', '10', '0 = sofort verwerfen', 0, 1440],
    ['MAX_POOL_XRP', 'Max. Liquidität (XRP)', 'num', '0', '0 = keine Grenze', 0, 1e9],
    ['REQUIRE_BLACKHOLE', 'Nur blackholed Issuer', 'bool', '1', 'Issuer kann nichts nachdrucken'],
    ['BLACKHOLE_WAIT_S', 'Auf Blackhole warten (Sek.)', 'num', '120', '', 0, 3600],
    ['MIN_POOL_SUPPLY_PCT', 'Mind. Anteil aller Tokens im Pool (%)', 'num', '20', '', 0, 100],
    ['MAX_TRANSFER_FEE', 'Max. Transfer-Gebühr (%)', 'num', '0', '', 0, 100],
    ['MAX_AMM_FEE', 'Max. AMM-Gebühr (%)', 'num', '1', '', 0, 1],
    ['BUY_SLIPPAGE', 'Max. Slippage beim Kauf (%)', 'num', '25', '', 1, 90],
  ]],
  ['🌙 Verkauf – Launch-Käufe', [
    ['TAKE_PROFIT', 'Erster Verkauf ab Gewinn (%)', 'num', '100', '', 1, 100000],
    ['TAKE_PROFIT_PART', 'Wie viel dann verkaufen', 'part', 'auto', '„auto“ = genau den Einsatz zurück, Rest = Moonbag; oder Prozent'],
    ['RECOVER_BUFFER', 'Puffer auf den Einsatz (%)', 'num', '5', 'für Gebühren', 0, 100],
    ['TRAILING_STOP', 'Moonbag: verkaufen x % unter Hoch', 'num', '0', '0 = nie verkaufen', 0, 99],
    ['DEAD_POOL_DROP', 'Toten Moonbag räumen ab Pool-Verlust (%)', 'num', '90', '0 = nie', 0, 100],
    ['STOP_LOSS', 'Stop-Loss vor Einsatz zurück (%)', 'num', '50', '0 = aus', 0, 99],
    ['RUG_POOL_DROP', 'Rug-Alarm: Pool-XRP weg (%)', 'num', '40', '0 = aus', 0, 99],
    ['MAX_HOLD_H', 'Max. Haltezeit vor Einsatz zurück (Std.)', 'num', '24', '0 = aus', 0, 10000],
    ['SELL_SLIPPAGE', 'Max. Slippage beim Verkauf (%)', 'num', '30', '', 1, 90],
  ]],
  ['👀 Wallet-Tracking', [
    ['TRACK_WALLETS', 'Getrackte Wallets', 'wallets', '', 'Eine pro Zeile: rAdresse:Name'],
    ['COPY_BUY_XRP', 'Einsatz pro Copy-Kauf (XRP)', 'num', '1', '', 0.1, 1000],
    ['COPY_MIN_XRP', 'Nur wenn die Wallet mind. so viel kauft (XRP)', 'num', '5', '', 0, 1e6],
    ['COPY_MIN_POOL_XRP', 'Mindest-Liquidität für Copy (XRP)', 'num', '100', '', 0, 1e7],
    ['COPY_TAKE_PROFIT', 'Copy: Verkauf ab Gewinn (%)', 'num', '100', '', 1, 100000],
    ['COPY_TAKE_PROFIT_PART', 'Copy: davon verkaufen (%)', 'num', '50', '', 1, 100],
    ['COPY_TRAILING_STOP', 'Copy: Rest x % unter Hoch', 'num', '30', '0 = aus', 0, 99],
    ['COPY_STOP_LOSS', 'Copy: Stop-Loss (%)', 'num', '50', '0 = aus', 0, 99],
    ['COPY_RUG_POOL_DROP', 'Copy: Rug-Alarm (%)', 'num', '40', '0 = aus', 0, 99],
    ['COPY_MAX_HOLD_H', 'Copy: max. Haltezeit (Std.)', 'num', '24', '0 = aus', 0, 10000],
  ]],
  ['🙋 Genehmigung', [
    ['MCAP_APPROVAL', 'Nachfragen ab Market Cap', 'num', '100000', '0 = aus', 0, 1e12],
    ['MCAP_CURRENCY', 'Währung der Market Cap', 'cur', 'USD', ''],
    ['RUNNER_START_XRP', 'Runner: Start-Liquidität ab (XRP)', 'num', '300', '0 = aus', 0, 1e9],
    ['RUNNER_GROWTH', 'Runner: Pool-Wachstum (%)', 'num', '100', '', 1, 100000],
    ['RUNNER_WINDOW_MIN', 'Runner: innerhalb von (Min.)', 'num', '60', '', 1, 10080],
  ]],
  ['🔔 Meldungen', [
    ['DISCORD_WEBHOOK', 'Discord-Webhook', 'text', '', 'leer = keine Meldungen'],
  ]],
];
export const FIELDS = GROUPS.flatMap(([, f]) => f);
const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f[0], f]));

const fileOf = (dir) => path.join(dir, 'settings.json');
export function loadOverrides(dir) {
  try {
    const o = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
    return Object.fromEntries(Object.entries(o).filter(([k, v]) => BY_KEY[k] && typeof v === 'string'));
  } catch { return {}; }
}
export function saveOverrides(dir, o) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fileOf(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 1));
  fs.renameSync(tmp, fileOf(dir));
}

// Value without overrides: .env / process env, else the built-in default.
export const baseValue = (env, k) => (env[k] !== undefined && env[k] !== '' ? String(env[k]) : BY_KEY[k][3]);

const WALLET_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
function clean(f, raw) {
  const [k, label, type, , , min, max] = f;
  const v = String(raw ?? '').trim();
  if (type === 'bool') return { v: /^(1|on|true)$/i.test(v) ? '1' : '0' };
  if (type === 'cur') return /^(usd|xrp)$/i.test(v) ? { v: v.toUpperCase() } : { err: `${label}: USD oder XRP` };
  if (type === 'part') {
    if (/^auto$/i.test(v)) return { v: 'auto' };
    const n = Number(v.replace(',', '.'));
    return n > 0 && n <= 100 ? { v: String(n) } : { err: `${label}: „auto“ oder 1–100` };
  }
  if (type === 'num') {
    const n = Number(v.replace(',', '.'));
    if (v === '' || !isFinite(n) || n < min || n > max) return { err: `${label}: Zahl von ${min} bis ${max}` };
    return { v: String(n) };
  }
  if (type === 'wallets') {
    const parts = v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      const [addr, name = ''] = p.split(':').map((x) => x.trim());
      if (!WALLET_RE.test(addr)) return { err: `Getrackte Wallets: „${addr.slice(0, 40)}“ ist keine XRPL-Adresse` };
      if (/[^\w .-]/.test(name)) return { err: `Getrackte Wallets: Name „${name.slice(0, 20)}“ – nur Buchstaben, Zahlen, Leerzeichen, . _ -` };
    }
    return { v: parts.map((p) => p.split(':').map((x) => x.trim()).filter(Boolean).join(':')).join(',') };
  }
  if (k === 'DISCORD_WEBHOOK' && v && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(v)) return { err: 'Discord-Webhook: muss mit https://discord.com/api/webhooks/ beginnen' };
  return { v };
}

// Form → new overrides. Only values that differ from the base are stored.
export function fromForm(form, env, current) {
  const next = { ...current };
  const errors = [];
  const changes = [];
  for (const f of FIELDS) {
    const k = f[0];
    const raw = f[2] === 'bool' ? (form.get(k) ? '1' : '0') : form.get(k);
    if (raw === null) continue;
    // an empty number/choice field = back to the standard value
    const r = String(raw).trim() === '' && !['wallets', 'text', 'bool'].includes(f[2]) ? { v: baseValue(env, k) } : clean(f, raw);
    if (r.err) { errors.push(r.err); continue; }
    const before = current[k] ?? baseValue(env, k);
    const base = baseValue(env, k);
    if (r.v === base) delete next[k];
    else next[k] = r.v;
    if (r.v !== before) changes.push(`${f[1]}: ${short(before)} → ${short(r.v)}`);
  }
  return { next, errors, changes };
}
const short = (v) => (v === '' ? '–' : v.length > 40 ? v.slice(0, 37) + '…' : v);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export function settingsPage(env, overrides, msg = '', errors = []) {
  const val = (k) => overrides[k] ?? baseValue(env, k);
  const input = (f) => {
    const [k, label, type, def, help] = f;
    const v = val(k);
    const mark = overrides[k] !== undefined ? ' <small class="ch">geändert</small>' : '';
    let el;
    if (type === 'bool') el = `<label class="sw"><input type="checkbox" name="${k}" value="1"${v === '1' ? ' checked' : ''}> an</label>`;
    else if (type === 'cur') el = `<select name="${k}">${['USD', 'XRP'].map((c) => `<option${c === v ? ' selected' : ''}>${c}</option>`).join('')}</select>`;
    else if (type === 'wallets') el = `<textarea name="${k}" rows="4" placeholder="rAbc…:Name">${esc(v.split(',').filter(Boolean).join('\n'))}</textarea>`;
    else el = `<input name="${k}" value="${esc(v)}" ${type === 'num' ? 'inputmode="decimal"' : ''} autocomplete="off">`;
    return `<div class="f"><div class="l">${esc(label)}${mark}${help ? `<small>${esc(help)}</small>` : ''}<small class="d">Standard: ${esc(def === '' ? '–' : def)}</small></div><div class="i">${el}</div></div>`;
  };
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Einstellungen</title>
<style>body{font:14px system-ui;margin:16px;background:#0e1726;color:#e6edf6;max-width:760px}a{color:#6cb8ff}h3{margin:22px 0 6px}.f{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid #243247}.l{flex:1}.l small{display:block;color:#8aa0bb;font-size:12px}.l small.d{color:#5f7590}.ch{display:inline!important;color:#f5b942!important;margin-left:6px}.i{width:min(220px,45vw)}input,select,textarea{font:inherit;width:100%;box-sizing:border-box;padding:7px;border-radius:7px;border:1px solid #3a4d66;background:#152033;color:#e6edf6}.sw input{width:auto;margin-right:6px}button{font:inherit;padding:9px 16px;border-radius:8px;border:1px solid #2c9a5e;background:#1f6e43;color:#e6edf6;cursor:pointer}.bar{position:sticky;bottom:0;background:#0e1726;padding:12px 0;border-top:1px solid #243247;margin-top:16px}.ok{background:#173d2a;border:1px solid #2c9a5e;padding:8px 12px;border-radius:8px}.err{background:#4a1f1f;border:1px solid #9a3c3c;padding:8px 12px;border-radius:8px}@media(max-width:520px){.f{flex-direction:column}.i{width:100%}}</style>
<p><a href="/">← zurück zur Übersicht</a></p><h2>⚙️ Einstellungen</h2>
<p><small>Änderungen gelten sofort, ohne Neustart. Ein leeres Feld setzt den Wert auf den Standard zurück. Wallet-Schlüssel und Passwort lassen sich hier nicht ändern.</small></p>
${msg ? `<div class="ok">${msg}</div>` : ''}${errors.length ? `<div class="err">${errors.map(esc).join('<br>')}</div>` : ''}
<form method="post" action="/settings">${GROUPS.map(([g, fs]) => `<h3>${g}</h3>${fs.map(input).join('')}`).join('')}
<div class="bar"><button>💾 Speichern</button></div></form>`;
}
