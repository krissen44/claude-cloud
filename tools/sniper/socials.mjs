// Socials of a token: read from the issuer's domain – https://<Domain>/.well-known/xrp-ledger.toml
// (FirstLedger sets a <id>.toml.firstledger.net domain on every issuer). The file format leaves the
// names of social fields open, so every link and every field that looks like X/Twitter, Telegram,
// Discord or a website is picked up, whatever it is called.

const KIND = [
  ['x', /(^|\.)((x|twitter)\.com)$/i],
  ['telegram', /(^|\.)(t\.me|telegram\.(me|org))$/i],
  ['discord', /(^|\.)(discord\.(gg|com))$/i],
  ['instagram', /(^|\.)instagram\.com$/i],
  ['tiktok', /(^|\.)tiktok\.com$/i],
];
const NOT_A_SITE = /(firstledger\.net|ipfs|xrpl\.to|xrpscan|bithomp|xrp\.cafe|\.(png|jpe?g|gif|webp|svg)(\?|$))/i;

export function parseSocials(text) {
  const out = { x: null, telegram: null, discord: null, instagram: null, tiktok: null, website: null };
  if (!text) return out;
  for (const m of String(text).matchAll(/https?:\/\/[^\s"'<>\]]+/g)) {
    let u;
    try { u = new URL(m[0]); } catch { continue; }
    const kind = KIND.find(([, re]) => re.test(u.hostname));
    if (kind) { out[kind[0]] ||= u.href; continue; }
    if (!out.website && !NOT_A_SITE.test(u.href)) out.website = u.href;
  }
  // handles without a link: twitter = "name", x = "@name", telegram = "group"
  for (const m of String(text).matchAll(/^\s*([A-Za-z_0-9]+)\s*=\s*"([^"]+)"/gm)) {
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (!v || /^https?:/i.test(v)) continue;
    const h = v.replace(/^@/, '');
    if (!out.x && /^(twitter|x|x_?handle|twitter_?handle)$/.test(k)) out.x = `https://x.com/${h}`;
    if (!out.telegram && /^(telegram|tg)$/.test(k)) out.telegram = `https://t.me/${h}`;
  }
  return out;
}
export const hasSocials = (s, need) => (need === 'off' ? true : need === 'any' ? !!(s && (s.x || s.telegram || s.discord || s.website)) : !!(s && s.x));
export const socialsText = (s) => (s ? ['x', 'telegram', 'discord', 'website'].filter((k) => s[k]).map((k) => (k === 'x' ? 'X' : k)).join(' · ') || 'none' : 'unknown');

// cached lookups; null = couldn't read the file (then nothing is decided on socials)
export function createSocials({ fetchFn = globalThis.fetch, timeoutMs = 4000, ttlMs = 60e3 } = {}) {
  const cache = new Map();
  async function get(domain, maxAgeMs = ttlMs) {
    const d = String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!d) return { ...parseSocials(''), none: true, found: false };
    const c = cache.get(d);
    if (c && Date.now() - c.at < maxAgeMs) return c.v;
    let v = null;
    if (fetchFn) {
      try {
        const r = await fetchFn(`https://${d}/.well-known/xrp-ledger.toml`, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) v = { ...parseSocials(await r.text()), found: true };
        else if (r.status === 404) v = { ...parseSocials(''), found: false };
      } catch {}
    }
    cache.set(d, { at: Date.now(), v });
    return v;
  }
  return { get };
}
