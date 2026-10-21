// A broken NFT picture (cut-off transfer from one gateway) must never be served or cached: the server tries the other
// gateways, and replaces a broken picture already in its cache
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac, createHash } from "node:crypto";
const S = process.argv[2], D = S + "/dataImg", PORT = 3977, U = "http://127.0.0.1:" + PORT;
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D, {recursive: true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369", BROKEN_IMG: "4464"}, stdio: "ignore"});
const bye = c => { try { srv.kill(); } catch {} process.exit(c); };
setTimeout(() => bye(1), 60000);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
await new Promise(r => setTimeout(r, 2500));
const A = "rTutoria1P1ayerXXXXXXXXXXXXXXX", H = {authorization: "Bearer " + tok(A)};
const pngOk = b => b.length > 64 && b[0] === 0x89 && b.subarray(b.length - 12).includes(0x49) && Buffer.from(b.subarray(b.length - 8, b.length - 4)).toString() === "IEND";
for (let i = 0; i < 4; i++){
  const r = await fetch(U + "/api/img?u=" + encodeURIComponent("ipfs://bafyX/4464.png"), {headers: H}), b = new Uint8Array(await r.arrayBuffer());
  if (r.status !== 200) console.log(r.status, Buffer.from(b).toString()); ok(r.status === 200 && pngOk(b), `try ${i + 1}: the picture comes whole (${b.length} bytes) although one gateway cuts it off`);
}
// a broken copy already in the cache (from before the fix) is not served again
const cache = fs.readdirSync(D + "/cache").filter(f => f.endsWith(".bin"));
for (const f of cache) fs.writeFileSync(D + "/cache/" + f, fs.readFileSync(D + "/cache/" + f).subarray(0, 200));
const r = await fetch(U + "/api/img?u=" + encodeURIComponent("ipfs://bafyX/4464.png"), {headers: H}), b = new Uint8Array(await r.arrayBuffer());
ok(cache.length > 0 && r.status === 200 && pngOk(b) && pngOk(new Uint8Array(fs.readFileSync(D + "/cache/" + cache[0]))), "a broken picture in the cache is fetched again and replaced");
console.log(fails ? fails + " FAILED" : "ALL PASS"); bye(fails ? 1 : 0);
