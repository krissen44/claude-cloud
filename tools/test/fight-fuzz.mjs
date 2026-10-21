// Fight fuzz: many fights over every scene, all demo dogs incl. Legendaries, random moves and abilities (desktop + phone).
// Fails on page errors, sprites left out of place after a round, effect elements piling up, or a filter on a sprite.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const S = process.argv[2], N = +(process.argv[3] || 24);
const srv = spawn("node", [new URL("./live.mjs", import.meta.url).pathname], {env: {...process.env, PORT: "3978", DATA_DIR: S + "/dataFuzz", ISSUER: "rI", TAXON: "369"}, stdio: "ignore"});
const bye = c => { try { srv.kill(); } catch {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 600000);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
await new Promise(r => setTimeout(r, 3000));
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
for (const vp of [{width: 1300, height: 900}, {width: 390, height: 844}]) {
  const p = await br.newPage({viewport: vp}); const errs = [], bad = [];
  p.on("pageerror", e => errs.push(e.message));
  await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
  await p.goto("http://127.0.0.1:3978/"); await p.waitForTimeout(600);
  for (let i = 0; i < N; i++) {
    const r = await p.evaluate(async i => {
      const F = DATA.fighters, a = F[i % F.length], b = F[(i * 7 + 3) % F.length];
      fightScene = FIGHT_SCENES[i % FIGHT_SCENES.length]; const keep = nextFightScene; nextFightScene = () => {};
      startFight(a, b, false, 1 + (i % 20)); nextFightScene = keep;
      const t0 = Date.now(); while (busy && Date.now() - t0 < 4000) await new Promise(r => setTimeout(r, 50));
      const out = [];
      for (let k = 0; k < 12 && !over; k++) {
        const ab = P.actives.find(x => x.cost <= P.energy);
        const pa = ab && Math.random() < .4 ? {type: 'ability', a: ab} : {type: ['bite', 'guard', 'taunt'][Math.floor(Math.random() * 3)]};
        await go(pa);
        const t1 = Date.now(); while (busy && Date.now() - t1 < 8000) await new Promise(r => setTimeout(r, 50));
        await new Promise(r => setTimeout(r, 450));
        const st = document.querySelector('.stage').getBoundingClientRect();
        for (const s of ['l', 'r']) {
          const el = fighterEl(s), img = el.querySelector('img'), bx = img.getBoundingClientRect();
          if (getComputedStyle(img).filter !== 'none') out.push(`${s}: filter ${getComputedStyle(img).filter}`);
          if (!el.classList.contains('faint') && !over && !img.getAnimations().length && (bx.bottom < st.top + st.height * .45 || bx.left < st.left - 40 || bx.right > st.right + 40))
            out.push(`${s}: sprite out of place after round ${turn - 1} (${Math.round(bx.left - st.left)},${Math.round(bx.top - st.top)} ${Math.round(bx.width)}x${Math.round(bx.height)} stage ${Math.round(st.width)}x${Math.round(st.height)} tf ${getComputedStyle(img).transform} anims ${img.getAnimations().length})`);
        }
        const fx = document.querySelectorAll('.stage .chomp,.stage .comic,.stage .itempop,.fighter .hitw,.fighter .twin').length;
        if (fx > 6) out.push(`${fx} effect elements left over`);
      }
      return {out, over, scene: fightScene, a: a.name, b: b.name};
    }, i);
    if (r.out.length) bad.push(`${r.a} vs ${r.b} @${r.scene}: ${[...new Set(r.out)].join("; ")}`);
  }
  ok(bad.length === 0, `${vp.width}px: ${N} fights, sprites in place and no filters/leftovers` + (bad.length ? "\n   " + bad.slice(0, 8).join("\n   ") : ""));
  ok(errs.length === 0, `${vp.width}px: no page errors ` + [...new Set(errs)].slice(0, 5).join(" | "));
  await p.close();
}
await br.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); bye(fails ? 1 : 0);
