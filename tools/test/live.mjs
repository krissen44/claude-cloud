// real server, ledger + IPFS mocked
import zlib from "node:zlib";
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const W = 96, raw = Buffer.alloc((W * 3 + 1) * W);
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const i = y * (W * 3 + 1) + 1 + x * 3; const dog = (x-48)**2 + (y-50)**2 < 900; raw[i] = dog ? 200 : 240; raw[i+1] = dog ? 150 : 220; raw[i+2] = dog ? 60 : 200; }
const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(W, 4); ih[8] = 8; ih[9] = 2;
const PNG = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
const hex = s => Buffer.from(s).toString("hex");
const real = globalThis.fetch;
globalThis.fetch = async (u, o = {}) => {
  u = String(u);
  if (u.includes("xrplcluster") || u.includes("ripple.com")) {
    if (JSON.parse(o.body).method === "nfts_by_issuer") {
      if (u.includes("xrplcluster")) return Response.json({result:{error:"unknownCmd"}});      // rippled: no Clio methods
      return Response.json({result:{nfts: Array.from({length:5000}, (_, i) => ({nft_id: "000800" + String(i+1).padStart(6, "0"), uri: hex(`ipfs://bafyX/${i+1}.json`), owner: "rHolder" + (i % 7)}))}});
    }
    return Response.json({result:{account_nfts:[2931, 4344, 3821].map(t => ({Issuer:"rI", NFTokenTaxon:369, NFTokenID:"N"+t, URI:hex(`ipfs://bafyX/${t}.json`)}))}});
  }
  if (u.includes("/ipfs/")) {
    if (u.endsWith(".png")) return new Response(PNG, {headers:{"content-type":"image/png"}});
    const t = +u.match(/(\d+)\.json/)[1];
    if (t > 4990) return new Response("nf", {status:404});
    return Response.json({name:`Pixel Scrappy #${t}`, image:`ipfs://bafyX/${t}.png`, attributes:[{trait_type:"Fur", value:"White"}]});
  }
  return real(u, o);
};
await import(new URL("../../server.js", import.meta.url).href);
