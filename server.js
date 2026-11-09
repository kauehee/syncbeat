const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const COLORS = ['#38BDF8', '#FB7185', '#FBBF24', '#34D399', '#A78BFA', '#FB923C', '#22D3EE', '#F472B6'];
const MAX_PRODUCERS = 4;
const PROTO = 7; // versão do protocolo; o cliente confere ao entrar
const AUTO_PARAMS = { vol: [0, 1], pan: [-1, 1] }, MAX_AUTO = 64;

// ---- limites do projeto ----
const MAXLEN = 128, MAXARR = 2048, MAX_TRACKS = 12, MAX_SCENES = 16, MAX_NOTES = 512;
const MAX_SAMPLES = 8, MAX_B64 = 1100000, MAX_FX = 6, MAX_AUX = 4;
const INST = {                // instrumento -> tipo
  'saw-bass': 'synth', 'sub-bass': 'synth', 'square-lead': 'synth', 'pluck': 'synth',
  'pad': 'synth', 'organ': 'synth', 'bell': 'synth', 'epiano': 'synth',
  'fm-bass': 'synth', 'acid': 'synth', 'supersaw': 'synth', 'strings': 'synth', 'brass': 'synth', 'marimba': 'synth', 'flute': 'synth',
  'kit-808': 'drum', 'kit-punchy': 'drum', 'kit-lofi': 'drum', 'kit-trap': 'drum',
  'sample': 'sampler',
};
const DEF = { // [cutoff, release] padrão de cada timbre
  'saw-bass': [900, .1], 'sub-bass': [2000, .12], 'square-lead': [5000, .15], 'pluck': [6000, .3],
  'pad': [3000, 1], 'organ': [8000, .1], 'bell': [8000, .5], 'epiano': [6000, .4],
  'fm-bass': [1500, .12], 'acid': [9000, .08], 'supersaw': [8000, .2], 'strings': [5000, .5], 'brass': [7000, .15], 'marimba': [9000, .3], 'flute': [9000, .25],
  'kit-808': [20000, 0], 'kit-punchy': [20000, 0], 'kit-lofi': [20000, 0], 'kit-trap': [20000, 0], 'sample': [12000, 0],
};
// parâmetros de efeitos: [min, max, padrão]
const FXDEF = {
  eq: { low: [-12, 12, 0], mid: [-12, 12, 0], high: [-12, 12, 0] },
  comp: { thr: [-60, 0, -18], ratio: [1, 20, 4], gain: [0, 12, 0] },
  dist: { drive: [0, 1, .4], mix: [0, 1, .5] },
  filter: { type: [0, 2, 0], freq: [40, 16000, 2000], q: [.3, 12, 1] },
};
const AUXDEF = {
  reverb: { decay: [.3, 6, 2.4], tone: [800, 16000, 6000] },
  delay: { div: [1, 8, 3], fb: [0, .9, .38], tone: [500, 12000, 3500] },
};
const defaults = d => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v[2]]));
const clampP = (d, k, v) => { const n = +v, [a, b, f] = d[k]; return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : f; };

const server = http.createServer((req, res) => {
  let u = req.url.split('?')[0];
  if (u === '/healthz') return res.end('ok');
  if (u === '/' || /^\/r\/[\w-]+$/.test(u)) u = '/index.html';
  if (u === '/termos' || u === '/privacidade') u = '/legal.html';
  const f = path.join(PUB, path.normalize(u));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(d);
  });
});

const rooms = new Map(); // salas só em memória, somem quando o último sai
let nid = 1;
const cleanName = (v, fb) => String(v == null ? '' : v).replace(/[<>&"']/g, '').slice(0, 24).trim() || fb;
const stepMs = s => 15000 / s.bpm;
const nowStep = s => (Date.now() - s.startAt) / stepMs(s);

// ---- construtores ----
function mkClip(room, name, len = 16) { return { id: 'k' + (++room.kc), name: cleanName(name, ''), len, notes: [] }; }
function mkTrack(room, inst, name, sampleId = null) {
  const d = DEF[inst], n = ++room.tc;
  return { id: 't' + n, name: cleanName(name, 'Canal ' + n), inst, kind: INST[inst], sampleId,
    vol: 0.8, mute: false, solo: false, pan: 0, cutoff: d[0], release: d[1], ci: (n - 1) % 8,
    sends: {}, fx: [], clips: {}, arr: [], ev: [], autom: { vol: [], pan: [] } };
}
function mkAux(room, type, name) {
  return { id: 'x' + (++room.axc), type, name: cleanName(name, type === 'reverb' ? 'Reverb' : 'Delay'), vol: 0.9, mute: false, p: defaults(AUXDEF[type]) };
}
function setInst(room, tr, inst, sampleId) {
  const wasDrum = tr.kind === 'drum', d = DEF[inst];
  if (inst !== tr.inst) { tr.cutoff = d[0]; tr.release = d[1]; }
  tr.inst = inst; tr.kind = INST[inst];
  tr.sampleId = inst === 'sample' && room.samples.has(sampleId) ? sampleId : null;
  if (wasDrum !== (tr.kind === 'drum')) Object.values(tr.clips).forEach(c => { c.notes = []; }); // bateria usa linhas de peça
}
function newState(room) {
  const s = { bpm: 120, playing: false, startAt: 0, q: 16, arrStart: 0, loop: { on: false, s: 0, e: 128 }, scenes: [], tracks: [], aux: [] };
  for (let i = 0; i < 4; i++) s.scenes.push({ id: 'c' + (++room.nsc) });
  s.aux.push(mkAux(room, 'reverb'), mkAux(room, 'delay'));
  const [c1, c2] = s.scenes, [rv, dl] = s.aux;
  const add = (tr, clip, p, st, l = 1, v = 100) => clip.notes.push({ id: 'n' + nid++, s: st, l: tr.kind === 'drum' ? 1 : l, p, v });
  const drums = mkTrack(room, 'kit-808', 'Bateria'), bass = mkTrack(room, 'saw-bass', 'Baixo'), lead = mkTrack(room, 'pluck', 'Lead');
  // cena 1
  const dA = mkClip(room, 'Beat A', 32), bA = mkClip(room, 'Baixo A', 32), lA = mkClip(room, 'Lead A', 32);
  for (let x = 0; x < 32; x += 4) add(drums, dA, 0, x, 1, 118);
  for (let x = 4; x < 32; x += 8) add(drums, dA, 1, x, 1, 105);
  for (let x = 0; x < 32; x += 2) add(drums, dA, 3, x, 1, x % 4 ? 70 : 95);
  [[45, 0, 3], [45, 6, 2], [48, 10, 2], [43, 16, 3], [43, 22, 2], [46, 26, 2]].forEach(([p, st, l]) => add(bass, bA, p, st, l));
  [[69, 2, 1], [72, 6, 1], [76, 10, 2], [72, 14, 1], [67, 18, 1], [71, 22, 1], [74, 26, 2], [71, 30, 1]].forEach(([p, st, l], i) => add(lead, lA, p, st, l, 80 + (i % 3) * 14));
  // cena 2 (variação)
  const dB = mkClip(room, 'Beat B', 32), bB = mkClip(room, 'Baixo B', 32);
  [0, 3, 8, 11, 16, 19, 24, 27].forEach(x => add(drums, dB, 0, x, 1, 115));
  [4, 12, 20, 28].forEach(x => add(drums, dB, 1, x, 1, 108));
  [14, 30].forEach(x => add(drums, dB, 2, x, 1, 100));
  [6, 22].forEach(x => add(drums, dB, 4, x, 1, 85));
  for (let x = 0; x < 32; x += 2) add(drums, dB, 3, x, 1, 75);
  [[43, 0, 3], [43, 6, 2], [46, 10, 2], [41, 16, 3], [41, 22, 2], [44, 26, 2]].forEach(([p, st, l]) => add(bass, bB, p, st, l));
  drums.clips[c1.id] = dA; bass.clips[c1.id] = bA; lead.clips[c1.id] = lA;
  drums.clips[c2.id] = dB; bass.clips[c2.id] = bB;
  lead.sends[rv.id] = { l: 0.25, on: true, pre: false }; lead.sends[dl.id] = { l: 0.2, on: true, pre: false };
  lead.vol = 0.6;
  // arranjo de demonstração (8 compassos)
  const inst = (tr, clip, st, l) => tr.arr.push({ id: 'a' + (++room.ac), clip: clip.id, s: st, l });
  inst(drums, dA, 0, 64); inst(drums, dB, 64, 64);
  inst(bass, bA, 32, 32); inst(bass, bB, 64, 64);
  inst(lead, lA, 64, 64);
  s.tracks.push(drums, bass, lead);
  return s;
}

const PARAMS = {
  vol: v => Math.min(1, Math.max(0, +v) || 0),
  mute: v => !!v,
  solo: v => !!v,
  pan: v => Math.min(1, Math.max(-1, +v || 0)),
  cutoff: v => Math.min(20000, Math.max(100, +v) || 1000),
  release: v => Math.min(2, Math.max(0.03, +v) || 0.2),
  name: v => cleanName(v, 'Canal'),
};
const DRUM_PARAMS = ['vol', 'mute', 'solo', 'pan', 'name'];

function cleanNote(tr, clip, n) {
  if (!tr || !clip || !n || typeof n !== 'object') return null;
  const id = String(n.id || '');
  if (!/^[\w-]{1,24}$/.test(id)) return null;
  const s = n.s | 0, p = n.p | 0, drum = tr.kind === 'drum';
  const l = drum ? 1 : n.l | 0;
  const v = n.v === undefined ? 100 : Math.min(127, Math.max(1, n.v | 0));
  if (s < 0 || l < 1 || s + l > clip.len) return null; // a nota precisa caber no loop do clipe
  if (drum ? (p < 0 || p > 7) : (p < 24 || p > 96)) return null;
  return { id, s, l, p, v };
}

const send = (c, o) => c.ws.readyState === 1 && c.ws.send(JSON.stringify(o));
const bcast = (room, o, except) => room.clients.forEach(c => c !== except && send(c, o));
const pub = c => ({ id: c.id, name: c.name, role: c.role, color: c.color, mic: !!c.mic });
const producers = room => [...room.clients.values()].filter(c => c.role === 'producer').length;
let nextId = 1;

// ---- transporte ----
function transport(room) {
  const s = room.state;
  bcast(room, { type: 'transport', playing: s.playing, startAt: s.startAt, bpm: s.bpm, arrStart: s.arrStart, q: s.q, loop: s.loop,
    evs: Object.fromEntries(s.tracks.map(t => [t.id, t.ev])) });
}
function startTransport(s) {
  s.playing = true; s.startAt = Date.now() + 500 - s.arrStart * stepMs(s);
  const base = Math.floor(s.arrStart / 16) * 16; // clipes lançados recomeçam alinhados
  s.tracks.forEach(t => { const last = t.ev[t.ev.length - 1]; t.ev = last ? [{ sc: last.sc, at: base }] : []; });
}
function launchAt(s) { // passo em que o lançamento entra (quantizado); inicia o transporte se estiver parado
  if (!s.playing) { startTransport(s); return s.arrStart; }
  const ns = nowStep(s) + 150 / stepMs(s);
  return s.q > 0 ? Math.ceil(ns / s.q) * s.q : Math.ceil(ns);
}
function setEv(s, tr, sc, at) {
  const cur = nowStep(s);
  tr.ev = tr.ev.filter(e => e.at <= cur).slice(-1).concat([{ sc, at }]);
}

function arrPlace(tr, inst) { // sobrescreve o que estiver no mesmo trecho
  tr.arr = tr.arr.filter(a => a.id !== inst.id && (a.s >= inst.s + inst.l || a.s + a.l <= inst.s));
  tr.arr.push(inst); tr.arr.sort((a, b) => a.s - b.s);
}
const arrOk = (s, l) => Number.isInteger(s) && Number.isInteger(l) && s >= 0 && l >= 1 && s + l <= MAXARR;
const clipByKey = (tr, sc) => (tr ? tr.clips[String(sc)] : null);
const clipById = (tr, id) => Object.values(tr.clips).find(c => c.id === id);

function applyOp(room, c, op) {
  const s = room.state;
  if (!op || typeof op !== 'object') return;
  const tr = s.tracks.find(t => t.id === op.t);
  const out = (o, except) => bcast(room, { type: 'op', from: c.id, op: o }, except);
  switch (op.k) {
    // ----- canais -----
    case 'addTrack': {
      if (!INST[op.inst] || s.tracks.length >= MAX_TRACKS) return;
      const sid = op.inst === 'sample' && room.samples.has(op.sampleId) ? op.sampleId : null;
      const t = mkTrack(room, op.inst, op.name, sid);
      s.tracks.push(t);
      return out({ k: 'track', track: t });
    }
    case 'del': {
      if (!tr) return;
      s.tracks.splice(s.tracks.indexOf(tr), 1);
      return out({ k: 'del', t: tr.id });
    }
    case 'inst': {
      if (!tr || !INST[op.inst]) return;
      setInst(room, tr, op.inst, op.sampleId);
      return out({ k: 'track', track: tr });
    }
    case 'param': {
      if (!tr || !PARAMS[op.p]) return;
      if (tr.kind === 'drum' && !DRUM_PARAMS.includes(op.p)) return;
      tr[op.p] = PARAMS[op.p](op.v);
      return out({ k: 'param', t: tr.id, p: op.p, v: tr[op.p] }, c);
    }
    // ----- automação de parâmetros (curva de pontos ao longo do arranjo) -----
    case 'autoSet': {
      const lim = AUTO_PARAMS[op.param];
      if (!tr || !lim) return;
      const raw = (Array.isArray(op.points) ? op.points : []).slice(0, MAX_AUTO)
        .map(p => ({ s: Math.min(MAXARR, Math.max(0, p.s | 0)), v: Math.min(lim[1], Math.max(lim[0], +p.v)) }))
        .filter(p => Number.isFinite(p.v))
        .sort((a, b) => a.s - b.s);
      const pts = []; // remove pontos empilhados na mesma posição (fica o último)
      raw.forEach(p => { if (pts.length && pts[pts.length - 1].s === p.s) pts[pts.length - 1] = p; else pts.push(p); });
      tr.autom[op.param] = pts;
      return out({ k: 'autom', t: tr.id, param: op.param, points: pts }, c);
    }
    // ----- sends e canais auxiliares (retornos) -----
    case 'send': {
      const ax = s.aux.find(a => a.id === op.aux);
      if (!tr || !ax) return;
      const cur = tr.sends[ax.id] || { l: 0, on: true, pre: false };
      if (op.l !== undefined) cur.l = Math.min(1, Math.max(0, +op.l || 0));
      if (op.on !== undefined) cur.on = !!op.on;
      if (op.pre !== undefined) cur.pre = !!op.pre;
      tr.sends[ax.id] = cur;
      return out({ k: 'send', t: tr.id, aux: ax.id, send: cur }, c);
    }
    case 'auxAdd': {
      if (!AUXDEF[op.type] || s.aux.length >= MAX_AUX) return;
      s.aux.push(mkAux(room, op.type));
      return out({ k: 'aux', aux: s.aux });
    }
    case 'auxDel': {
      const i = s.aux.findIndex(a => a.id === op.id); if (i < 0) return;
      s.aux.splice(i, 1); s.tracks.forEach(t => { delete t.sends[op.id]; });
      return out({ k: 'aux', aux: s.aux });
    }
    case 'auxSet': {
      const ax = s.aux.find(a => a.id === op.id); if (!ax) return;
      if (op.vol !== undefined) ax.vol = Math.min(1, Math.max(0, +op.vol || 0));
      if (op.mute !== undefined) ax.mute = !!op.mute;
      if (op.name !== undefined) ax.name = cleanName(op.name, ax.name);
      if (op.key && AUXDEF[ax.type][op.key]) ax.p[op.key] = clampP(AUXDEF[ax.type], op.key, op.v);
      return out({ k: 'auxset', id: ax.id, vol: ax.vol, mute: ax.mute, name: ax.name, p: ax.p }, c);
    }
    // ----- efeitos inseridos no canal -----
    case 'fxAdd': {
      if (!tr || !FXDEF[op.type] || tr.fx.length >= MAX_FX) return;
      tr.fx.push({ id: 'f' + (++room.xc), type: op.type, on: true, p: defaults(FXDEF[op.type]) });
      return out({ k: 'fx', t: tr.id, fx: tr.fx });
    }
    case 'fxDel': {
      if (!tr) return;
      tr.fx = tr.fx.filter(f => f.id !== op.id);
      return out({ k: 'fx', t: tr.id, fx: tr.fx });
    }
    case 'fxSet': {
      const f = tr && tr.fx.find(x => x.id === op.id); if (!f) return;
      if (op.on !== undefined) f.on = !!op.on;
      if (op.key && FXDEF[f.type][op.key]) f.p[op.key] = clampP(FXDEF[f.type], op.key, op.v);
      return out({ k: 'fxset', t: tr.id, id: f.id, on: f.on, p: f.p }, c);
    }
    // ----- cenas e clipes -----
    case 'addScene': {
      if (s.scenes.length >= MAX_SCENES) return;
      s.scenes.push({ id: 'c' + (++room.nsc) });
      return out({ k: 'scenes', scenes: s.scenes });
    }
    case 'delScene': {
      if (s.scenes.length <= 1 || !s.scenes.some(x => x.id === op.sc)) return;
      s.scenes = s.scenes.filter(x => x.id !== op.sc);
      s.tracks.forEach(t => {
        delete t.clips[op.sc];
        t.arr = t.arr.filter(a => clipById(t, a.clip));
        t.ev = t.ev.map(e => (e.sc === op.sc ? { sc: null, at: e.at } : e));
      });
      return out({ k: 'state', state: s });
    }
    case 'newClip': {
      if (!tr || !s.scenes.some(x => x.id === op.sc) || tr.clips[op.sc]) return;
      tr.clips[op.sc] = mkClip(room, op.name, Math.min(MAXLEN, Math.max(1, op.len | 0 || 16)));
      return out({ k: 'track', track: tr });
    }
    case 'delClip': {
      const cl = clipByKey(tr, op.sc); if (!cl) return;
      delete tr.clips[op.sc];
      tr.arr = tr.arr.filter(a => a.clip !== cl.id);
      return out({ k: 'track', track: tr });
    }
    case 'clipProp': {
      const cl = clipByKey(tr, op.sc); if (!cl) return;
      if (op.name !== undefined) cl.name = cleanName(op.name, '');
      if (op.len !== undefined) { const v = op.len | 0; if (v >= 1 && v <= MAXLEN) cl.len = v; }
      return out({ k: 'track', track: tr });
    }
    case 'dupClip': { // duplica para a próxima cena livre (cria uma cena se preciso)
      const src = clipByKey(tr, op.sc); if (!src) return;
      let target = null;
      for (let j = s.scenes.findIndex(x => x.id === op.sc) + 1; j < s.scenes.length; j++) if (!tr.clips[s.scenes[j].id]) { target = s.scenes[j]; break; }
      let added = false;
      if (!target) { if (s.scenes.length >= MAX_SCENES) return; target = { id: 'c' + (++room.nsc) }; s.scenes.push(target); added = true; }
      const cp = mkClip(room, src.name, src.len);
      cp.notes = src.notes.map(n => ({ ...n, id: 'n' + nid++ }));
      tr.clips[target.id] = cp;
      return added ? out({ k: 'state', state: s, sel: { t: tr.id, sc: target.id } }) : out({ k: 'track', track: tr, sel: { t: tr.id, sc: target.id } });
    }
    case 'dbl': { // dobra o loop duplicando o conteúdo (×2 do Ableton)
      const cl = clipByKey(tr, op.sc); if (!cl || cl.len * 2 > MAXLEN) return;
      const copies = cl.notes.filter(n => n.s + n.l <= cl.len).map(n => ({ ...n, id: 'n' + nid++, s: n.s + cl.len }));
      const kept = cl.notes.filter(n => n.s < cl.len);
      if (kept.length + copies.length > MAX_NOTES) return;
      cl.notes = kept.concat(copies); cl.len *= 2;
      return out({ k: 'track', track: tr });
    }
    case 'nb': { // lote de edições de notas: del -> mod -> add
      const cl = clipByKey(tr, op.sc); if (!cl) return;
      const arr = a => (Array.isArray(a) ? a : []).slice(0, MAX_NOTES);
      const rm = new Set(arr(op.del).map(String)), o = { add: [], mod: [], del: [] };
      cl.notes = cl.notes.filter(n => { if (rm.has(n.id)) { o.del.push(n.id); return false; } return true; });
      for (const raw of arr(op.mod)) {
        const cur = cl.notes.find(x => x.id === String(raw && raw.id)), n = cur && cleanNote(tr, cl, raw);
        if (n) { Object.assign(cur, n); o.mod.push(n); }
      }
      for (const raw of arr(op.add)) {
        const n = cleanNote(tr, cl, raw);
        if (n && cl.notes.length < MAX_NOTES && !cl.notes.some(x => x.id === n.id)) { cl.notes.push(n); o.add.push(n); }
      }
      if (o.add.length || o.mod.length || o.del.length) out({ k: 'nb', t: tr.id, sc: String(op.sc), ...o }, c);
      return;
    }
    // ----- lançamento de clipes (Sessão) -----
    case 'launch': {
      if (!tr || (op.sc !== null && !clipByKey(tr, op.sc))) return;
      setEv(s, tr, op.sc === null ? null : String(op.sc), launchAt(s));
      return transport(room);
    }
    case 'launchScene': {
      if (!s.scenes.some(x => x.id === op.sc)) return;
      const at = launchAt(s);
      s.tracks.forEach(t => { if (t.clips[op.sc]) setEv(s, t, op.sc, at); });
      return transport(room);
    }
    case 'stopAll': {
      const at = launchAt(s);
      s.tracks.forEach(t => setEv(s, t, null, at));
      return transport(room);
    }
    case 'back': s.tracks.forEach(t => { t.ev = []; }); return transport(room);
    // ----- arranjo -----
    case 'arrAdd': {
      const cl = tr && clipById(tr, op.clip); const st = op.s | 0, l = op.l | 0;
      if (!cl || !arrOk(st, l) || tr.arr.length >= 256) return;
      arrPlace(tr, { id: 'a' + (++room.ac), clip: cl.id, s: st, l });
      return out({ k: 'arr', t: tr.id, arr: tr.arr });
    }
    case 'arrMod': {
      const cur = tr && tr.arr.find(a => a.id === op.id), st = op.s | 0, l = op.l | 0;
      if (!cur || !arrOk(st, l)) return;
      arrPlace(tr, { id: cur.id, clip: cur.clip, s: st, l });
      return out({ k: 'arr', t: tr.id, arr: tr.arr });
    }
    case 'arrDel': {
      if (!tr) return;
      tr.arr = tr.arr.filter(a => a.id !== op.id);
      return out({ k: 'arr', t: tr.id, arr: tr.arr });
    }
    case 'arrStart': {
      const v = op.v | 0; if (v < 0 || v > MAXARR) return;
      s.arrStart = v; return transport(room);
    }
    case 'loop': {
      const a = op.s | 0, b = op.e | 0;
      if (a < 0 || b <= a || b > MAXARR) return;
      s.loop = { on: !!op.on, s: a, e: b }; return transport(room);
    }
    // ----- transporte -----
    case 'quant': if ([0, 4, 16].includes(op.v)) { s.q = op.v; transport(room); } return;
    case 'bpm': {
      const nb = Math.min(200, Math.max(60, op.v | 0)), now = Date.now();
      if (s.playing) { // mantém a posição atual ao mudar o andamento
        const pos = (now - s.startAt) / (15000 / s.bpm);
        s.startAt = now - pos * (15000 / nb);
      }
      s.bpm = nb;
      return transport(room);
    }
    case 'play': if (!s.playing) startTransport(s); return transport(room);
    case 'stop': s.playing = false; return transport(room);
  }
}

const wss = new WebSocketServer({ server, maxPayload: 1.5 * 1024 * 1024 });

wss.on('connection', ws => {
  const c = { ws, id: String(nextId++), name: 'Anônimo', role: 'listener', color: COLORS[0], room: null, mic: false };
  let alive = true;
  ws.on('pong', () => alive = true);
  const hb = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 20000);

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'ping') return send(c, { type: 'pong', t0: m.t0, ts: Date.now() });

    if (m.type === 'join' && !c.room) {
      const id = String(m.room || '');
      if (!/^[\w-]{3,32}$/.test(id)) return send(c, { type: 'error', msg: 'Código de sala inválido (3–32 letras/números).' });
      let room = rooms.get(id);
      if (!room) {
        room = { id, clients: new Map(), hostId: c.id, samples: new Map(), tc: 0, sc: 0, kc: 0, nsc: 0, ac: 0, xc: 0, axc: 0 };
        room.state = newState(room);
        rooms.set(id, room);
      }
      c.name = cleanName(m.name, 'Anônimo');
      c.room = room;
      c.color = COLORS[(room.clients.size + Number(c.id)) % COLORS.length];
      c.role = producers(room) < MAX_PRODUCERS ? 'producer' : 'listener';
      room.clients.set(c.id, c);
      send(c, { type: 'welcome', v: PROTO, id: c.id, room: id, state: room.state, hostId: room.hostId, me: pub(c),
        peers: [...room.clients.values()].filter(x => x !== c).map(pub) });
      room.samples.forEach(sm => send(c, { type: 'sample', sample: sm }));
      return bcast(room, { type: 'peer-join', peer: pub(c) }, c);
    }

    const room = c.room; if (!room) return;
    switch (m.type) {
      case 'op':
        if (c.role === 'producer') applyOp(room, c, m.op);
        break;
      case 'mic':
        c.mic = !!m.on; bcast(room, { type: 'mic', id: c.id, on: c.mic }, c);
        break;
      case 'sample': { // sample enviado por um produtor fica só na memória da sala
        if (c.role !== 'producer') return;
        const data = String(m.data || '');
        if (!data || data.length > MAX_B64) return send(c, { type: 'error', msg: 'Sample grande demais (máx. ~800 KB).' });
        if (room.samples.size >= MAX_SAMPLES) return send(c, { type: 'error', msg: 'Limite de ' + MAX_SAMPLES + ' samples por sala.' });
        const sm = { id: 's' + (++room.sc), name: cleanName(m.name, 'sample'), data };
        room.samples.set(sm.id, sm);
        bcast(room, { type: 'sample', sample: sm });
        const tr = room.state.tracks.find(t => t.id === m.forTrack);
        if (tr) {
          setInst(room, tr, 'sample', sm.id);
          bcast(room, { type: 'op', from: c.id, op: { k: 'track', track: tr } });
        }
        break;
      }
      case 'role': {
        if (c.id !== room.hostId) return;
        const t = room.clients.get(String(m.id)); if (!t) return;
        const role = m.role === 'producer' ? 'producer' : 'listener';
        if (role === 'producer' && t.role !== 'producer' && producers(room) >= MAX_PRODUCERS) return send(c, { type: 'error', msg: 'Máximo de 4 produtores.' });
        t.role = role;
        bcast(room, { type: 'role', id: t.id, role });
        break;
      }
      case 'chat': {
        const text = String(m.text || '').slice(0, 300).trim();
        if (text) bcast(room, { type: 'chat', from: c.id, name: c.name, color: c.color, text, ts: Date.now() }, c);
        break;
      }
      case 'signal': {
        const t = room.clients.get(String(m.to));
        if (t) send(t, { type: 'signal', from: c.id, data: m.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    clearInterval(hb);
    const room = c.room; if (!room) return;
    room.clients.delete(c.id);
    if (!room.clients.size) return rooms.delete(room.id);
    if (room.hostId === c.id) room.hostId = room.clients.keys().next().value;
    bcast(room, { type: 'peer-leave', id: c.id, hostId: room.hostId });
  });
});

server.listen(PORT, () => console.log('SyncBeat Studio em http://localhost:' + PORT));
