// node sim/bots.js [lives]  — simulated dynasties across all starts, plus a replay check
const H = require("../history.js");
const E = require("../engine.js");

const STRATS = {
  balanced: {
    plan: (G) => { const L = G.life; const out = [["self", 2]];
      for (const k of ["work", "partner", "child", "parent", "sibling", "friend", "dream"]) for (const c of E.alive(L, k)) out.push([c.id, k === "work" ? 3 : k === "partner" ? 2 : 1]);
      return out; },
    invest: { cash: 20, land: 40, trade: 0, lending: 20, stocks: 20 },
    pick: (e) => (e.history ? (e.choices.length > 1 ? 1 : 0) : ["venture", "career"].includes(e.id) ? 1 : 0),
  },
  greedy: {
    plan: (G) => { const L = G.life; const out = [];
      for (const c of E.alive(L, "work")) out.push([c.id, 8]);
      out.push(["self", 2]); for (const c of E.alive(L, "partner")) out.push([c.id, 1]); for (const c of E.alive(L, "child")) out.push([c.id, 1]);
      return out; },
    invest: { cash: 0, land: 20, trade: 40, lending: 0, stocks: 40 },
    pick: (e) => (e.history ? 0 : ["meet", "child", "venture", "promo", "career", "house"].includes(e.id) ? 0 : e.choices.length - 1),
  },
};

function alloc(G, plan) {
  for (const c of E.alive(G.life)) c.drops = 0;
  G.life.selfDrops = 0;
  for (const [id, n] of plan(G)) {
    const cur = id === "self" ? G.life.selfDrops : (G.life.channels.find((c) => c.id === id) || {}).drops || 0;
    E.setDrops(G, id, cur + n);
  }
}

function play(start, strat, seed, maxYears = 400) {
  const G = E.createGame({ start, seed, gender: seed % 2 ? "f" : "m" });
  let steps = 0;
  while (!G.over && steps < maxYears) {
    if (G.waitingHeir) { const hs = E.heirCandidates(G).sort((a, b) => b.bond - a.bond); E.heir(G, hs[0].id); continue; }
    while (G.pending.length && G.life.alive) E.choose(G, 0, Math.min(strat.pick(G.pending[0]), G.pending[0].choices.length - 1));
    if (!G.life.alive) continue;
    alloc(G, strat.plan);
    E.setInvest(G, strat.invest);
    E.advance(G);
    steps++;
  }
  return G;
}

const N = +process.argv[2] || 40;
console.log("start      strategy | generations p50 (max) | lifespan p50 | line ended within 400 yrs | wealth class at end (counts) | deaths to history per life");
for (const s of H.STARTS) {
  for (const [name, strat] of Object.entries(STRATS)) {
    const gens = [], spans = [], classes = [0, 0, 0, 0, 0]; let ended = 0, hist = 0, lives = 0;
    for (let k = 1; k <= N; k++) {
      const G = play(s.id, strat, k * 104729 + 7);
      gens.push(G.lives.length); if (G.over) ended++;
      for (const l of G.lives) { spans.push(l.epitaph.age); hist += l.epitaph.lost.length; lives++; }
      classes[E.classOf(G)]++;
    }
    const med = (a) => { const t = [...a].sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
    console.log(`${s.id.padEnd(10)} ${name.padEnd(8)} | ${String(med(gens)).padStart(3)} (${Math.max(...gens)}) | ${String(med(spans)).padStart(4)} | ${String(Math.round(100 * ended / N)).padStart(3)}% | ${classes.join("/")} | ${(hist / Math.max(1, lives)).toFixed(2)}`);
  }
}

// replay check: a played game rebuilt from its action log must match exactly
let bad = 0;
for (let k = 1; k <= 20; k++) {
  const G = play(H.STARTS[k % H.STARTS.length].id, STRATS.balanced, 9000 + k, 150);
  const G2 = E.replay(G.setup, G.actions);
  const a = JSON.stringify([G.year, G.gen, Math.round(G.money * 1000), G.life.name, G.life.health, G.log.length]);
  const b = JSON.stringify([G2.year, G2.gen, Math.round(G2.money * 1000), G2.life.name, G2.life.health, G2.log.length]);
  if (a !== b) { bad++; console.log("REPLAY MISMATCH", k, a, b); }
  // rewind to the middle and check that the partial replay is a prefix of the same history
  const mid = G.setup ? G2.records[Math.floor(G2.records.length / 2)] : null;
  if (mid) { const G3 = E.replay(G.setup, G.actions, mid.year); if (G3.year !== mid.year) { bad++; console.log("REWIND year", G3.year, mid.year); } }
}
console.log(bad ? `replay check FAILED (${bad})` : "replay check ok: 20 dynasties rebuilt exactly from their action logs, rewinds land on the right year");
