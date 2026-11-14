/*
 * Life2 — the narrator and the painter.
 *
 * Rule one: the AI tells the life, it never decides it. The engine produces a small
 * fact sheet for each year; the narrator may only use what is on it. Every narration is
 * checked: if it names a person who isn't on the sheet, it is thrown away and re-rolled,
 * and after two failures the written template is used instead.
 *
 * Backends, all local, no paid API:
 *   narrator: templates | ollama (http://localhost:11434) | openai-compatible local server
 *             (llama.cpp, LM Studio...) | webllm (in the browser, WebGPU, experimental)
 *   painter:  none | local (local/painter_server.py, SDXL-Turbo on your GPU)
 *
 * Results are cached in the browser (IndexedDB) by save, year and variant, so a re-roll
 * makes a new variant and going back shows the old one.
 */
(function (root) {
  "use strict";
  const H = root.History, E = root.Engine;

  // ---------------------------------------------------------------- settings
  const DEFAULTS = {
    narrator: "templates", ollamaUrl: "http://localhost:11434", ollamaModel: "qwen2.5:7b",
    openaiUrl: "http://localhost:8080", openaiModel: "local", webllmModel: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    painter: "none", painterUrl: "http://localhost:7861", paintEvery: "milestones",
  };
  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem("life2.ai") || "{}")); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  let S = loadSettings();
  function saveSettings(s) { S = Object.assign({}, S, s); try { localStorage.setItem("life2.ai", JSON.stringify(S)); } catch (e) {} }

  // ---------------------------------------------------------------- cache (IndexedDB)
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      try {
        const r = indexedDB.open("life2", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("media");
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  async function cacheGet(key) {
    const d = await db(); if (!d) return null;
    return new Promise((res) => { try { const q = d.transaction("media").objectStore("media").get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch (e) { res(null); } });
  }
  async function cachePut(key, val) {
    const d = await db(); if (!d) return;
    return new Promise((res) => { try { const t = d.transaction("media", "readwrite"); t.objectStore("media").put(val, key); t.oncomplete = res; t.onerror = res; } catch (e) { res(); } });
  }
  async function cacheDropPrefix(prefix, fromYear) {
    const d = await db(); if (!d) return;
    return new Promise((res) => {
      try {
        const t = d.transaction("media", "readwrite"), st = t.objectStore("media");
        const q = st.openCursor();
        q.onsuccess = () => {
          const c = q.result; if (!c) return;
          const k = String(c.key);
          if (k.startsWith(prefix)) { const y = +k.split(":")[2]; if (fromYear == null || y >= fromYear) c.delete(); }
          c.continue();
        };
        t.oncomplete = res; t.onerror = res;
      } catch (e) { res(); }
    });
  }

  // ---------------------------------------------------------------- the written narrator (always available)
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function templateNarration(f, variant) {
    const R = E.rng(hash(f.year + f.name + (variant || 0)));
    const pick = (a) => a[Math.floor(R() * a.length)];
    const out = [];
    if (f.history.length) out.push(`${f.year}. ${f.history[0]}.`);
    const lines = f.happened.filter((l) => !/^You are 18/.test(l));
    for (const l of lines.slice(0, 2)) out.push(l);
    const mood = {
      loved: ["The house is loud in the evenings.", "Someone always saves you a seat.", "There is a hand on your shoulder more often than not."],
      "getting by": ["The days are full and mostly the same.", "Work, supper, sleep.", "Nothing is wrong, exactly."],
      lonely: ["The evenings are long.", "You eat standing up, most days.", "No one asks how the day went."],
    }[f.warmth];
    if (out.length < 3) out.push(pick(mood));
    if (f.health === "failing" && out.length < 4) out.push(pick(["Your body is slower than it was.", "The stairs are harder this year."]));
    if (!out.length) out.push(`${f.year}. You are ${f.age}. ${pick(mood)}`);
    return out.join(" ");
  }

  // ---------------------------------------------------------------- the language-model narrator
  const SYSTEM = [
    "You are the narrator of a life-simulation game. You write the year that just passed, for the player, in second person, present tense.",
    "Write 2 to 4 short sentences, at most 70 words. One concrete, physical detail from the era and place. Plain and unsentimental; let the facts carry the feeling.",
    "Use ONLY the facts given. Never invent a named person, a birth, a death, an illness, money, or an event that is not in the facts. You may leave facts out.",
    "No anachronisms: objects, food, clothing and work must fit the year and place.",
    "Output only the narration: no title, no quotes, no lists, no notes.",
  ].join(" ");

  function userPrompt(f, prev) {
    const sheet = {
      year: f.year, place: f.place, you: `${f.name}, a ${f.age}-year-old ${f.gender}, ${f.profession}, ${f.class}, ${f.wealth}`,
      health: f.health, heart: f.warmth, world: f.history, what_happened: f.happened,
      people: f.people.map((p) => `${p.name} (${p.relation}; bond ${p.bond}${p.far ? "; far away" : ""})`),
    };
    return (prev && prev.length ? "The two previous years, for continuity:\n" + prev.join("\n") + "\n\n" : "") +
      "Facts for this year:\n" + JSON.stringify(sheet, null, 1) + "\n\nWrite the year.";
  }

  // names the narrator is not allowed to bring in from nowhere
  const ALLNAMES = new Set([].concat(...Object.values(H.NAMES).map((b) => b.m.concat(b.f))));
  function guard(text, f) {
    if (!text || text.length < 20) return false;
    if (text.split(/\s+/).length > 110) return false;
    const allowed = new Set([f.name.split(" ")[0], f.name.split(" ").slice(-1)[0]].concat(f.people.map((p) => p.name)));
    const caps = text.match(/\b[A-ZÄÖÅÜ][a-zäöåüé]+\b/g) || [];
    for (const w of caps) if (ALLNAMES.has(w) && !allowed.has(w)) return false;
    return true;
  }
  function clean(t) {
    return String(t || "").replace(/^["'\s]+|["'\s]+$/g, "").replace(/^(Narration|Year)\s*:\s*/i, "").replace(/\n+/g, " ").trim();
  }

  async function callOllama(sys, user, seed) {
    const r = await fetch(S.ollamaUrl.replace(/\/$/, "") + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: S.ollamaModel, stream: false, messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        options: { temperature: 0.85, seed, num_predict: 180 } }),
    });
    if (!r.ok) throw new Error("ollama " + r.status);
    const j = await r.json();
    return j.message && j.message.content;
  }
  async function callOpenAI(sys, user, seed) {
    const r = await fetch(S.openaiUrl.replace(/\/$/, "") + "/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: S.openaiModel, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0.85, seed, max_tokens: 180 }),
    });
    if (!r.ok) throw new Error("llm " + r.status);
    const j = await r.json();
    return j.choices && j.choices[0] && j.choices[0].message.content;
  }
  let webllm = null, webllmLoading = null;
  async function callWebLLM(sys, user, seed, onProgress) {
    if (!webllm) {
      if (!navigator.gpu) throw new Error("This browser has no WebGPU.");
      webllmLoading = webllmLoading || (async () => {
        const mod = await import("https://esm.run/@mlc-ai/web-llm");
        webllm = await mod.CreateMLCEngine(S.webllmModel, { initProgressCallback: (p) => onProgress && onProgress(p.text) });
      })();
      await webllmLoading;
    }
    const r = await webllm.chat.completions.create({ messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0.85, seed, max_tokens: 180 });
    return r.choices[0].message.content;
  }

  // the one entry point: text for a year (cached), never blocks the game
  async function narrate(key, f, prev, variant, onProgress) {
    const ck = key + ":" + (variant || 0) + ":text";
    const hit = await cacheGet(ck);
    if (hit) return hit;
    let text = null, source = "template";
    if (S.narrator !== "templates") {
      const call = S.narrator === "ollama" ? callOllama : S.narrator === "openai" ? callOpenAI : callWebLLM;
      for (let k = 0; k < 2 && !text; k++) {
        try {
          const t = clean(await call(SYSTEM, userPrompt(f, prev), hash(key) + 7919 * ((variant || 0) * 3 + k), onProgress));
          if (guard(t, f)) { text = t; source = S.narrator; }
        } catch (e) { if (onProgress) onProgress("Narrator unavailable: " + e.message); break; }
      }
    }
    if (!text) text = templateNarration(f, variant);
    const val = { text, source };
    await cachePut(ck, val);
    return val;
  }

  // ---------------------------------------------------------------- the painter
  const STYLE = "gouache painting, picture-book illustration, visible brush texture, soft edges, muted earthy palette, quiet composition, no text, no letters";
  const NEG = "text, letters, watermark, signature, photo, 3d render, deformed hands, extra fingers, gore, nudity";

  function personDesc(look, age, gender) {
    const who = age < 3 ? "a baby" : age < 13 ? `a ${age}-year-old ${gender === "m" ? "boy" : "girl"}` : `a ${age}-year-old ${gender === "m" ? "man" : "woman"}`;
    if (!look || age < 3) return who;
    const hair = age > 65 ? "grey " + look.hair.replace(/ hair$/, "") + " hair" : look.hair;
    return `${who} with ${hair}, ${look.build}, ${look.detail}`;
  }

  // what to paint for a milestone, in words
  function scene(G, m) {
    const life = G.life;
    const look = H.REGIONS[m.place || G.region].look(m.year);
    const me = personDesc(life.look, m.year - life.born, life.gender);
    const other = (name) => {
      const c = life.channels.find((x) => x.name === name);
      if (!c) return name ? "another person" : "";
      const a = c.kind === "child" ? m.year - c.birthYear : c.theirAge != null ? c.theirAge - (G.year - m.year) : 30;
      return personDesc(c.look, Math.max(0, a), c.gender);
    };
    const warm = life.warmth > 55 ? "warm golden lamplight, a lived-in cluttered room" : life.warmth > 30 ? "plain daylight, an ordinary room" : "cold blue-grey light, a bare and empty room, long shadows";
    const s = {
      begin: `${me} standing at the door of the family home at dawn, about to leave`,
      partner: `${me} and ${other(m.who[1])} together, close, early in their life together`,
      birth: `${me} holding a newborn baby, tired and amazed`,
      house: `${me} in front of their own house for the first time`,
      migration: `${me} with a bundle and a trunk, leaving home on a long journey, looking back`,
      war: `${me} come home from war, thin, in a worn uniform of the period, at the kitchen door`,
      quiet: `${me} alone at a kitchen table, the house empty around them`,
      rise: `${me} and family in fine clothes of the period, in a well-furnished room`,
      fall: `${me} and family loading their few belongings onto a cart, leaving a better house`,
      widowed: `${me} alone beside an empty chair`,
      heir: `${me}, the new head of the family, standing where their parent used to stand`,
      death: m.funeral ? `a funeral of the period, ${Math.min(30, m.funeral)} mourners at a grave` : "a single fresh grave in a nearly empty graveyard, no mourners",
      history: { plague: "a town street during an epidemic, shutters closed, a cart for the dead in the distance",
        war: "soldiers of the period marching through a village, women and children watching from doorways",
        famine: "a nearly empty table, thin bread, a family looking at it",
        econ: "a worried family counting coins and papers at a table by lamplight",
        boom: "a busy street full of new things and people in work clothes",
        displacement: "families with carts and bundles on a long road",
        disaster: "smoke over the rooftops of a town, people with buckets",
        migration: "a crowded harbour, a ship, people with trunks",
        flavor: "people gathered in a town square talking about the news" }[m.type] || "a town square",
    }[m.kind];
    if (!s) return null;
    return { prompt: `${s}. Setting: ${look}. ${m.kind === "death" || m.kind === "history" ? "" : warm + ". "}${STYLE}`,
      negative: NEG, seed: ((life.look && life.look.seed) || 1) ^ hash(m.kind + m.year) };
  }

  async function paint(key, G, m, variant) {
    if (S.painter === "none") return null;
    const ck = key + ":" + (variant || 0) + ":img";
    const hit = await cacheGet(ck);
    if (hit) return hit;
    const sc = scene(G, m);
    if (!sc) return null;
    const r = await fetch(S.painterUrl.replace(/\/$/, "") + "/paint", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: sc.prompt, negative: sc.negative, seed: (sc.seed + 104729 * (variant || 0)) >>> 0, width: 768, height: 512 }),
    });
    if (!r.ok) throw new Error("painter " + r.status);
    const j = await r.json();
    const val = { img: j.image, prompt: sc.prompt };
    await cachePut(ck, val);
    return val;
  }

  async function test() {
    const out = {};
    if (S.narrator === "ollama") { try { const r = await fetch(S.ollamaUrl.replace(/\/$/, "") + "/api/tags"); out.narrator = r.ok ? "Ollama answered." : "Ollama: HTTP " + r.status; } catch (e) { out.narrator = "Can't reach Ollama at " + S.ollamaUrl + ". Is it running with OLLAMA_ORIGINS set?"; } }
    else if (S.narrator === "openai") { try { const r = await fetch(S.openaiUrl.replace(/\/$/, "") + "/v1/models"); out.narrator = r.ok ? "Local model server answered." : "HTTP " + r.status; } catch (e) { out.narrator = "Can't reach " + S.openaiUrl; } }
    else if (S.narrator === "webllm") out.narrator = navigator.gpu ? "WebGPU available. The model downloads on first use (about 1 GB)." : "This browser has no WebGPU.";
    else out.narrator = "Written templates.";
    if (S.painter === "local") { try { const r = await fetch(S.painterUrl.replace(/\/$/, "") + "/health"); out.painter = r.ok ? "Painter answered: " + ((await r.json()).model || "ok") : "HTTP " + r.status; } catch (e) { out.painter = "Can't reach the painter at " + S.painterUrl + "."; } }
    else out.painter = "No pictures.";
    return out;
  }

  const api = { get settings() { return S; }, saveSettings, narrate, paint, scene, templateNarration, guard, cacheGet, cachePut, cacheDropPrefix, test, DEFAULTS };
  root.AI = api;
})(typeof window !== "undefined" ? window : globalThis);
