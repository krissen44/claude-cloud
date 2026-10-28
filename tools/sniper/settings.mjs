// Settings page: trading values can be changed from the status page and apply at once.
// Changes are stored as overrides in DATA_DIR/settings.json and win over .env. Leaving a field
// empty removes the override (back to the .env value or the built-in default).
// Wallet key, login, port, data folder and XRPL servers are deliberately NOT editable here.

import fs from 'node:fs';
import path from 'node:path';

// [key, label, type, default, help, min, max]   type: num | bool | text | part | cur | wallets
export const GROUPS = [
  ['💰 Money', [
    ['PAUSE_BUYS', 'Pause buying', 'bool', '0', 'No new buys; open positions are still sold by the rules'],
    ['BUY_XRP', 'Stake per launch (XRP)', 'num', '1', '', 0.1, 1000],
    ['BUY_SUPPLY_PCT', 'Or buy this % of the supply', 'num', '0', '0 = off (stake above). e.g. 1 = 1 % of all tokens', 0, 50],
    ['BUY_MAX_XRP', 'Max. XRP for the supply buy', 'num', '10', 'a bigger pool costs more for the same %', 0.1, 100000],
    ['FAST_LAUNCH', 'First buyers: buy from the open ledger', 'bool', '1', 'sees a launch ≈ 4–6 s before it is validated'],
    ['MIN_BALANCE_XRP', 'Balance never spent (XRP)', 'num', '10', '', 0, 1e6],
    ['MAX_OPEN', 'Max. open trades', 'num', '25', 'Moonbags don’t count', 1, 500],
    ['MAX_BUYS_PER_DAY', 'Max. buys per day', 'num', '40', '', 0, 1000],
  ]],
  ['🆕 Which launches', [
    ['MIN_POOL_XRP', 'Min. liquidity (XRP in the pool)', 'num', '100', '', 0, 1e7],
    ['POOL_WAIT_MIN', 'Watch smaller launches for (min)', 'num', '10', '0 = skip at once', 0, 1440],
    ['MAX_POOL_XRP', 'Max. liquidity (XRP)', 'num', '0', '0 = no limit', 0, 1e9],
    ['REQUIRE_BLACKHOLE', 'Blackholed issuers only', 'bool', '1', 'The issuer can’t mint more'],
    ['BLACKHOLE_WAIT_S', 'Wait for the blackhole (s)', 'num', '120', '', 0, 3600],
    ['PROTECT_WAIT_MIN', 'Wait for a launch protection to end (min)', 'num', '60', 'frozen / approval-only / fee at launch – bought the moment it is lifted', 0, 1440],
    ['PROTECT_MAX_X', 'After a protection: skip above x × launch price', 'num', '12', 'early buyers already pumped it; 0 = off', 0, 100000],
    ['MIN_POOL_SUPPLY_PCT', 'Min. share of all tokens in the pool (%)', 'num', '20', '', 0, 100],
    ['MAX_TRANSFER_FEE', 'Max. transfer fee (%)', 'num', '0', '', 0, 100],
    ['MAX_AMM_FEE', 'Max. AMM fee (%)', 'num', '1', '', 0, 1],
    ['BUY_SLIPPAGE', 'Max. buy slippage (%)', 'num', '35', 'higher = fewer missed buys, but worse prices', 1, 90],
  ]],
  ['👥 Crowd entry (skipped launches that take off)', [
    ['CROWD_BUY', 'Buy a skipped launch when a crowd comes', 'bool', '1', 'dev holds the supply / pool too small / not blackholed at launch – but then many buyers: bought with the copy exits'],
    ['CROWD_MIN_BUYERS', 'Min. different buyers', 'num', '100', 'the rugs in the data had 11–23', 1, 100000],
    ['CROWD_MIN_POOL_XRP', 'Min. XRP in the pool', 'num', '500', '', 0, 1e9],
    ['CROWD_WINDOW_MIN', 'Within the first (min)', 'num', '60', '', 1, 1440],
    ['CROWD_BUY_XRP', 'Stake (XRP)', 'num', '1', '', 0.1, 1000],
    ['CROWD_REQUIRE_BLACKHOLE', 'Only blackholed issuers', 'bool', '0', 'on = safer, but UBER (not blackholed) would not have been bought'],
  ]],
  ['🌙 Selling – launch buys', [
    ['TAKE_PROFIT', 'First sale at gain (%)', 'num', '100', '', 1, 100000],
    ['TAKE_PROFIT_PART', 'How much to sell then', 'part', 'auto', '“auto” = exactly the stake back, the rest is a moonbag; or a percent'],
    ['RECOVER_BUFFER', 'Buffer on top of the stake (%)', 'num', '5', 'for fees', 0, 100],
    ['TRAILING_STOP', 'Moonbag: sell x % below its peak', 'num', '0', '0 = never sell', 0, 99],
    ['DEAD_POOL_DROP', 'Clear a dead moonbag at pool loss (%)', 'num', '90', '0 = never', 0, 100],
    ['STOP_LOSS', 'Stop loss before the stake is back (%)', 'num', '50', '0 = off', 0, 99],
    ['RUG_POOL_DROP', 'Rug alarm: pool XRP gone (%)', 'num', '40', '0 = off', 0, 99],
    ['MAX_HOLD_H', 'Max. hold before the stake is back (h)', 'num', '24', '0 = off', 0, 10000],
    ['SELL_SLIPPAGE', 'Max. sell slippage (%)', 'num', '30', '', 1, 90],
  ]],
  ['👀 Wallet tracking', [
    ['TRACK_WALLETS', 'Tracked wallets', 'wallets', '', 'One per line: rAddress:Name'],
    ['COPY_BUY_XRP', 'Stake per copy buy (XRP)', 'num', '1', '', 0.1, 1000],
    ['COPY_MIN_XRP', 'Only if the wallet buys at least (XRP)', 'num', '5', '', 0, 1e6],
    ['COPY_MIN_POOL_XRP', 'Min. liquidity for copies (XRP)', 'num', '100', '', 0, 1e7],
    ['COPY_TAKE_PROFIT', 'Copy: sell at gain (%)', 'num', '100', '', 1, 100000],
    ['COPY_TAKE_PROFIT_PART', 'Copy: share sold then (%)', 'num', '50', '', 1, 100],
    ['COPY_TRAILING_STOP', 'Copy: rest x % below peak', 'num', '30', '0 = off', 0, 99],
    ['COPY_STOP_LOSS', 'Copy: stop loss (%)', 'num', '50', '0 = off', 0, 99],
    ['COPY_RUG_POOL_DROP', 'Copy: rug alarm (%)', 'num', '40', '0 = off', 0, 99],
    ['COPY_MAX_HOLD_H', 'Copy: max. hold (h)', 'num', '24', '0 = off', 0, 10000],
  ]],
  ['🙋 Approval', [
    ['AUTO_FIRST_SALE', 'First sale never waits', 'bool', '1', 'Stake back / first take profit goes through without asking; later sales still ask'],
    ['MCAP_APPROVAL', 'Ask from market cap', 'num', '100000', '0 = off', 0, 1e12],
    ['MCAP_CURRENCY', 'Market cap currency', 'cur', 'USD', ''],
    ['RUNNER_START_XRP', 'Runner: start liquidity from (XRP)', 'num', '300', '0 = off', 0, 1e9],
    ['RUNNER_GROWTH', 'Runner: pool growth (%)', 'num', '100', '', 1, 100000],
    ['RUNNER_WINDOW_MIN', 'Runner: within (min)', 'num', '60', '', 1, 10080],
  ]],
  ['🔔 Notifications', [
    ['DISCORD_WEBHOOK', 'Discord webhook', 'text', '', 'empty = no messages'],
  ]],
];
const WALLET_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
function clean(f, raw) {
  const [k, label, type, , , min, max] = f;
  const v = String(raw ?? '').trim();
  if (type === 'bool') return { v: /^(1|on|true)$/i.test(v) ? '1' : '0' };
  if (type === 'cur') return /^(usd|xrp)$/i.test(v) ? { v: v.toUpperCase() } : { err: `${label}: USD or XRP` };
  if (type === 'part') {
    if (/^auto$/i.test(v)) return { v: 'auto' };
    const n = Number(v.replace(',', '.'));
    return n > 0 && n <= 100 ? { v: String(n) } : { err: `${label}: “auto” or 1–100` };
  }
  if (type === 'num') {
    const n = Number(v.replace(',', '.'));
    if (v === '' || !isFinite(n) || n < min || n > max) return { err: `${label}: a number from ${min} to ${max}` };
    return { v: String(n) };
  }
  if (type === 'wallets') {
    const parts = v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      const [addr, name = ''] = p.split(':').map((x) => x.trim());
      if (!WALLET_RE.test(addr)) return { err: `Tracked wallets: “${addr.slice(0, 40)}” is not an XRPL address` };
      if (/[^\w .-]/.test(name)) return { err: `Tracked wallets: name “${name.slice(0, 20)}” – only letters, digits, spaces, . _ -` };
    }
    return { v: parts.map((p) => p.split(':').map((x) => x.trim()).filter(Boolean).join(':')).join(',') };
  }
  if (type === 'tokens') { // NAME.rIssuer, one per line (or comma-separated)
    const parts = v.split(/[\s,]+/).filter(Boolean);
    for (const p of parts) if (!/^[^.:\s]{1,40}[.:]r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(p)) return { err: `${label}: “${p.slice(0, 50)}” – write NAME.rIssuerAddress` };
    return { v: parts.join(',') };
  }
  if (k === 'DISCORD_WEBHOOK' && v && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(v)) return { err: 'Discord webhook: must start with https://discord.com/api/webhooks/' };
  return { v };
}

const short = (v) => (v === '' ? '–' : v.length > 40 ? v.slice(0, 37) + '…' : v);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// One settings page per bot: its field groups, its file in the data folder, its URLs.
export function makeSettings(GROUPS, { file = 'settings.json', title = '⚙️ Settings', action = '/settings', back = '/' } = {}) {
  const FIELDS = GROUPS.flatMap(([, f]) => f);
  const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f[0], f]));

  const fileOf = (dir) => path.join(dir, file);
  function loadOverrides(dir) {
    try {
      const o = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
      return Object.fromEntries(Object.entries(o).filter(([k, v]) => BY_KEY[k] && typeof v === 'string'));
    } catch { return {}; }
  }
  function saveOverrides(dir, o) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = fileOf(dir) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o, null, 1));
    fs.renameSync(tmp, fileOf(dir));
  }

  // Value without overrides: .env / process env, else the built-in default.
  const baseValue = (env, k) => (env[k] !== undefined && env[k] !== '' ? String(env[k]) : BY_KEY[k][3]);

  // Form → new overrides. Only values that differ from the base are stored.
  function fromForm(form, env, current) {
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
  function settingsPage(env, overrides, msg = '', errors = []) {
    const val = (k) => overrides[k] ?? baseValue(env, k);
    const input = (f) => {
      const [k, label, type, def, help] = f;
      const v = val(k);
      const mark = overrides[k] !== undefined ? ' <small class="ch">changed</small>' : '';
      let el;
      if (type === 'bool') el = `<label class="sw"><input type="checkbox" name="${k}" value="1"${v === '1' ? ' checked' : ''}> on</label>`;
      else if (type === 'cur') el = `<select name="${k}">${['USD', 'XRP'].map((c) => `<option${c === v ? ' selected' : ''}>${c}</option>`).join('')}</select>`;
      else if (type === 'tokens') el = `<textarea name="${k}" rows="10" placeholder="FUZZY.rhCAT…">${esc(v.split(',').filter(Boolean).join('\n'))}</textarea>`;
      else if (type === 'wallets') el = `<textarea name="${k}" rows="4" placeholder="rAbc…:Name">${esc(v.split(',').filter(Boolean).join('\n'))}</textarea>`;
      else el = `<input name="${k}" value="${esc(v)}" ${type === 'num' ? 'inputmode="decimal"' : ''} autocomplete="off">`;
      return `<div class="f"><div class="l">${esc(label)}${mark}${help ? `<small>${esc(help)}</small>` : ''}<small class="d">Default: ${esc(def === '' ? '–' : type === 'tokens' ? `${def.split(',').length} tokens (empty field = back to them)` : def)}</small></div><div class="i">${el}</div></div>`;
    };
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Settings</title>
  <style>body{font:14px system-ui;margin:16px;background:#0e1726;color:#e6edf6;max-width:760px}a{color:#6cb8ff}h3{margin:22px 0 6px}.f{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid #243247}.l{flex:1}.l small{display:block;color:#8aa0bb;font-size:12px}.l small.d{color:#5f7590}.ch{display:inline!important;color:#f5b942!important;margin-left:6px}.i{width:min(220px,45vw)}input,select,textarea{font:inherit;width:100%;box-sizing:border-box;padding:7px;border-radius:7px;border:1px solid #3a4d66;background:#152033;color:#e6edf6}.sw input{width:auto;margin-right:6px}button{font:inherit;padding:9px 16px;border-radius:8px;border:1px solid #2c9a5e;background:#1f6e43;color:#e6edf6;cursor:pointer}.bar{position:sticky;bottom:0;background:#0e1726;padding:12px 0;border-top:1px solid #243247;margin-top:16px}.ok{background:#173d2a;border:1px solid #2c9a5e;padding:8px 12px;border-radius:8px}.err{background:#4a1f1f;border:1px solid #9a3c3c;padding:8px 12px;border-radius:8px}@media(max-width:520px){.f{flex-direction:column}.i{width:100%}}</style>
  <p><a href="${back}">← back to the overview</a></p><h2>${title}</h2>
  <p><small>Changes apply at once, no restart. An empty field resets the value to the default. The wallet key and the password can’t be changed here.</small></p>
  ${msg ? `<div class="ok">${msg}</div>` : ''}${errors.length ? `<div class="err">${errors.map(esc).join('<br>')}</div>` : ''}
  <form method="post" action="${action}">${GROUPS.map(([g, fs]) => `<h3>${g}</h3>${fs.map(input).join('')}`).join('')}
  <div class="bar"><button>💾 Save</button></div></form>`;
  }
  return { GROUPS, FIELDS, loadOverrides, saveOverrides, baseValue, fromForm, settingsPage };
}

// the sniper's settings (used by index.js)
const sniper = makeSettings(GROUPS);
export const { FIELDS, loadOverrides, saveOverrides, baseValue, fromForm, settingsPage } = sniper;
