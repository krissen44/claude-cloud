// the live.mjs mock + issuer treasury, nft_sell_offers and a fake Xaman API
const hex = s => Buffer.from(s).toString("hex");
const PAY = {}, OFFERS = {};
globalThis.__PAY = PAY;
const prev = () => globalThis.__liveFetch;
const wrap = async (u, o = {}) => {
  u = String(u);
  if (o.__viaWrap) return orig(u, o);                    // live.mjs falling through to "real" fetch
  if (u.includes("xumm.app/api/v1/platform/payload")) {
    if ((o.method || "GET") === "POST") {
      const b = JSON.parse(o.body), uuid = crypto.randomUUID();
      PAY[uuid] = b; console.error("XAMAN", b.txjson.TransactionType, JSON.stringify(b.options.signers), b.custom_meta.instruction);
      return Response.json({uuid, refs:{qr_png:"data:image/gif;base64,R0lGODlhAQABAAAAACw="}, next:{always:"https://xumm.app/sign/" + uuid}});
    }
    const uuid = u.split("/").pop(), b = PAY[uuid], tx = b.txjson;
    if (tx.TransactionType === "NFTokenCreateOffer") OFFERS[tx.NFTokenID] = {nft_offer_index: "OFF" + tx.NFTokenID, destination: tx.Destination, amount: "0"};
    if (tx.TransactionType === "NFTokenAcceptOffer") for (const k in OFFERS) if (OFFERS[k].nft_offer_index === tx.NFTokenSellOffer) delete OFFERS[k];
    return Response.json({meta:{resolved:true, signed:true, expired:false}, response:{account: tx.Account, txid: "TX" + uuid.slice(0, 8).toUpperCase(), dispatched_result:"tesSUCCESS"}});
  }
  if (u.includes("xrplcluster") || u.includes("ripple.com")) {
    const b = JSON.parse(o.body);
    if (b.method === "nft_sell_offers") { const x = OFFERS[b.params[0].nft_id]; return Response.json({result: x ? {offers:[x]} : {error:"objectNotFound"}}); }
    if (b.method === "account_nfts" && b.params[0].account.startsWith("rNo")) return Response.json({result:{account_nfts:[]}});
    if (b.method === "account_nfts" && b.params[0].account === "rI")
      return Response.json({result:{account_nfts:[100, 101, 102, 103, 104].map(t => ({Issuer:"rI", NFTokenTaxon:369, NFTokenID:"T"+t, URI:hex(`ipfs://bafyX/${t}.json`)}))}});
  }
  return prev()(u, {...o, __viaWrap: true});
};
const orig = globalThis.fetch;
globalThis.fetch = async (u, o) => wrap(u, o);
globalThis.__liveFetch = orig;
// live.mjs replaces fetch again on import: chain it behind ours
const desc = {set(f){ globalThis.__liveFetch = f; }, get(){ return wrap; }, configurable: true};
Object.defineProperty(globalThis, "fetch", desc);
await import(new URL("./live.mjs", import.meta.url).href);
