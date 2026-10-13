// Shorts formats: Legendary spotlight, boss, and the fallbacks (champion / 1 HP Club without data → best fight)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
const S = process.argv[2], D = S + "/dataShortsFmt", U = "http://127.0.0.1:3984";
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D, {recursive: true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const srv = spawn("node", [new URL("./season-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: "3984", DATA_DIR: D, ISSUER: "rI", TAXON: "369", ADMIN_KEY: "adm"}, stdio: "ignore"});
const bye = c => { try { srv.kill(); } catch {} process.exit(c); };
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
await new Promise(r => setTimeout(r, 1300));
fs.copyFileSync(new URL("../../public/kit/factory.mjs", import.meta.url), new URL("./factory.run.mjs", import.meta.url));
const run = f => { try { execFileSync("node", [new URL("./factory.run.mjs", import.meta.url).pathname], {stdio: "inherit", env: {...process.env, GAME_URL: U, ADMIN_KEY: "adm", CLIPS: "1",
  FORMAT: f, WORK_DIR: S + "/shorts-work-f", STATE_FILE: S + "/shorts-state-f.json"}, timeout: 300000}); } catch (e) { console.log("factory exit", e.status); } };
fs.rmSync(S + "/shorts-state-f.json", {force: true});
for (const f of ["leg", "boss", "champ", "leg"]) run(f);
const list = (await (await fetch(U + "/api/admin/clips?key=adm")).json()).clips.sort((a, b) => a.made - b.made);
for (const c of list) console.log(" ·", c.format, "|", c.story, "|", c.seconds + "s |", c.hook, "|", c.youtube.title, "|", c.youtube.description.split("\n").pop());
ok(list.length === 4, "four clips");
ok(list[0].format === "leg" && list[0].story === "legendary" || list[0].format === "leg", "Legendary spotlight: " + list[0].youtube.title);
ok(list[1].format === "boss" && /boss/i.test(list[1].youtube.title + list[1].hook), "boss format: " + list[1].youtube.title);
ok(list[2].format === "fight", "no champion data → best fight instead");
ok(list[0].titleId !== list[3].titleId && list[0].hook !== list[3].hook, `two spotlights in a row get different titles and lines ("${list[0].youtube.title}" / "${list[3].youtube.title}")`);
const st = JSON.parse(fs.readFileSync(S + "/shorts-state-f.json", "utf8"));
ok(st.leg === 2 && st.titles.length === 4 && st.hooks.length === 4, "state keeps the Legendary turn, titles and lines used");
console.log(fails ? fails + " FAILED" : "ALL PASS"); bye(fails ? 1 : 0);
