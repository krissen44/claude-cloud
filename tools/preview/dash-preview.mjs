// Builds a stand-alone test page of Scrappy Dash from the real game (public/index.html): same simulation, drawing and
// UI, with a small stand-in server inside the page (example rankings, an Advent calendar on day 5, prizes, the Scrappy
// bonus, and every run replayed with the real dashReplay like the server does). Nothing goes online.
// Usage: node tools/preview/dash-preview.mjs <out.html>   — the output is a fragment for an Artifact page (no <html>/<head>).
import fs from "node:fs";
const src = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
let h = src;
const cut = (a, b) => { if (!h.includes(a)) throw new Error("missing: " + a.slice(0, 60)); h = h.replace(a, b); };
cut(/<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport"[^\n]*\n/.exec(h)[0], "");
cut("<title>Bark Arena — Pixel Scrappy</title>", "<title>Scrappy Dash Test</title>");
cut("</head>\n<body>\n", "");
cut("</body>\n</html>", "");
// images of prizes and bonus labels come from the stand-in server
cut("const dashImgUrl = t => CONFIG.WORKER_URL", "const dashImgUrl = t => window.PREVIEW ? DATA.fighters[t % DATA.fighters.length].img : CONFIG.WORKER_URL");
cut("const dashBonusFor = f => !f ||", "const dashBonusFor = f => window.PREVIEW ? (f && DASH_BONUS[f.rarity]) || DASH_BONUS.Common : !f ||");
// the boot: straight into the Dash tab, signed in to the stand-in server
const boot = /if \(\/\^\\\/tv\\\/\?\$\/\.test\(location\.pathname\)\) tvBoot\(\);[\s\S]*?\n}\n(?=<\/script>)/.exec(h);
if (!boot) throw new Error("boot block not found");
h = h.replace(boot[0], fs.readFileSync(new URL("./dash-preview-mock.js", import.meta.url), "utf8"));
fs.writeFileSync(process.argv[2] || "scrappy-dash-test.html", h);
console.log("written", (h.length / 1024).toFixed(0) + " KB");
