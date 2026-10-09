// Mock server for the how-to-play tutorial recording: the real server.js with ledger + IPFS faked, but the dogs
// look like real Pixel Scrappys (the demo fighters' pixel art on a coloured background, real traits from DATA).
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const FF = process.env.FFMPEG || "ffmpeg";
const html = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const DATA = JSON.parse(html.match(/const DATA = (\{.*?\});\n/s)[1]);
const TR = Object.fromEntries(DATA.traits.map(t => [t.id, t]));
const REG = DATA.fighters.filter(f => !f.legendary);
const BG = ["#f6c9b8", "#cdbff2", "#bfe8d0", "#2a4f8f", "#c9d8b8", "#ffe7a3", "#a9d6f5", "#f5b6cf", "#d7d0c4"];
const hex = s => Buffer.from(s).toString("hex");
// who holds what: the tutorial player and three other players (rivals, chat, club, ladder)
const HOLD = {
  rTutoria1P1ayerXXXXXXXXXXXXXXX: [2723, 2715, 2724, 8],
  rRiva1OneXXXXXXXXXXXXXXXXXXXXX: [3101, 3102, 3103],
  rRiva1TwoXXXXXXXXXXXXXXXXXXXXX: [12, 3201],
  rRiva1ThreeXXXXXXXXXXXXXXXXXXX: [3301, 3302],
  rFriendWithDogXXXXXXXXXXXXXXXX: [3401],
  rI: [4101, 4102, 4103, 7],                     // the treasury (issuer wallet): starter dogs come from here
};
const FIX = {2723: "2723", 2715: "2715", 2724: "2724", 2719: "2719", 2721: "2721"};
const look = t => t <= 20 ? DATA.fighters.find(f => f.id === "L" + t) : FIX[t] ? REG.find(f => f.id === FIX[t]) : REG[t % REG.length];
function meta(t){
  const f = look(t), at = [];
  if (t > 20){
    for (const id of f.traits){ const x = TR[id]; if (x) at.push({trait_type: x.trait_type, value: x.value}); }
    at.push({trait_type: "Rarity", value: f.rarity});
    if (f.set){ at.push({trait_type: "Set", value: f.set}); at.push({trait_type: "Set Match", value: String(f.setMatch)}); }
  } else at.push({trait_type: "Rarity", value: "Legendary"});
  return {name: `Pixel Scrappy #${t}`, image: `ipfs://bafyX/${t}.png`, attributes: at};
}
const PNGS = {}, TMP = (process.env.DATA_DIR || "/tmp") + "/tutimg";
fs.mkdirSync(TMP, {recursive: true});
function png(t){
  if (PNGS[t]) return PNGS[t];
  const f = look(t), src = `${TMP}/s${t}.png`, out = `${TMP}/o${t}.png`, bg = BG[t % BG.length];
  fs.writeFileSync(src, Buffer.from(f.img.split(",")[1], "base64"));
  execFileSync(FF, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${bg}:s=96x96`, "-i", src,
    "-filter_complex", "[0][1]overlay=0:0,scale=1152:1152:flags=neighbor", "-frames:v", "1", out]);
  return PNGS[t] = fs.readFileSync(out);
}
const real = globalThis.fetch;
globalThis.fetch = async (u, o = {}) => {
  u = String(u);
  if (u.includes("xrplcluster") || u.includes("ripple.com")) {
    const b = JSON.parse(o.body);
    if (b.method === "nfts_by_issuer") {
      if (u.includes("xrplcluster")) return Response.json({result: {error: "unknownCmd"}});
      return Response.json({result: {nfts: Array.from({length: 5000}, (_, i) => ({nft_id: "000800" + String(i + 1).padStart(6, "0"), uri: hex(`ipfs://bafyX/${i + 1}.json`), owner: "rHolder" + (i % 7)}))}});
    }
    if (b.method === "account_nfts") {
      const ts = HOLD[b.params[0].account] || [];
      return Response.json({result: {account_nfts: ts.map(t => ({Issuer: "rI", NFTokenTaxon: 369, NFTokenID: "000800" + String(t).padStart(6, "0"), URI: hex(`ipfs://bafyX/${t}.json`)}))}});
    }
    return Response.json({result: {error: "objectNotFound"}});
  }
  if (u.includes("discord.com/api/webhooks/")) {          // the Discord webhook: written to a file for the tests
    let txt;
    if (o.body instanceof FormData) { const f = o.body.get("files[0]"); txt = JSON.parse(o.body.get("payload_json")).content + (f ? `\n[file ${f.name} ${f.size} bytes]` : ""); }
    else txt = JSON.parse(o.body).content;
    fs.appendFileSync((process.env.DATA_DIR || "/tmp") + "/discord.log", "[" + u.split("/").pop() + "] " + txt + "\n----\n");
    return new Response(null, {status: 204});
  }
  if (u.includes("/ipfs/")) {
    const t = +u.match(/(\d+)\.(json|png)/)[1];
    if (u.endsWith(".png")) return new Response(png(t), {headers: {"content-type": "image/png"}});
    return Response.json(meta(t));
  }
  return real(u, o);
};
// SITE_PORT: the static website (barkarena page) next to the game, with fonts from FONTS_DIR and the dog images above
if (process.env.SITE_PORT) {
  const http = await import("node:http"), path = await import("node:path");
  const WEB = new URL("../../website/", import.meta.url).pathname, FONTS = process.env.FONTS_DIR || "";
  http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split("?")[0]);
    const send = (b, t) => { r.writeHead(200, {"content-type": t}); r.end(b); };
    let m;
    if ((m = u.match(/^\/pixelscrappy\/nfts\/(\d+)\.png$/))) return send(png(+m[1]), "image/png");
    if ((m = u.match(/^\/assets\/fonts\/([\w-]+\.woff2)$/)) && FONTS && fs.existsSync(path.join(FONTS, m[1]))) return send(fs.readFileSync(path.join(FONTS, m[1])), "font/woff2");
    const f = path.join(WEB, u.endsWith("/") ? u + "index.html" : u);
    if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    send(fs.readFileSync(f), f.endsWith(".html") ? "text/html; charset=utf-8" : f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "application/octet-stream");
  }).listen(+process.env.SITE_PORT);
}
await import(new URL("../../server.js", import.meta.url).href);
