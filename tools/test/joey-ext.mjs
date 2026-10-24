// Joey Wallet browser extension: the game's sign-in against a provider that behaves like the live extension
// (SDK 0.5.0 surface: window.joey + window.xrpl.joey, connect({name, icon}), signIn({statement, nonce}) →
// CAIP-122 message signed with ripple-keypairs over its UTF-8 bytes, or for a Ledger account
// {address, signedTx, mode:'challenge-v1'}). Real keys, real signatures, the real server check.
// Usage: node tools/test/joey-ext.mjs <outdir>
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const kp = require("ripple-keypairs"), codec = require("ripple-binary-codec");
const S = process.argv[2], D = S + "/dataJoey", PORT = 3994, U = "http://127.0.0.1:" + PORT;
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D, {recursive: true});
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369",
  RETURN_URL: U + "/", ORIGIN: U}, stdio: "ignore"});
const bye = c => { try { srv.kill(); } catch {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 150000);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
await new Promise(r => setTimeout(r, 1800));
const hex = s => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const keys = {secp: kp.deriveKeypair(kp.generateSeed({algorithm: "ecdsa-secp256k1"})), ed: kp.deriveKeypair(kp.generateSeed({algorithm: "ed25519"}))};
const addr = k => kp.deriveAddress(k.publicKey);
// what the extension does when the user approves
function wallet(kind, req){
  if (kind === "ledger"){
    const k = keys.secp, a = addr(k);
    const tx = {TransactionType: "Payment", Account: a, Destination: a, Amount: "1", Fee: "12", Sequence: 0, Flags: 0, SigningPubKey: k.publicKey,
      Memos: [{Memo: {MemoData: hex(JSON.stringify({wallet: "joey", challenge: req.nonce}))}}]};
    tx.TxnSignature = kp.sign(codec.encodeForSigning(tx), k.privateKey);
    return {address: a, signedTx: JSON.stringify(tx), mode: "challenge-v1"};
  }
  const k = keys[kind], a = addr(k);
  const msg = `${req.host} wants you to sign in with your XRPL account:\n${a}\n\n${req.statement}\n\nURI: ${req.origin}\nVersion: 1\nChain ID: 0\nNonce: ${req.nonce}\nIssued At: ${new Date().toISOString()}`;
  return {address: a, publicKey: k.publicKey, signature: kp.sign(hex(msg), k.privateKey), message: msg, mode: "caip122"};
}
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
async function run(kind, opt = {}){
  const ctx = await br.newContext({viewport: {width: 1000, height: 900}}); const p = await ctx.newPage(); const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  await p.route(u => !u.href.startsWith(U), r => r.abort());
  const calls = [];
  await p.exposeFunction("__joeyWallet", (k, req) => { calls.push(["signIn", req]); if (opt.reject) return {error: 4001}; return wallet(k, req); });
  await p.exposeFunction("__joeyLog", (m, a) => calls.push([m, a]));
  // the injected provider, mounted like the extension does (late if asked: a cold service worker)
  await p.addInitScript(([kind, late]) => {
    const mount = () => {
      let accounts = [];
      const joey = {isJoey: true, rdns: "xyz.joeywallet", version: "1", capabilities: [], get accounts(){ return accounts; }, chain: "xrpl:0",
        isAvailable: () => true, isConnected: () => accounts.length > 0,
        async connect(params){ window.__joeyLog("connect", params); return {accounts: [{address: "pending"}], chain: "xrpl:0"}; },
        async signIn(params){
          const r = await window.__joeyWallet(kind, {statement: params.statement, nonce: params.nonce, host: location.host, origin: location.origin});
          if (r.error) throw Object.assign(new Error("User rejected the request."), {code: r.error});
          accounts = [r.address]; return r; },
        request({method, params}){ return this[method](params); }, on(){ return () => {}; }};
      window.joey = joey; window.xrpl = Object.assign(window.xrpl || {}, {joey});
    };
    late ? setTimeout(mount, late) : mount();
  }, [kind, opt.late || 0]);
  await p.goto(U + "/");
  await p.click("#connectLive"); await p.waitForSelector("#pickJoey"); await p.click("#pickJoey");
  if (opt.reject){ await p.waitForFunction(() => /declined/i.test(WALLET.error || ""), null, {timeout: 15000}); }
  else await p.waitForFunction(() => WALLET.account && WALLET.token, null, {timeout: 20000});
  const st = await p.evaluate(() => ({account: WALLET.account, err: WALLET.error, session: JSON.parse(localStorage.getItem("ba_session") || "null")}));
  await ctx.close();
  return {st, calls, errs};
}
for (const [kind, label] of [["secp", "software account (secp256k1)"], ["ed", "software account (Ed25519)"], ["ledger", "Ledger account (challenge payment)"]]){
  const r = await run(kind);
  const want = addr(keys[kind === "ledger" ? "secp" : kind]);
  ok(r.st.account === want && r.st.session && r.st.session.account === want && !r.errs.length, `${label}: signed in as ${r.st.account}`);
  if (kind === "secp"){
    const c = r.calls.find(x => x[0] === "connect");
    ok(c && c[1].name === "Bark Arena" && /^https:\/\//.test(c[1].icon), "connect() shows the name + an https icon on Joey's approval screen");
  }
}
{ const r = await run("secp", {late: 1200}); ok(r.st.account === addr(keys.secp), "provider injected 1.2 s late (cold extension) is still found"); }
// no extension at all: a clear message + the Chrome Web Store link
{ const ctx = await br.newContext(); const p = await ctx.newPage(); await p.route(u => !u.href.startsWith(U), r => r.abort());
  await p.goto(U + "/"); await p.click("#connectLive"); await p.click("#pickJoey");
  await p.waitForFunction(() => /not found/.test(WALLET.error || ""), null, {timeout: 15000});
  const href = await p.locator('a[href*="chromewebstore.google.com/detail/joey-wallet"]').getAttribute("href").catch(() => null);
  ok(!!href, "no extension installed → message + \"Get Joey for Chrome\" link"); await ctx.close(); }
{ const r = await run("secp", {reject: true}); ok(/declined/i.test(r.st.err) && !r.st.account, "user rejects in Joey → \"" + r.st.err + "\""); }
// a replayed signature (nonce already used) and a message for another domain are refused by the server
{ const n = await (await fetch(U + "/api/auth/joey/start", {method: "POST"})).json();
  const good = wallet("secp", {statement: n.statement, nonce: n.nonce, host: new URL(U).host, origin: U});
  const v1 = await fetch(U + "/api/auth/joey/verify", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(good)});
  const v2 = await fetch(U + "/api/auth/joey/verify", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(good)});
  const n2 = await (await fetch(U + "/api/auth/joey/start", {method: "POST"})).json();
  const evil = wallet("secp", {statement: n2.statement, nonce: n2.nonce, host: "evil.example", origin: "https://evil.example"});
  const v3 = await fetch(U + "/api/auth/joey/verify", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(evil)});
  ok(v1.status === 200 && v2.status === 401 && v3.status === 401, `server: first use ok, replay refused (${(await v2.json()).error}), other domain refused (${(await v3.json()).error})`); }
await br.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); bye(fails ? 1 : 0);
