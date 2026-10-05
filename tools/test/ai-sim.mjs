import fs from "node:fs"; import vm from "node:vm";
// Opponent AI benchmark: player strategies vs the AI at bond 1/5/10, run on the engine sections of the page.
// node tools/test/ai-sim.mjs [path/to/index.html] [fights per cell]
const file = process.argv[2] || new URL("../../public/index.html", import.meta.url).pathname, N = +(process.argv[3] || 1500);
const html = fs.readFileSync(file,"utf8");
const parts=[...html.matchAll(/\/\/@engine[^\n]*\n([\s\S]*?)\/\/@\/engine/g)].map(m=>m[1]);
const code="let clubMode=false; const SAVE={bump(){}};\n"+parts.join("\n")+`
const R=a=>a[Math.floor(Math.random()*a.length)];
const CT={bite:'guard', guard:'taunt', taunt:'bite'};
function guess(h){ // a human's simple read of a history: most frequent follower of the last move, else most frequent
  const sc={bite:0,guard:0,taunt:0}; if(!h.length) return null;
  for(let i=1;i<h.length;i++) if(h[i-1]===h[h.length-1]&&h[i] in sc) sc[h[i]]+=2;
  for(const m of h) if(m in sc) sc[m]+=.5;
  const best=Object.keys(sc).sort((a,b)=>sc[b]-sc[a])[0]; return sc[best]>0?best:null;
}
const ab=(p)=>{const a=P.actives.filter(x=>x.cost<=P.energy); return a.length&&Math.random()<p?{type:'ability',a:a[0]}:null;};
const S={
  random: ()=>ab(.4)||{type:R(['bite','guard','taunt'])},
  alwaysBite: ()=>({type:'bite'}),
  alternate: ()=>({type: turn%2?'bite':'guard'}),
  antiCounter: ()=>{ const x=ab(.5); if(x) return x; const pm=guess(E.hist); return pm?{type:CT[CT[pm]]}:{type:R(['bite','guard','taunt'])}; },
  // learns how the AI answers: what the AI played after my last move; counters that (across fights via M)
  adaptive: (M)=>{ const x=ab(.45); if(x) return x; const last=E.hist[E.hist.length-1]||'^'; const row=M[last]||{};
     const best=Object.keys(row).sort((a,b)=>row[b]-row[a])[0]; return best&&row[best]>=2?{type:CT[best]}:{type:R(['bite','guard','taunt'])}; },
};
function fight(defA,defB,lv,s,M){
  P=build(defA,lv,null);E=build(defB,Math.max(1,Math.min(10,lv+rint(-1,1))),null);turn=1;log=[];ev=[];over=false;let k=0;
  while(!over&&k<40){const before=E.hist[E.hist.length-1]||'^'; const pa=s(M); const ea=ai(E,P,pa); resolve(pa,ea);
    if(M&&ea.type!=='ability'){ const r=M[before]=M[before]||{}; r[ea.type]=(r[ea.type]||0)+1; } k++;}
  return verdict()==='YOU WIN';
}
function run(name,lv,n,F){ let w=0; let M={}; if(typeof aimNew==='function') AIM=aimNew(); 
  for(let i=0;i<n;i++){ if(i%60===0){ M={}; if(typeof aimNew==='function') AIM=aimNew(); } w+=fight(F[i%F.length],F[Math.floor(Math.random()*F.length)],lv,S[name],M)?1:0;} return w/n; }
({run,S,DATA});`;
const api=vm.runInContext(code,vm.createContext({console}));
const F=api.DATA.fighters;
const out=[];
for(const s of Object.keys(api.S)){ const row=[s.padEnd(12)]; for(const lv of [1,5,10]) row.push(("L"+lv+" "+(100*api.run(s,lv,N,F)).toFixed(0)+"%").padEnd(9)); out.push(row.join(" ")); }
console.log(out.join("\n"));
