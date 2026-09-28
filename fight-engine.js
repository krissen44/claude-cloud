/**
 * The fight engine on the server.
 *
 * There is exactly one engine: the one in public/index.html. Its pure sections
 * (fighters, kits, damage, resolve, verdict, the seeded resolver, defFromMeta)
 * are marked with //@engine … //@/engine. This loads those sections into a
 * sandbox, so a Fight Club duel resolves on the server with the same code and
 * the same seed as in both browsers — they can never disagree.
 */
import fs from "node:fs";
import vm from "node:vm";

export function loadEngine(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const parts = [...html.matchAll(/\/\/@engine[^\n]*\n([\s\S]*?)\/\/@\/engine/g)].map(m => m[1]);
  if (parts.length < 8) throw new Error(`engine sections missing in ${htmlPath} (found ${parts.length})`);
  const code =
    // what the sections expect from the page, minus anything visual
    "let clubMode = true; const SAVE = { bump(){} };\n" +
    parts.join("\n") +
    "\nsimulating = true;\n" +
    "({ build, resolveSeeded, moveOf, verdict, defFromMeta, LBL," +
    "   get: () => ({ P, E, turn, over, log, ev })," +
    "   set: (s) => { P = s.P; E = s.E; turn = s.turn; over = s.over; log = []; ev = []; } })";
  const api = vm.runInContext(code, vm.createContext({ console }), { filename: "engine (public/index.html)" });
  const copy = (o) => JSON.parse(JSON.stringify(o));
  return {
    defFromMeta: (nft, meta) => api.defFromMeta(nft, meta),
    /** Start state of a duel: A on the left (P), B on the right (E). */
    start(defA, lvlA, defB, lvlB) {
      return copy({ P: api.build(defA, lvlA, null), E: api.build(defB, lvlB, null), turn: 1, over: false });
    },
    /** One round from a stored state, both moves and a seed → the next state and its result. */
    round(state, moveA, moveB, seed) {
      api.set(copy(state));
      const s0 = api.get();
      api.resolveSeeded(api.moveOf(s0.P, moveA), api.moveOf(s0.E, moveB), seed);
      const s = api.get();
      const next = copy({ P: s.P, E: s.E, turn: s.turn, over: s.over });
      // verdict() is written from A's side: 'YOU WIN' = A won
      return { state: next, verdict: s.over ? api.verdict() : null };
    },
  };
}
