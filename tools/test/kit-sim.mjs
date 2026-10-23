// Balance check: win % at a bond level per active ability (BYACT=1), per random dog (default) or over a streak (SEQ=1, HPB=heat HP).
// node tools/test/kit-sim.mjs public/index.html <fights> <bond> [dogs]
import fs from "node:fs"; import vm from "node:vm";
const file = process.argv[2], N = +(process.argv[3] || 200), LV = +(process.argv[4] || 10);
const html = fs.readFileSync(file, "utf8");
const parts = [...html.matchAll(/\/\/@engine[^\n]*\n([\s\S]*?)\/\/@\/engine/g)].map(m => m[1]);
const code = "let clubMode=false; const SAVE={bump(){}};\n" + parts.join("\n") + `
const R=a=>a[Math.floor(Math.random()*a.length)];
const CT={bite:'guard', guard:'taunt', taunt:'bite'};
const LAYERS=[...new Set(DATA.traits.map(t=>t.layer))];
const TIER={Common:0,Uncommon:1,Rare:2,Epic:3,Mythic:4};
function wpick(arr){ const s=arr.reduce((a,t)=>a+t.pieces,0); let r=Math.random()*s; for(const t of arr){ r-=t.pieces; if(r<=0) return t; } return arr[0]; }
function rdog(i){ const tr=LAYERS.map(l=>wpick(DATA.traits.filter(t=>t.layer===l)));
  const top=Math.max(...tr.map(t=>TIER[t.tier]||0)); const rar=['Common','Uncommon','Rare','Epic','Mythic'][Math.min(4,Math.max(0,top-1))];
  return {id:'d'+i,name:'#'+i,rarity:rar,traits:tr.map(t=>t.id),setMatch:0,set:null,unknown:[]}; }
const strat={
  smart: (M)=>{ const a=P.actives.filter(x=>typeof abReady==='function'?abReady(P,x):x.cost<=P.energy); if(a.length && Math.random()<.7) return {type:'ability',a:a[0]};
     const last=E.hist[E.hist.length-1]||'^'; const row=M[last]||{}; const best=Object.keys(row).sort((x,y)=>row[y]-row[x])[0];
     return best&&row[best]>=2?{type:CT[best]}:{type:R(['bite','guard','taunt'])}; },
};
function fight(A,B,lv,s,M){ const band=rivalBand(lv); P=build(A,lv,null);E=build(B,rint(band[0],band[1]),null);turn=1;log=[];ev=[];over=false;let k=0;
  while(!over&&k<40){const before=E.hist[E.hist.length-1]||'^'; const pa=s(M); const ea=ai(E,P,pa); resolve(pa,ea);
   if(ea.type!=='ability'){ const r=M[before]=M[before]||{}; r[ea.type]=(r[ea.type]||0)+1; } k++;}
  return {win:verdict()==='YOU WIN', turns:turn}; }
function study(nd,n,lv){ const dogs=Array.from({length:nd},(_,i)=>rdog(i)); const res=[];
  for(const d of dogs){ AIM=aimNew(); let M={},w=0,t=0; for(let i=0;i<n;i++){ const r=fight(d,rdog(1e5+i),lv,strat.smart,M); w+=r.win; t+=r.turns; }
    res.push({d, rate:w/n, turns:t/n, kit:kitOf(d).map(x=>x.value+(x.kind==='active'?'*':'')).join(', ')}); }
  return res; }
function byActive(n,lv){ const out={}; const acts=DATA.traits.filter(t=>t.kind==='active'); acts.push(null);
  for(const a of acts){ let w=0,t=0; AIM=aimNew(); let M={};
    for(let i=0;i<n;i++){ if(i%60===0){AIM=aimNew();M={};} const d=rdog(i); d.traits=d.traits.filter(id=>{const x=DATA.traits.find(y=>y.id===id); return x.kind!=='active';});
      if(a){ d.traits=d.traits.filter(id=>!id.startsWith(a.layer)); d.traits.push(a.id); }
      const r=fight(d,rdog(1e5+i),lv,strat.smart,M); w+=r.win; }
    out[a?a.value:'(no active)']=w/n; }
  return out; }
function seq(n,lv,act,heatOn){ const RK={Common:0,Uncommon:1,Rare:2,Epic:3,Mythic:4};
  let w=0, cur=0, maxc=0; AIM=aimNew(); let M={};
  const d={id:'me',name:'me',rarity:'Rare',setMatch:0,set:null,unknown:[],traits:LAYERS.map(l=>DATA.traits.filter(t=>t.layer===l&&t.kind!=='active').sort((a,b)=>a.pieces-b.pieces)[Math.floor(DATA.traits.filter(t=>t.layer===l&&t.kind!=='active').length/2)].id)}; d.traits=d.traits.filter(id=>DATA.traits.find(y=>y.id===id).kind!=='active');
  if(act){ const a=DATA.traits.find(t=>t.value===act); d.traits=d.traits.filter(id=>!id.startsWith(a.layer)); d.traits.push(a.id); }
  for(let i=0;i<n;i++){ const h=heatOn&&typeof heatOf==='function'?heatOf(cur):0;
    let r=null; for(let k=0;k<2+h;k++){ const c=rdog(1e5+i*7+k); if(!r||RK[c.rarity]>RK[r.rarity]) r=c; }
    const band=heatOn?rivalBand(lv,cur):rivalBand(lv); P=build(d,lv,null); E=build(r,rint(Math.min(band[1],band[0]+h),band[1]),null); const HB=+(globalThis.HPB||0); E.maxHp+=HB*h; E.hp+=HB*h; turn=1;log=[];ev=[];over=false;let k=0;
    while(!over&&k<40){const before=E.hist[E.hist.length-1]||'^'; const pa=strat.smart(M); const ea=ai(E,P,pa); resolve(pa,ea); if(ea.type!=='ability'){const rr=M[before]=M[before]||{}; rr[ea.type]=(rr[ea.type]||0)+1;} k++;}
    const win=verdict()==='YOU WIN'; w+=win; cur=win?cur+1:0; maxc=Math.max(maxc,cur); }
  return {rate:w/n, maxc}; }
({study, byActive, seq});`;
const api = vm.runInContext(code, vm.createContext({console, HPB: process.env.HPB||0}));
if (process.env.SEQ){ for (const act of [null,'Lightning','Laser Red','Cake']) for (const h of [false,true]){ const r=api.seq(N,LV,act,h); console.log((act||'(none)').padEnd(10), h?'heat':'flat', (100*r.rate).toFixed(0)+'%', 'longest streak', r.maxc); } process.exit(0); }
if (process.env.BYACT){ const o=api.byActive(N,LV); for (const [k,v] of Object.entries(o).sort((a,b)=>b[1]-a[1])) console.log(k.padEnd(16),(100*v).toFixed(0)+'%'); process.exit(0); }
const res = api.study(+(process.argv[5] || 120), N, LV).sort((a, b) => b.rate - a.rate);
const pct = x => (100 * x).toFixed(0) + "%";
console.log("bond", LV, "dogs", res.length, "median", pct(res[res.length >> 1].rate), "top10%", pct(res[Math.floor(res.length * .1)].rate), "bottom10%", pct(res[Math.floor(res.length * .9)].rate));
for (const r of res.slice(0, 8)) console.log("TOP", pct(r.rate), r.d.rarity, "turns", r.turns.toFixed(1), "|", r.kit);
for (const r of res.slice(-4)) console.log("LOW", pct(r.rate), r.d.rarity, "|", r.kit);
