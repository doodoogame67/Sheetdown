// Sheetdown content script: spreadsheet UI + damage calc over Pokemon Showdown.
import {
  getGen, formatIdOf, toID, speciesOf, guessSet, buildMine, buildFoe, buildField,
  calcMove, moveData, allMoveNames, speedOf, speedRange, weatherName, terrainName,
} from './calc.js';
import { formatLog } from './log.js';

const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
const TAG = 'sheetdown';
const FAKE_TITLE = 'Q3_Forecast_FINAL_v2.xlsx';
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#1d6b40"/>' +
  '<path d="M3 4h10M3 8h10M3 12h10M6 3v10M10 3v10" stroke="#fff" stroke-width="1.2"/></svg>'
);

// ---------------------------------------------------------------- state
const S = {
  snap: null,
  tab: 'summary',
  on: true,
  panic: false,
  sel: { r: 0, c: 0 },
  rooms: {}, // per-room UI state
  sets: {}, // formatid -> data | null | 'loading'
  lobby: { format: '', team: 0, searching: false, searchedAt: 0 },
  opts: { mute: true, instant: true },
  pointerDown: false,
  moveOv: {}, // user-picked moves for opposing Pokemon: key -> [m1..m4]
  renderWanted: false,
  status: '',
  statusAt: 0,
  cells: [], // last rendered model
  knownBattles: new Set(),
};

const roomState = (id) => {
  if (!S.rooms[id]) S.rooms[id] = { sentRqid: null, sent: '', pending: [], flags: {}, preview: [], rqid: null, tabName: '' };
  return S.rooms[id];
};

const setStatus = (t) => { S.status = t; S.statusAt = Date.now(); };

// ---------------------------------------------------------------- bridge
const toPage = (type, payload) => window.postMessage({ source: TAG + '-content', type, payload }, '*');
const send = (msg, roomid) => toPage('send', { msg, roomid });

const injectPage = () => {
  const s = document.createElement('script');
  s.src = api.runtime.getURL('page.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
};

window.addEventListener('message', (ev) => {
  // no ev.source === window check: in Firefox the content-script Xray wrapper can fail that identity test
  if (!ev.data || ev.data.source !== TAG + '-page') return;
  if (ev.data.type === 'snapshot') {
    try { S.snap = JSON.parse(ev.data.json); } catch (e) { return; }
    onSnapshot();
  }
});

// ---------------------------------------------------------------- storage / sets
const loadOpts = async () => {
  try {
    const o = await api.storage.local.get(['on', 'opts', 'lobby']);
    if (typeof o.on === 'boolean') S.on = o.on;
    if (o.opts) Object.assign(S.opts, o.opts);
    if (o.lobby) Object.assign(S.lobby, { format: o.lobby.format || '', team: o.lobby.team || 0 });
  } catch (e) { /* defaults */ }
};
const saveOpts = () => {
  try { api.storage.local.set({ on: S.on, opts: S.opts, lobby: { format: S.lobby.format, team: S.lobby.team } }); } catch (e) { /* ignore */ }
};

const isRandom = (fid) => /random/.test(fid);
const setsFor = (fid, gen) => {
  if (!fid) return null;
  const v = S.sets[fid];
  if (v === undefined) {
    S.sets[fid] = 'loading';
    api.runtime.sendMessage({ type: 'getSets', formatid: fid, gen, random: isRandom(fid) })
      .then((res) => { S.sets[fid] = (res && res.data) || null; render(); })
      .catch(() => { S.sets[fid] = null; });
    return null;
  }
  return v === 'loading' ? null : v;
};

// ---------------------------------------------------------------- helpers
const COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const fmtPct = (x) => (x === undefined || x === null || Number.isNaN(x) ? '' : (Math.round(x * 10) / 10).toFixed(1));
const hpPct = (p) => (p && p.maxhp ? Math.round((p.hp / p.maxhp) * 1000) / 10 : 0);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const boostStr = (b) => Object.entries(b || {}).filter(([, v]) => v).map(([k, v]) => `${cap(k)}${v > 0 ? '+' : ''}${v}`).join(' ');
const sideCondStr = (side) => Object.values((side && side.sideConditions) || {})
  .map(c => (c.levels > 1 ? `${c.name.replace(/^move: /, '')} x${c.levels}` : c.name.replace(/^move: /, ''))).join(', ');
const nameFromIdent = (id) => (id || '').replace(/^p\d[a-z]?: /, '');
const cell = (v, extra) => ({ v: v === undefined || v === null ? '' : v, ...(extra || {}) });
// "guaranteed OHKO after Stealth Rock" -> "OHKO 100%", "43.8% chance to 2HKO" -> "2HKO 43.8%"
const shortKO = (t) => {
  if (!t) return '';
  let m = /guaranteed (\w+)/.exec(t);
  if (m) return `${m[1]} 100%`;
  m = /([\d.]+)% chance to (\w+)/.exec(t);
  if (m) return `${m[2]} ${m[1]}%`;
  m = /possible (\w+)/.exec(t);
  if (m) return `${m[1]} ?`;
  return t;
};
const koClass = (c) => (!c ? '' : /guaranteed OHKO/.test(c) ? 'ko1' : /OHKO/.test(c) ? 'ko1p' : /2HKO/.test(c) ? 'ko2' : '');
const dmgCell = (res, act) => {
  if (!res) return cell('');
  if (res.error) return cell('#VALUE!', { cls: 'err', tip: res.error, act });
  if (res.status) return cell('—', { cls: 'num dim', act, fx: `=STATUS("${res.name}")` });
  const txt = `${fmtPct(res.minPct)}-${fmtPct(res.maxPct)}%`;
  const heat = Math.min(1, (res.maxPct || 0) / 100);
  return cell(txt, {
    cls: 'num dmg ' + koClass(res.ko),
    heat,
    act,
    fx: `=DMG("${res.name}",${fmtPct(res.minPct)},${fmtPct(res.maxPct)})`,
    tip: (res.desc || '') + (res.ko ? ` | ${res.ko}` : ''),
    avg: ((res.minPct || 0) + (res.maxPct || 0)) / 2,
  });
};

// ---------------------------------------------------------------- choices
const needsTarget = (move, gameType) => gameType !== 'singles' &&
  ['normal', 'any', 'adjacentAlly', 'adjacentAllyOrSelf', 'adjacentFoe'].includes(move.target);

const requestKind = (req) => {
  if (!req) return 'none';
  if (req.wait) return 'wait';
  if (req.teamPreview) return 'team';
  if (req.forceSwitch) return 'switch';
  if (req.active) return 'move';
  return 'wait';
};

// slots that need a decision this request
const slotsNeeding = (req) => {
  const kind = requestKind(req);
  const side = (req.side && req.side.pokemon) || [];
  if (kind === 'switch') return req.forceSwitch.map((f, i) => (f ? i : -1)).filter(i => i >= 0);
  if (kind === 'move') {
    return req.active.map((a, i) => {
      const p = side[i];
      if (!a || !p) return -1;
      if (p.condition && / fnt$/.test(p.condition)) return -1;
      if (p.commanding) return -1;
      return i;
    }).filter(i => i >= 0);
  }
  return [];
};

const submitChoices = (b) => {
  const rs = roomState(b.id);
  const req = b.request;
  if (!req) return;
  const kind = requestKind(req);
  const n = kind === 'switch' ? req.forceSwitch.length : kind === 'move' ? req.active.length : 0;
  const need = slotsNeeding(req);
  const parts = [];
  for (let i = 0; i < n; i++) {
    if (!need.includes(i)) parts.push('pass');
    else if (rs.pending[i]) parts.push(rs.pending[i]);
    else return; // still waiting on another slot
  }
  const msg = `/choose ${parts.join(', ')}|${req.rqid}`;
  send(msg, b.id);
  markSent(b, parts.join(', '));
  rs.flags = {};
  setStatus('Submitted. Waiting for opponent.');
};

const markSent = (b, choice) => {
  const rs = roomState(b.id);
  rs.sentRqid = b.request.rqid;
  rs.sent = choice;
  rs.sentLog = b.logTotal || 0;
  rs.error = '';
};

// If the server rejects a choice it answers with an |error| line; unlock so the user can retry.
const checkRejected = (b) => {
  const rs = roomState(b.id);
  if (!b.request || rs.sentRqid !== b.request.rqid) return;
  const fresh = (b.logTotal || 0) - (rs.sentLog || 0);
  if (fresh <= 0) return;
  const tail = (b.log || []).slice(-fresh);
  const err = tail.find(l => /^\|error\|\[(Invalid|Unavailable) choice\]/.test(l));
  if (err) {
    rs.sentRqid = null;
    rs.pending = [];
    rs.error = err.slice(7).replace(/^\[[^\]]*\]\s*/, '');
  }
};

const choose = (b, slot, choice) => {
  const rs = roomState(b.id);
  if (rs.sentRqid === b.request.rqid) { setStatus('Already submitted. Use Undo to change.'); return; }
  if (/^switch /.test(choice)) {
    const idx = choice.split(' ')[1];
    if (rs.pending.some((c, i) => i !== slot && c === `switch ${idx}`)) { setStatus('That member is already switching in.'); return; }
  }
  rs.pending[slot] = choice;
  submitChoices(b);
};

// ---------------------------------------------------------------- battle sheet model
// Column plan (shared by every section so widths line up):
//   A #   B name/move   C type/HP   D cat/status   E BP/boosts   F PP/tera   G target 1   H target 2   I extra   J speed   K moves/notes
const A = (v, extra) => cell(v, { ...extra, cls: ((extra && extra.cls) || '') + ' in' }); // "Input" style = clickable
const KO = (res) => (res && res.ko ? `  ${shortKO(res.ko)}` : '');
const dmgText = (res) => {
  if (!res) return '';
  if (res.error) return '#VALUE!';
  if (res.status) return 'status move';
  if (!res.maxPct) return 'no damage';
  return `${fmtPct(res.minPct)}-${fmtPct(res.maxPct)}%${KO(res)}`;
};
const dmgExtra = (res) => {
  if (!res || res.error || res.status) return { cls: 'dim' };
  return {
    cls: 'dmg ' + koClass(res.ko),
    heat: Math.min(1, (res.maxPct || 0) / 100),
    fx: `=DMG("${res.name}",${fmtPct(res.minPct)},${fmtPct(res.maxPct)})`,
    avg: ((res.minPct || 0) + (res.maxPct || 0)) / 2,
    desc: (res.desc || '') + (res.ko ? ` | ${res.ko}` : ''),
  };
};
const SPREAD = ['allAdjacentFoes', 'allAdjacent', 'all', 'foeSide', 'allySide', 'allies', 'allyTeam'];

const buildBattle = (b) => {
  const rs = roomState(b.id);
  const rows = [];
  const R = (...cells) => { rows.push(cells); return rows.length - 1; };
  const gen = getGen(b.gen);
  const fid = formatIdOf(b.tier);
  const random = isRandom(fid);
  const sets = setsFor(fid, gen.num);
  const req = b.request;
  const me = b.near && b.near.isMe ? b.near : null;
  const mySide = me || b.near;
  const foeSide = b.far && mySide && b.far.sideid !== mySide.sideid ? b.far : null;
  if (!mySide || !foeSide) { R(cell('Loading…', { cls: 'dim' })); return { rows, log: [] }; }
  const doubles = b.gameType !== 'singles';

  if (req && req.rqid !== rs.rqid) { rs.rqid = req.rqid; rs.pending = []; rs.flags = {}; rs.preview = []; rs.error = ''; }
  checkRejected(b);

  const reqMons = (req && req.side && req.side.pokemon) || [];
  const reqFor = (bp) => reqMons.find(r => r.ident === bp.ident) ||
    reqMons.find(r => nameFromIdent(r.ident) === bp.name) || null;
  const activeOf = (side) => side.active.map(i => (i >= 0 ? side.pokemon[i] : null));
  const myActive = activeOf(mySide);
  const foeActive = activeOf(foeSide);
  const allActive = [...myActive, ...foeActive].filter(Boolean);
  const fieldMeToFoe = buildField(gen, b, mySide, foeSide, allActive);
  const fieldFoeToMe = buildField(gen, b, foeSide, mySide, allActive);
  const setCache = new Map();
  const setOf = (bp) => {
    if (!setCache.has(bp)) setCache.set(bp, guessSet(gen, sets, random, bp));
    return setCache.get(bp);
  };
  const mineCalc = (bp, tera) => (me ? buildMine(gen, bp, reqFor(bp), { tera }) : buildFoe(gen, bp, setOf(bp), { tera }));
  const foeCalc = (bp) => buildFoe(gen, bp, setOf(bp));
  const oppName = foeSide.name || 'Opponent';
  const kind = requestKind(req);
  const sent = !!(req && rs.sentRqid === req.rqid);
  const need = me && req && !b.ended ? slotsNeeding(req) : [];
  const sp = (p) => (p ? speciesOf(p) : '');

  // ---- 1. banner: what is going on right now
  let banner = '';
  let bcls = 'banner wait';
  const winLine = [...(b.log || [])].reverse().find(l => /^\|(win|tie)\|/.test(l));
  if (b.ended) { banner = winLine ? `BATTLE OVER: ${winLine.startsWith('|tie') ? 'tie' : `${winLine.split('|')[2]} won`}` : 'BATTLE OVER'; bcls = 'banner done'; }
  else if (!me) banner = `Spectating: ${mySide.name} vs ${oppName}`;
  else if (sent) { banner = `SUBMITTED: ${describeChoice(rs.sent, reqMons, foeActive, myActive)}. Waiting for ${oppName}.`; bcls = 'banner ok'; }
  else if (kind === 'team') { banner = `TEAM PREVIEW: click ${doubles ? 'two orange cells to pick your leads' : 'an orange cell to pick your lead'}`; bcls = 'banner go'; }
  else if (kind === 'switch') { banner = 'SWITCH IN: click an orange cell below to pick a replacement'; bcls = 'banner go'; }
  else if (kind === 'move') {
    const todo = need.filter(i => !rs.pending[i]).map(i => sp(myActive[i]));
    banner = `YOUR MOVE (turn ${b.turn}): click an orange cell${doubles && todo.length ? `. Still to choose: ${todo.join(', ')}` : ''}`;
    bcls = 'banner go';
  } else banner = `Waiting for ${oppName}`;
  R(cell(banner, { cls: bcls, span: 11 }));
  if (rs.error && !b.ended) R(cell(`Server rejected the last choice: ${rs.error}`, { cls: 'banner bad', span: 11 }));

  // ---- 2. field line
  const fieldBits = [
    `Weather: ${weatherName(b.weather) || 'none'}`,
    `Terrain: ${terrainName(b.pseudoWeather) || 'none'}`,
  ];
  const other = (b.pseudoWeather || []).filter(x => !/Terrain/.test(x));
  if (other.length) fieldBits.push(other.join(', '));
  fieldBits.push(`Your side: ${sideCondStr(mySide) || 'nothing'}`, `Their side: ${sideCondStr(foeSide) || 'nothing'}`);
  R(cell(`vs ${oppName}  |  ${b.tier || fid}  |  ${fieldBits.join('  |  ')}`, { cls: 'dim', span: 11 }));
  R();

  // ---- 2b. field: everything currently in battle, with HP
  const hpOf = (p) => {
    const rp = me && p.side !== 'foe' ? reqFor(p) : null;
    if (p.fainted) return { pct: 0, txt: 'KO' };
    if (rp && rp.condition) {
      const [c, mx] = rp.condition.split(' ')[0].split('/').map(Number);
      const pct = mx ? (c / mx) * 100 : 0;
      return { pct, txt: `${fmtPct(pct)}%  (${c}/${mx})` };
    }
    const pct = hpPct(p);
    return { pct, txt: `${fmtPct(pct)}%` };
  };
  const fieldRow = (p, mine, slotLabel) => {
    if (!p) { R(cell(slotLabel, { cls: 'small dim' }), cell('(empty)', { cls: 'dim' })); return; }
    const h = hpOf(mine ? p : { ...p, side: 'foe' });
    const set = !mine || !me ? setOf(p) : null;
    const rp = mine && me ? reqFor(p) : null;
    const tera = p.terastallized ? `Tera ${p.terastallized}` : '';
    const item = rp ? (gen.items.get(toID(rp.item)) || { name: rp.item || '' }).name
      : (p.item || (p.prevItem ? `(lost ${p.prevItem})` : (set && set.item ? `${set.item}?` : '')));
    const ability = rp ? ((gen.abilities.get(toID(rp.ability || rp.baseAbility)) || {}).name || '')
      : (p.ability || p.baseAbility || (set && set.ability ? `${set.ability}?` : ''));
    const vol = (p.volatiles || []).filter(v => /^(substitute|confusion|leechseed|taunt|encore|protosynthesis\w+|quarkdrive\w+|dynamax|perishsong\d?|yawn|curse|attract)$/.test(v));
    R(
      cell(slotLabel, { cls: 'small b ' + (mine ? 'mine-t' : 'theirs-t') }),
      cell(sp(p), { cls: 'b' + (p.fainted ? ' strike dim' : '') }),
      cell(h.txt, { cls: 'num b', bar: h.pct, span: 2 }), cell(''),
      cell((p.status || '').toUpperCase(), { cls: p.status ? 'neg b' : '' }),
      cell(boostStr(p.boosts), { cls: 'b', span: 2 }), cell(''),
      cell([tera, ...vol].filter(Boolean).join(', ')),
      cell(item, { cls: rp || p.item ? '' : 'dim' }),
      cell(ability, { cls: rp || p.ability || p.baseAbility ? '' : 'dim', span: 2 }), cell(''),
    );
  };
  R(cell('ON THE FIELD', { cls: 'sec field', span: 11 }));
  R(cell('', { cls: 'th' }), cell('Pokemon', { cls: 'th' }), cell('HP', { cls: 'th', span: 2 }), cell('', { cls: 'th' }), cell('Status', { cls: 'th' }),
    cell('Boosts', { cls: 'th', span: 2 }), cell('', { cls: 'th' }), cell('Tera / effects', { cls: 'th' }), cell('Item', { cls: 'th' }), cell('Ability', { cls: 'th', span: 2 }), cell('', { cls: 'th' }));
  foeActive.forEach((p, i) => fieldRow(p, false, doubles ? `Opp ${i + 1}` : 'Opp'));
  myActive.forEach((p, i) => fieldRow(p, true, doubles ? `You ${i + 1}` : 'You'));
  R();

  // ---- 3. actions
  if (me && req && !b.ended) {
    if (kind === 'team') {
      R(cell('PICK YOUR LEAD', { cls: 'sec', span: 11 }));
      R(cell('Order', { cls: 'th' }), cell('Pokemon', { cls: 'th' }), cell('Item', { cls: 'th', span: 2 }), cell(''), cell('Ability', { cls: 'th', span: 2 }), cell(''), cell('Moves', { cls: 'th', span: 4 }));
      reqMons.forEach((rp, i) => {
        const ord = rs.preview.indexOf(i + 1);
        R(cell(ord >= 0 ? ord + 1 : '', { cls: 'num b' }),
          sent ? cell(speciesOf(rp)) : A(`> ${speciesOf(rp)}`, { act: { type: 'preview', n: i + 1 }, fx: `=LEAD(${i + 1})`, desc: `Send out ${speciesOf(rp)}${doubles ? '' : ' first'}` }),
          cell((gen.items.get(toID(rp.item)) || { name: rp.item }).name, { span: 2 }), cell(''),
          cell((gen.abilities.get(toID(rp.ability || rp.baseAbility)) || { name: rp.baseAbility }).name, { span: 2 }), cell(''),
          cell(rp.moves.map(m => (moveData(gen, m) || { name: m }).name).join(', '), { span: 4 }));
      });
      if (doubles || (req.maxChosenTeamSize && req.maxChosenTeamSize > 1)) {
        R(cell(''), sent ? cell('') : A('> Submit order', { act: { type: 'previewSubmit' } }), cell('Reset', { cls: 'btn', act: { type: 'previewReset' } }));
      }
      if (sent) R(cell(''), A('Undo', { act: { type: 'undo' } }));
      R();
    } else if (kind === 'move' || kind === 'switch') {
      need.forEach((slot) => {
        const bp = myActive[slot];
        const rp = reqMons[slot];
        const ra = kind === 'move' ? req.active[slot] : null;
        const who = bp ? sp(bp) : speciesOf(rp);
        const queued = rs.pending[slot];
        const locked = sent || !!queued;
        const myHp = bp && !bp.fainted && kind !== 'switch' ? `  [HP ${hpOf(bp).txt}]` : '';
        R(cell(`${kind === 'switch' ? 'REPLACE' : 'MOVES FOR'} ${who.toUpperCase()}${myHp}${doubles ? `  (left/right slot ${slot + 1})` : ''}${queued ? `   queued: ${describeChoice(queued, reqMons, foeActive, myActive)}` : ''}`, { cls: 'sec', span: 11 }));
        if (ra) {
          const flags = rs.flags[slot] || {};
          const atk = bp ? mineCalc(bp, !!flags.tera) : null;
          const foes = foeActive.map((f, i) => ({ f, i }));
          const hdr = [cell('#', { cls: 'th' }), cell('Move', { cls: 'th' }), cell('Type', { cls: 'th' }), cell('Cat', { cls: 'th' }), cell('BP', { cls: 'th' }), cell('PP', { cls: 'th' })];
          foes.slice(0, 2).forEach(({ f }) => hdr.push(cell(f && !f.fainted ? `Hit ${sp(f)} (${fmtPct(hpPct(f))}%)` : '(empty)', { cls: 'th' })));
          if (foes.length < 2) hdr.push(cell('', { cls: 'th' }));
          hdr.push(cell(doubles ? 'Other target' : '', { cls: 'th' }));
          R(...hdr);
          ra.moves.forEach((m, mi) => {
            const md = moveData(gen, m.id || m.move) || { name: m.move, type: '?', category: '?', basePower: 0 };
            const disabled = !!m.disabled || (m.pp === 0 && m.maxpp > 0);
            const base = `move ${mi + 1}`;
            const target = m.target || md.target;
            const targeted = needsTarget({ target }, b.gameType);
            const foeOnly = target === 'adjacentFoe';
            const allyOnly = target === 'adjacentAlly' || target === 'adjacentAllyOrSelf';
            const canAct = !disabled && !locked;
            const row = [
              cell(mi + 1, { cls: 'num' }),
              // move name is the button whenever no target has to be picked
              !targeted && canAct ? A(`> ${md.name}`, { act: { type: 'choose', slot, choice: base, suffix: true }, fx: `=USE("${md.name}")`, desc: `Use ${md.name}` })
                : cell(md.name, { cls: disabled ? 'dim strike' : 'b', tip: disabled ? 'Disabled / no PP' : '' }),
              cell(flags.tera && md.name === 'Tera Blast' && rp ? rp.teraType : md.type),
              cell(md.category ? md.category.slice(0, 4) : ''),
              cell(md.basePower || '', { cls: 'num' }),
              cell(m.maxpp ? `${m.pp}/${m.maxpp}` : '', { cls: 'num' + (m.pp <= 1 ? ' neg' : '') }),
            ];
            for (let k = 0; k < 2; k++) {
              const f = foes[k] && foes[k].f;
              if (!f || f.fainted) { row.push(cell('')); continue; }
              const res = calcMove(gen, atk, foeCalc(f), md.name, fieldMeToFoe, { max: !!flags.max, z: !!flags.z });
              const x = dmgExtra(res);
              if (targeted && !allyOnly && canAct) {
                row.push(A(res && !res.status && !res.error ? `> ${dmgText(res)}` : `> use on ${sp(f)}`, { ...x, cls: x.cls + ' in', act: { type: 'choose', slot, choice: `${base} ${k + 1}`, suffix: true }, desc: `Use ${md.name} on ${sp(f)}. ${x.desc || ''}` }));
              } else {
                row.push(cell(allyOnly ? '' : dmgText(res), { ...x, desc: x.desc }));
              }
            }
            // extra target column (doubles): ally / self / spread notes
            if (doubles) {
              const ally = myActive.map((p, ai) => ({ p, ai })).find(x => x.p && x.ai !== slot && !x.p.fainted);
              if (canAct && targeted && !foeOnly && ally && target !== 'adjacentAllyOrSelf') {
                row.push(cell(`> ally ${sp(ally.p)}`, { cls: 'in warn', act: { type: 'choose', slot, choice: `${base} -${ally.ai + 1}`, suffix: true }, desc: `Use ${md.name} on your own ${sp(ally.p)}` }));
              } else if (canAct && target === 'adjacentAllyOrSelf') {
                row.push(cell('> self', { cls: 'in', act: { type: 'choose', slot, choice: `${base} -${slot + 1}`, suffix: true }, desc: `Use ${md.name} on itself` }));
              } else if (SPREAD.includes(target) && md.category !== 'Status') {
                row.push(cell(target === 'allAdjacent' ? 'hits all incl. ally' : 'hits both foes', { cls: target === 'allAdjacent' ? 'warn small' : 'small dim' }));
              } else row.push(cell(''));
            } else row.push(cell(''));
            R(...row);
          });
          // gimmicks
          const tog = [cell(''), cell('Options', { cls: 'lbl' })];
          const toggle = (key, label, ok) => {
            if (!ok) return;
            tog.push(cell(label, { cls: 'lbl', span: 2 }), cell(''),
              cell(flags[key] ? 'YES' : 'no', { cls: 'bool in' + (flags[key] ? ' on' : ''), act: { type: 'flag', slot, key }, fx: `=${flags[key] ? 'TRUE' : 'FALSE'}`, desc: `Toggle ${label} for this move` }));
          };
          toggle('tera', `Terastallize (${rp && rp.teraType})`, ra.canTerastallize);
          toggle('mega', 'Mega Evolve', ra.canMegaEvo || ra.canMegaEvoX || ra.canMegaEvoY);
          toggle('max', 'Dynamax', ra.canDynamax);
          toggle('z', 'Z-Move', !!ra.canZMove);
          if (tog.length > 2) R(...tog);
          if (ra.trapped) R(cell(''), cell('Trapped: cannot switch', { cls: 'neg', span: 4 }));
        }
        if (!ra || !ra.trapped) {
          const bench = reqMons.map((p, i) => ({ p, i })).filter(({ p }) => !p.active && !/ fnt$/.test(p.condition));
          if (bench.length) {
            R(cell(''), cell(kind === 'switch' ? 'Send in:' : 'Or switch to:', { cls: 'lbl' }));
            bench.forEach(({ p, i }) => {
              const hp = p.condition.split(' ');
              const [c, mx] = hp[0].split('/').map(Number);
              const pct = mx ? Math.round((c / mx) * 100) : 0;
              R(cell(''),
                locked ? cell(speciesOf(p), { cls: 'dim' }) : A(`> ${speciesOf(p)}`, { act: { type: 'choose', slot, choice: `switch ${i + 1}` }, fx: `=SWITCH(${i + 1})`, desc: `Switch to ${speciesOf(p)} (${hp[0]} HP)` }),
                cell(`${pct}%`, { cls: 'num', bar: pct }),
                cell(hp[1] ? hp[1].toUpperCase() : '', { cls: 'neg' }));
            });
          }
        }
        R();
      });
      if (sent) R(cell(''), A('Undo', { act: { type: 'undo' }, desc: 'Take back your choice' }), cell('change your mind before the turn runs', { cls: 'dim', span: 4 }));
      else if (rs.pending.some(Boolean)) R(cell(''), A('Clear queued', { act: { type: 'clearPending' } }));
      R();
    }
  }

  // ---- 4. teams (active first)
  const teamTable = (side, isMine) => {
    R(cell(isMine ? (me ? 'YOUR TEAM' : side.name.toUpperCase()) : `OPPONENT: ${oppName.toUpperCase()}`, { cls: 'sec ' + (isMine ? 'mine' : 'theirs'), span: 11 }));
    R(...['', 'Pokemon', 'HP', 'Status', 'Boosts', 'Tera', 'Item', 'Ability', 'Speed', 'Moves', ''].map((h, i) => cell(h, { cls: 'th', span: i === 9 ? 2 : 1 })));
    const order = side.pokemon.map((p, i) => ({ p, i })).sort((x, y) => (y.p.active - x.p.active) || (x.p.fainted - y.p.fainted) || (x.i - y.i));
    order.forEach(({ p }) => {
      const rp = isMine && me ? reqFor(p) : null;
      const set = !(isMine && me) ? setOf(p) : null;
      let spe = '';
      let speTip = '';
      try {
        if (rp) { const cp = buildMine(gen, p, rp); spe = cp ? String(speedOf(gen, cp, fieldMeToFoe, true)) : ''; speTip = 'Exact speed incl. boosts, items, weather'; }
        else {
          const rng = speedRange(gen, p, isMine ? fieldMeToFoe : fieldFoeToMe);
          spe = rng ? `${rng[0]}-${rng[1]}` : '';
          speTip = `Possible speed range (slowest to fastest spread)${set ? `; likely set: ${set.source}` : ''}`;
        }
      } catch (e) { spe = ''; }
      const moves = rp ? rp.moves.map(m => (moveData(gen, m) || { name: m }).name) : p.moves;
      const guessMoves = !rp && set ? set.moves.filter(m => !p.moves.some(k => toID(k) === toID(m))) : [];
      const item = rp ? (gen.items.get(toID(rp.item)) || { name: rp.item || 'none' }).name
        : (p.item || (p.prevItem ? `(lost ${p.prevItem})` : (set && set.item ? `${set.item}?` : '?')));
      const ability = rp ? ((gen.abilities.get(toID(rp.ability || rp.baseAbility)) || {}).name || rp.ability)
        : (p.ability || p.baseAbility || (set && set.ability ? `${set.ability}?` : '?'));
      const tera = p.terastallized ? `${p.terastallized} (on)` : (rp ? rp.teraType : (set && set.teraType ? `${set.teraType}?` : ''));
      const pct = p.fainted ? 0 : hpPct(p);
      const hl = p.active && !p.fainted ? ' actrow' : '';
      R(
        cell(p.active && !p.fainted ? 'IN' : '', { cls: 'b small' + hl }),
        cell(sp(p) + (p.name && p.name !== sp(p) ? ` (${p.name})` : ''), { cls: (p.fainted ? 'strike dim' : p.active ? 'b' : '') + hl, tip: set ? `Unknowns guessed from ${set.source}` : '' }),
        cell(p.fainted ? 'KO' : `${fmtPct(pct)}%`, { cls: 'num' + hl, bar: p.fainted ? undefined : pct, fx: rp ? `=${rp.condition.split(' ')[0]}` : `=${p.hp}/${p.maxhp}` }),
        cell((p.status || '').toUpperCase(), { cls: (p.status ? 'neg' : '') + hl }),
        cell(boostStr(p.boosts), { cls: hl }),
        cell(tera, { cls: hl }),
        cell(item, { cls: (rp || p.item ? '' : 'dim') + hl }),
        cell(ability, { cls: (rp || p.ability || p.baseAbility ? '' : 'dim') + hl }),
        cell(spe, { cls: 'num' + hl, tip: speTip }),
        cell([...moves, ...guessMoves.map(m => `${m}?`)].join(', '), { span: 2, cls: hl, tip: guessMoves.length ? '? = not seen yet, guessed from the usual set' : '' }),
        cell('', { cls: hl }),
      );
    });
    const unrevealed = (side.totalPokemon || 6) - side.pokemon.length;
    if (unrevealed > 0) R(cell(''), cell(`+${unrevealed} not seen yet`, { cls: 'dim' }));
    R();
  };

  // ---- 5. threats: their moves into you. Four slots: revealed moves are locked in,
  // the rest start as the guessed set and can be changed from a dropdown.
  const threats = () => {
    foeActive.forEach((f) => {
      if (!f || f.fainted) return;
      const set = setOf(f);
      const attacker = foeCalc(f);
      const attackerTera = buildFoe(gen, f, set, { tera: true });
      const slots = foeMoveSlots(b.id, foeSide.sideid, f, set);
      const defs = myActive.map((p, i) => ({ p, i })).filter(x => x.p && !x.p.fainted);
      if (!defs.length) return;
      R(cell(`THEIR ${sp(f).toUpperCase()} INTO YOU  [HP ${fmtPct(hpPct(f))}%]   bold = revealed, dropdown = your guess`, { cls: 'sec theirs', span: 11 }));
      const canTera = !f.terastallized && gen.num === 9 && set && set.teraType;
      R(cell('', { cls: 'th' }), cell('Move', { cls: 'th' }), cell('Type', { cls: 'th' }), cell('Cat', { cls: 'th' }), cell('BP', { cls: 'th' }), cell('', { cls: 'th' }),
        ...[0, 1].map(k => cell(defs[k] ? `Hits your ${sp(defs[k].p)}` : '', { cls: 'th' })),
        cell(canTera && defs[0] ? `if they Tera ${set.teraType}` : '', { cls: 'th' }));
      const pool = [...new Set([...(f.moves || []), ...((set && set.pool) || []), ...slots.map(x => x.name).filter(Boolean)])]
        .map(m => (moveData(gen, m) || { name: m }).name)
        .filter(m => !(f.moves || []).some(r => toID(r) === toID(m)))
        .sort((x, y) => x.localeCompare(y));
      // no preset data for this Pokemon: offer every move
      if (pool.length < 4) for (const m of allMoveNames(gen)) if (!pool.includes(m) && !(f.moves || []).some(r => toID(r) === toID(m))) pool.push(m);
      slots.forEach((slot, si) => {
        const md = slot.name ? moveData(gen, slot.name) : null;
        const pick = slot.revealed
          ? cell(md ? md.name : slot.name, { cls: 'b', tip: 'Revealed in battle' })
          : cell('', { select: 'move', options: pool, value: md ? md.name : '', key: slot.key, idx: si, cls: 'pick' });
        const row = [cell(slot.revealed ? 'seen' : 'guess', { cls: 'small ' + (slot.revealed ? 'b' : 'dim') }), pick,
          cell(md ? md.type : ''), cell(md ? md.category.slice(0, 4) : ''), cell(md && md.basePower ? md.basePower : '', { cls: 'num' }), cell('')];
        for (let k = 0; k < 2; k++) {
          if (!defs[k] || !md) { row.push(cell('')); continue; }
          const res = calcMove(gen, attacker, mineCalc(defs[k].p, false), md.name, fieldFoeToMe);
          const x = dmgExtra(res);
          row.push(cell(md.category === 'Status' ? '' : dmgText(res), { ...x, tip: x.desc }));
        }
        if (canTera && defs[0] && md && md.category !== 'Status') {
          const res = calcMove(gen, attackerTera, mineCalc(defs[0].p, false), md.name, fieldFoeToMe);
          const x = dmgExtra(res);
          row.push(cell(dmgText(res), { ...x, tip: x.desc }));
        }
        R(...row);
      });
      const extraSeen = (f.moves || []).length > 4 ? f.moves.slice(4) : [];
      if (extraSeen.length) R(cell(''), cell(`Also seen: ${extraSeen.join(', ')}`, { cls: 'dim', span: 6 }));
      // speed verdict
      const mine = defs[0] ? mineCalc(defs[0].p, false) : null;
      const rng = speedRange(gen, f, fieldFoeToMe);
      if (mine && rng) {
        const mySpe = speedOf(gen, mine, fieldMeToFoe, true);
        const est = speedOf(gen, attacker, fieldFoeToMe, true);
        const tr = (b.pseudoWeather || []).some(x => /Trick Room/.test(x));
        let v;
        if (mySpe > rng[1]) v = 'you are faster (guaranteed)';
        else if (mySpe < rng[0]) v = 'they are faster (guaranteed)';
        else v = mySpe > est ? 'you are probably faster' : mySpe < est ? 'they are probably faster' : 'probably a speed tie';
        if (tr) v += ', but Trick Room reverses it';
        R(cell(''), cell('Speed', { cls: 'lbl' }), cell(`${sp(defs[0].p)} ${mySpe} vs ${sp(f)} ${rng[0]}-${rng[1]} (likely ${est}): ${v}`, { cls: 'b', span: 9 }));
      }
      R();
    });
  };

  threats();
  teamTable(mySide, true);

  if (b.ended) {
    R(cell(''), A('Close this sheet', { act: { type: 'leave' } }), A('New battle', { act: { type: 'tab', id: 'summary' } }));
  } else if (me) {
    R(cell(''), cell('Timer on', { cls: 'btn', act: { type: 'raw-send', msg: '/timer on' } }), cell('Forfeit', { cls: 'btn neg', act: { type: 'raw-send', msg: '/forfeit', confirm: true } }));
  } else {
    R(cell(''), A('Close this sheet', { act: { type: 'leave' } }));
  }

  // ---- right-hand panel: their team at a glance (Showdex-style), then the log
  const right = [];
  const P = (...c) => right.push(c);
  P(cell(`THEIR TEAM: ${oppName}`, { cls: 'sec theirs', span: 3 }), cell(''), cell(''));
  const foeOrder = foeSide.pokemon.map((p, i) => ({ p, i })).sort((x, y) => (y.p.active - x.p.active) || (x.p.fainted - y.p.fainted) || (x.i - y.i));
  foeOrder.forEach(({ p }) => {
    const set = setOf(p);
    const on = p.active && !p.fainted;
    const hl = on ? ' actrow' : '';
    const pct = p.fainted ? 0 : hpPct(p);
    const item = p.item || (p.prevItem ? `(lost ${p.prevItem})` : (set && set.item ? `${set.item}?` : 'item ?'));
    const ability = p.ability || p.baseAbility || (set && set.ability ? `${set.ability}?` : 'ability ?');
    const tera = p.terastallized ? `Tera ${p.terastallized} (used)` : (set && set.teraType ? `Tera ${set.teraType}?` : '');
    let spe = '';
    try { const rng = speedRange(gen, p, fieldFoeToMe); spe = rng ? `Spe ${rng[0]}-${rng[1]}` : ''; } catch (e) { spe = ''; }
    const slots = foeMoveSlots(b.id, foeSide.sideid, p, set);
    const status = [p.status ? p.status.toUpperCase() : '', boostStr(p.boosts)].filter(Boolean).join(' ');
    P(cell(on ? 'IN' : p.fainted ? 'KO' : '', { cls: 'small b' + (p.fainted ? ' neg' : '') + hl }),
      cell(sp(p), { cls: (p.fainted ? 'strike dim' : 'b') + hl, tip: set ? `Guesses from ${set.source}` : 'No preset found' }),
      cell(p.fainted ? '0%' : `${fmtPct(pct)}%${status ? '  ' + status : ''}`, { cls: 'num' + hl, bar: p.fainted ? undefined : pct }));
    P(cell(''), cell(item, { cls: p.item ? '' : 'dim' }), cell(ability, { cls: p.ability || p.baseAbility ? '' : 'dim' }));
    P(cell(''), cell(tera, { cls: p.terastallized ? 'b' : 'dim' }), cell(spe, { cls: 'num dim', tip: 'Possible speed range incl. boosts, Tailwind, paralysis' }));
    P(cell(''), cell(slots.map(x => (x.name ? (moveData(gen, x.name) || { name: x.name }).name : '?') + (x.revealed ? '' : '?')).join(', '),
      { span: 2, tip: 'Moves (? = not revealed yet)' }), cell(''));
  });
  const unseen = (foeSide.totalPokemon || 6) - foeSide.pokemon.length;
  for (let i = 0; i < unseen; i++) P(cell(''), cell('(not seen yet)', { cls: 'dim' }), cell(''));
  P();
  const mine = me ? me.sideid : mySide.sideid;
  const log = formatLog(b.log || [], me ? me.sideid : null).reverse()
    .map(l => ({ ...l, extra: l.side ? (l.side === mine ? ' you' : ' opp') : '' }));
  P(cell('Turn', { cls: 'th' }), cell('Battle log (newest first)', { cls: 'th', span: 2 }), cell('', { cls: 'th' }));
  log.slice(0, 300).forEach(l => P(cell(l.turn || '', { cls: 'num dim' }), cell(l.text, { cls: 'log-' + l.kind + (l.extra || ''), span: 2 }), cell('')));
  return { rows, right };
};

// Slot names as last rendered for this Pokemon (so one dropdown change keeps the other three)
function foeSlotsSnapshot(key) {
  if (S.moveOv[key]) return S.moveOv[key].slice(0, 4).concat(['', '', '', '']).slice(0, 4);
  const out = ['', '', '', ''];
  for (const row of S.cells) for (const x of row) {
    if (!x || x.key !== key) continue;
    if (x.select === 'move') out[x.idx] = x.value || '';
  }
  // revealed slots are plain cells; they get re-inserted by foeMoveSlots anyway
  return out;
}

// Four move slots for an opposing Pokemon: user picks (if any) or the guessed set,
// with every revealed move forced in, replacing a guess.
function foeMoveSlots(roomid, sideid, p, set) {
  const key = `${roomid}|${sideid}|${p.ident || p.name}`;
  const revealed = (p.moves || []).slice(0, 4);
  const isRev = (m) => revealed.some(r => toID(r) === toID(m));
  let slots = (S.moveOv[key] || []).slice(0, 4);
  if (!slots.length) {
    slots = [...revealed];
    for (const m of (set && set.moves) || []) { if (slots.length >= 4) break; if (!slots.some(x => toID(x) === toID(m))) slots.push(m); }
  }
  while (slots.length < 4) slots.push('');
  for (const r of revealed) {
    if (slots.some(x => toID(x) === toID(r))) continue;
    const i = slots.findIndex(x => !x || !isRev(x));
    if (i >= 0) slots[i] = r;
  }
  // keep a slot list without duplicate guesses
  const seen = new Set();
  slots = slots.map(x => { const id = toID(x); if (!id || seen.has(id)) return ''; seen.add(id); return x; });
  return slots.map((name, idx) => ({ name, revealed: !!name && isRev(name), key, idx }));
}

// "move 2 1, switch 3" -> "Thunderbolt on Gyarados, switch to Toxapex"
function describeChoice(choice, reqMons, foeActive, myActive) {
  return String(choice || '').split(',').map((c, slot) => {
    c = c.trim();
    let m = /^move (\d)(?: (-?\d))?(.*)$/.exec(c);
    if (m) {
      const rp = reqMons[slot];
      const mv = rp && rp.moves[+m[1] - 1];
      let name = mv || `move ${m[1]}`;
      try { name = (moveData(getGen(9), mv) || { name }).name; } catch (e) { /* keep */ }
      let tgt = '';
      if (m[2]) {
        const n = +m[2];
        const p = n > 0 ? foeActive[n - 1] : myActive[-n - 1];
        tgt = p ? ` on ${n < 0 ? 'your ' : ''}${speciesOf(p)}` : '';
      }
      const extra = m[3].trim() ? ` (${m[3].trim()})` : '';
      return `${name}${tgt}${extra}`;
    }
    m = /^switch (\d)$/.exec(c);
    if (m) { const rp = reqMons[+m[1] - 1]; return `switch to ${rp ? speciesOf(rp) : m[1]}`; }
    m = /^team (.*)$/.exec(c);
    if (m) { const rp = reqMons[+m[1][0] - 1]; return `lead with ${rp ? speciesOf(rp) : m[1]}`; }
    return c;
  }).filter(x => x !== 'pass').join(', ');
}

// ---------------------------------------------------------------- summary sheet
const buildSummary = () => {
  const rows = [];
  const R = (...c) => rows.push(c);
  const snap = S.snap || {};
  R(cell('Workbook summary', { cls: 'h1', span: 4 }), cell(''), cell(''), cell(''), cell('User', { cls: 'lbl' }), cell(snap.user || '(connecting)', { span: 2 }));
  R();
  if (!snap.host) {
    R(cell('Waiting for data source… (client not loaded yet)', { cls: 'dim', span: 6 }));
    return { rows, log: [] };
  }
  const formats = (snap.formats || []);
  if (!S.lobby.format) S.lobby.format = (formats.find(f => f.id === 'gen9randombattle') || formats[0] || { id: 'gen9randombattle' }).id;
  const fmt = formats.find(f => f.id === S.lobby.format) || { id: S.lobby.format, name: S.lobby.format, team: '' };
  const needsTeam = !isRandom(fmt.id) && fmt.team !== 'preset';
  const teams = snap.teams || [];

  R(cell('NEW ANALYSIS', { cls: 'sec', span: 11 }));
  R(cell('Format', { cls: 'lbl' }), cell('', { select: 'format', span: 3 }), cell(''), cell(''),
    cell(S.lobby.searching ? 'Searching…' : 'Find', { cls: S.lobby.searching ? 'pos b' : 'btn go', act: S.lobby.searching ? null : { type: 'search' }, fx: `=MATCH("${fmt.name}")` }),
    cell(S.lobby.searching ? 'Cancel' : '', { cls: S.lobby.searching ? 'btn' : '', act: S.lobby.searching ? { type: 'cancelSearch' } : null }));
  if (needsTeam) R(cell('Team', { cls: 'lbl' }), cell('', { select: 'team', span: 3 }), cell(''), cell(''), cell(teams.length ? '' : 'No teams saved: build one in the original UI (Alt+Shift+S)', { cls: 'dim', span: 5 }));
  R();

  R(cell('OPEN SHEETS', { cls: 'sec', span: 11 }));
  R(cell('#', { cls: 'th' }), cell('Sheet', { cls: 'th' }), cell('Room', { cls: 'th', span: 3 }), cell(''), cell(''), cell('Status', { cls: 'th' }), cell('Turn', { cls: 'th' }));
  (snap.battles || []).forEach((b, i) => {
    R(cell(i + 1, { cls: 'num' }), cell(tabName(b), { cls: 'btn', act: { type: 'tab', id: b.id } }), cell(b.title || b.id, { span: 3 }), cell(''), cell(''),
      cell(b.ended ? 'Closed' : 'Open', { cls: b.ended ? 'dim' : 'pos' }), cell(b.turn > 0 ? b.turn : '-', { cls: 'num' }));
  });
  if (!(snap.battles || []).length) R(cell(''), cell('None', { cls: 'dim' }));
  R();
  R(cell('SHORTCUTS', { cls: 'sec', span: 11 }));
  [
    ['Alt+Shift+S', 'Show / hide the original client (teambuilder, challenges, chat rooms)'],
    ['Alt+Shift+Q', 'Panic: swap to a harmless budget sheet (press again to return)'],
    ['Click / Enter', 'Run an orange cell (moves, switches, buttons)'],
    ['Arrow keys', 'Move the selection'],
    ['Ctrl+PgUp / PgDn', 'Change sheet'],
    ['Formula bar + Enter', 'Send chat / commands to the current sheet\'s room'],
  ].forEach(([k, d]) => R(cell(''), cell(k, { cls: 'b' }), cell(d, { span: 6 })));
  R();
  R(cell('SETTINGS', { cls: 'sec', span: 11 }));
  R(cell(''), cell('Mute game audio while disguised'), cell('', { span: 2 }), cell(''), cell(S.opts.mute ? 'TRUE' : 'FALSE', { cls: 'bool ' + (S.opts.mute ? 'pos' : 'dim'), act: { type: 'opt', key: 'mute' } }));
  R(cell(''), cell('Skip battle animations (keeps sheet in sync)'), cell('', { span: 2 }), cell(''), cell(S.opts.instant ? 'TRUE' : 'FALSE', { cls: 'bool ' + (S.opts.instant ? 'pos' : 'dim'), act: { type: 'opt', key: 'instant' } }));
  return { rows, log: [] };
};

// ---------------------------------------------------------------- panic sheet
const BOSS = (() => {
  const rows = [];
  const R = (...c) => rows.push(c);
  const months = ['Jul', 'Aug', 'Sep'];
  R(cell('Q3 Operating Forecast (USD thousands)', { cls: 'h1', span: 5 }));
  R();
  R(cell('Line item', { cls: 'th', span: 2 }), cell(''), ...months.map(m => cell(m, { cls: 'th' })), cell('Q3 Total', { cls: 'th' }), cell('Q2 Actual', { cls: 'th' }), cell('Var %', { cls: 'th' }));
  const lines = [
    ['Revenue - Subscriptions', [412.3, 428.9, 441.2], 1187.4], ['Revenue - Services', [96.1, 88.4, 102.7], 271.9],
    ['Cost of revenue', [-131.2, -134.8, -139.9], -392.6], ['Sales & marketing', [-118.4, -121.0, -126.3], -349.1],
    ['R&D', [-142.7, -144.1, -147.9], -421.0], ['G&A', [-61.3, -59.8, -62.4], -176.2], ['Depreciation', [-12.4, -12.4, -12.6], -36.9],
  ];
  const q2 = lines.reduce((a, l) => a + l[2], 0);
  let tot = [0, 0, 0];
  for (const [n, v, q2] of lines) {
    const s = v.reduce((a, x) => a + x, 0);
    tot = tot.map((x, i) => x + v[i]);
    R(cell(n, { span: 2 }), cell(''), ...v.map(x => cell(x.toFixed(1), { cls: 'num' + (x < 0 ? ' neg' : '') })), cell(s.toFixed(1), { cls: 'num b' }), cell(q2.toFixed(1), { cls: 'num' }), cell(((s / q2 - 1) * 100).toFixed(1) + '%', { cls: 'num' }));
  }
  const ts = tot.reduce((a, x) => a + x, 0);
  R(cell('Operating income', { cls: 'b', span: 2 }), cell(''), ...tot.map(x => cell(x.toFixed(1), { cls: 'num b tot' })), cell(ts.toFixed(1), { cls: 'num b tot' }), cell(q2.toFixed(1), { cls: 'num' }), cell(((ts / q2 - 1) * 100).toFixed(1) + '%', { cls: 'num b' }));
  R();
  R(cell('Notes', { cls: 'lbl' }), cell('Services dip in Aug reflects delayed onboarding for two accounts; recovered Sep.', { span: 8 }));
  R(cell(''), cell('Headcount plan unchanged; hiring freeze in G&A holds through Q4.', { span: 8 }));
  return { rows, log: [] };
})();

// ---------------------------------------------------------------- tabs
const tabName = (b) => {
  const rs = roomState(b.id);
  if (!rs.tabName) {
    const n = Object.values(S.rooms).filter(r => r.tabName).length + 2;
    rs.tabName = `Sheet${n}`;
  }
  return rs.tabName;
};
const tabList = () => {
  const bs = (S.snap && S.snap.battles) || [];
  return [{ id: 'summary', name: 'Summary' }, ...bs.map(b => ({ id: b.id, name: tabName(b), ended: b.ended }))];
};

// ---------------------------------------------------------------- DOM
let root, grid, fxInput, nameBox, statusL, statusR, tabsEl, revealBtn;

const buildShell = () => {
  root = document.createElement('div');
  root.id = 'sdx-root';
  root.innerHTML = `
  <div class="sdx-title"><span class="sdx-appicon"></span><span class="sdx-qa">&#8630; &#8631;</span><span class="sdx-doc">${FAKE_TITLE} - Saved</span><span class="sdx-search">Search</span><span class="sdx-win">&#8212; &#9744; &#10005;</span></div>
  <div class="sdx-menu">${['File', 'Home', 'Insert', 'Page Layout', 'Formulas', 'Data', 'Review', 'View', 'Help'].map((m, i) => `<span class="${i === 1 ? 'on' : ''}">${m}</span>`).join('')}<span class="sdx-share">Share</span></div>
  <div class="sdx-ribbon">
    <div class="grp"><div class="big">&#128203;<br>Paste</div><div class="col"><span>&#9986; Cut</span><span>&#10697; Copy</span></div><div class="gl">Clipboard</div></div>
    <div class="grp"><div class="row"><span class="dd w120">Aptos Narrow</span><span class="dd w40">11</span></div><div class="row"><b>B</b><i>I</i><u>U</u><span>&#9638;</span><span class="fill">A</span></div><div class="gl">Font</div></div>
    <div class="grp"><div class="row"><span>&#8676;</span><span>&#8801;</span><span>&#8677;</span><span>Wrap Text</span></div><div class="row"><span>&#8676;</span><span>&#8801;</span><span>&#8677;</span><span>Merge &amp; Center</span></div><div class="gl">Alignment</div></div>
    <div class="grp"><div class="row"><span class="dd w90">General</span></div><div class="row"><span>$</span><span>%</span><span>,</span><span>.0</span><span>.00</span></div><div class="gl">Number</div></div>
    <div class="grp"><div class="col"><span>Conditional Formatting</span><span>Format as Table</span><span>Cell Styles</span></div><div class="gl">Styles</div></div>
    <div class="grp"><div class="col"><span>&#8721; AutoSum</span><span>Sort &amp; Filter</span><span>Find &amp; Select</span></div><div class="gl">Editing</div></div>
  </div>
  <div class="sdx-fx"><input class="sdx-name" readonly value="A1"><span class="sdx-fxsep">&#10005; &#10003; <i>fx</i></span><input class="sdx-fxin" spellcheck="false" placeholder=""></div>
  <div class="sdx-gridwrap"><table class="sdx-grid"></table></div>
  <div class="sdx-tabs"></div>
  <div class="sdx-status"><span class="l">Ready</span><span class="r"></span></div>`;
  document.documentElement.appendChild(root);
  grid = root.querySelector('.sdx-grid');
  fxInput = root.querySelector('.sdx-fxin');
  nameBox = root.querySelector('.sdx-name');
  statusL = root.querySelector('.sdx-status .l');
  statusR = root.querySelector('.sdx-status .r');
  tabsEl = root.querySelector('.sdx-tabs');

  // Floating hint shown on the normal Showdown page: says how to get back into the sheet.
  revealBtn = document.createElement('div');
  revealBtn.id = 'sdx-reveal';
  revealBtn.innerHTML = '<span class="ic">▦</span><span class="tx">Spreadsheet mode: click here or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>'
    + '<small>Panic sheet: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd></small></span><span class="x" title="Hide hint">×</span>';
  revealBtn.addEventListener('click', (e) => {
    if (e.target.closest('.x')) { e.stopPropagation(); revealBtn.classList.remove('open'); return; }
    setOn(true);
  });
  document.documentElement.appendChild(revealBtn);

  // Single click runs a cell. Track the press by grid coordinates rather than by DOM
  // element: the grid re-renders whenever the battle updates, and a re-render between
  // press and release would otherwise swallow the click.
  let press = null;
  grid.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const td = e.target.closest('td[data-r]');
    if (!td || e.target.closest('select')) return;
    press = { r: +td.dataset.r, c: +td.dataset.c };
    S.pointerDown = true;
    select(press.r, press.c);
  });
  document.addEventListener('mouseup', (e) => {
    const was = press;
    press = null;
    S.pointerDown = false;
    if (!was || e.button !== 0) { flushRender(); return; }
    const td = e.target && e.target.closest ? e.target.closest('td[data-r]') : null;
    const same = td ? (+td.dataset.r === was.r && +td.dataset.c === was.c) : grid.contains(e.target);
    if (same) { S.sel = was; activate(); } else flushRender();
  }, true);
  grid.addEventListener('focusout', () => setTimeout(flushRender, 0));
  grid.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.sel === 'format') { S.lobby.format = t.value; saveOpts(); render(); }
    if (t.dataset.sel === 'team') { S.lobby.team = +t.value; saveOpts(); }
    if (t.dataset.sel === 'move') {
      const key = t.dataset.key;
      const idx = +t.dataset.idx;
      // start from what is on screen so the other slots keep their current values
      const snap = foeSlotsSnapshot(key);
      const dup = snap.findIndex((m, j) => j !== idx && m && toID(m) === toID(t.value));
      if (dup >= 0) snap[dup] = snap[idx]; // picking a move that sits in another slot swaps them
      snap[idx] = t.value;
      S.moveOv[key] = snap;
      t.blur();
      render();
    }
  });
  tabsEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t || S.panic) return;
    S.tab = t.dataset.tab;
    S.sel = { r: 0, c: 0 };
    render();
  });
  fxInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const v = fxInput.value.trim();
      fxInput.value = '';
      fxInput.blur();
      if (!v || v.startsWith('=')) return;
      const room = S.tab !== 'summary' && S.tab !== 'boss' ? S.tab : null;
      if (room) send(v, room);
      else if (v.startsWith('/')) send(v);
      else setStatus('Chat from Summary is disabled; open a sheet first.');
      render();
    } else if (e.key === 'Escape') { fxInput.value = ''; fxInput.blur(); }
  });
  // keep PS from seeing our keystrokes
  root.addEventListener('keydown', (e) => e.stopPropagation());
  root.addEventListener('keypress', (e) => e.stopPropagation());
};

let lastModel = null;
const currentModel = () => {
  if (S.panic) return BOSS;
  if (S.tab === 'summary') return buildSummary();
  const b = ((S.snap && S.snap.battles) || []).find(x => x.id === S.tab);
  if (!b) { S.tab = 'summary'; return buildSummary(); }
  if (b.error) return { rows: [[cell('#REF! ' + b.error, { cls: 'err', span: 8 })]], log: [] };
  return buildBattle(b);
};

const LEFT = 11;
const NCOLS = 18;
const WIDTHS = [46, 150, 70, 52, 60, 70, 150, 150, 120, 90, 120, 10, 34, 150, 150, 64, 64, 64];
const TABLE_W = 40 + WIDTHS.reduce((a, x) => a + x, 0);

const flushRender = () => { if (S.renderWanted) render(); };
const render = () => {
  if (!root) return;
  if (S.pointerDown || (document.activeElement && document.activeElement.tagName === 'SELECT' && grid && grid.contains(document.activeElement))) { S.renderWanted = true; return; }
  S.renderWanted = false;
  document.documentElement.classList.toggle('sdx-on', S.on);
  if (!S.on && revealBtn.style.display !== 'flex') {
    // just switched to the normal page: show the full hint for a few seconds, then shrink to the icon
    revealBtn.classList.add('open');
    clearTimeout(revealBtn._t);
    revealBtn._t = setTimeout(() => revealBtn.classList.remove('open'), 9000);
  }
  revealBtn.style.display = S.on ? 'none' : 'flex';
  if (!S.on) return;
  let model;
  try { model = currentModel(); } catch (e) {
    console.error('[sheetdown]', e);
    model = { rows: [[cell('#ERROR ' + (e && e.message), { cls: 'err', span: 8 })]] };
  }
  lastModel = model;
  const rows = model.rows;
  const right = model.right || [];
  const nRows = Math.max(rows.length + 6, right.length + 1, 48);
  const cells = [];
  for (let r = 0; r < nRows; r++) {
    const row = new Array(NCOLS).fill(null);
    const left = rows[r] || [];
    for (let c = 0; c < Math.min(left.length, LEFT); c++) row[c] = left[c];
    const rr = right[r] || [];
    for (let c = 0; c < Math.min(rr.length, 3); c++) row[12 + c] = rr[c];
    cells.push(row);
  }
  S.cells = cells;
  if (S.sel.r >= nRows) S.sel.r = nRows - 1;

  const h = [];
  grid.style.width = TABLE_W + 'px';
  h.push('<colgroup><col style="width:40px">');
  for (let c = 0; c < NCOLS; c++) h.push(`<col style="width:${WIDTHS[c] || 64}px">`);
  h.push('</colgroup><thead><tr><th class="corner"></th>');
  for (let c = 0; c < NCOLS; c++) h.push(`<th class="${c === S.sel.c ? 'hl' : ''}">${COLS[c]}</th>`);
  h.push('</tr></thead><tbody>');
  const snap = S.snap || {};
  for (let r = 0; r < nRows; r++) {
    h.push(`<tr><th class="${r === S.sel.r ? 'hl' : ''}">${r + 1}</th>`);
    for (let c = 0; c < NCOLS; c++) {
      const x = cells[r][c];
      const sel = r === S.sel.r && c === S.sel.c ? ' sel' : '';
      if (!x) { h.push(`<td data-r="${r}" data-c="${c}" class="${sel}"></td>`); continue; }
      let inner = esc(x.v);
      if (x.select === 'format') {
        const groups = {};
        for (const f of snap.formats || []) (groups[f.section || 'Other'] = groups[f.section || 'Other'] || []).push(f);
        inner = `<select data-sel="format">${Object.entries(groups).map(([g, fs]) => `<optgroup label="${esc(g)}">${fs.map(f => `<option value="${esc(f.id)}"${f.id === S.lobby.format ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</optgroup>`).join('')}</select>`;
      } else if (x.select === 'move') {
        const opts = x.value && !x.options.includes(x.value) ? [x.value, ...x.options] : x.options;
        inner = `<select data-sel="move" data-key="${esc(x.key)}" data-idx="${x.idx}"><option value=""${x.value ? '' : ' selected'}>(pick a move)</option>${opts.map(m => `<option value="${esc(m)}"${m === x.value ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select>`;
      } else if (x.select === 'team') {
        inner = `<select data-sel="team">${(snap.teams || []).map((t, i) => `<option value="${i}"${i === S.lobby.team ? ' selected' : ''}>${esc(t.name)}${t.format ? ` [${esc(t.format)}]` : ''}</option>`).join('')}</select>`;
      }
      let style = '';
      if (x.bar !== undefined) {
        const col = x.bar > 50 ? '99,190,123' : x.bar > 20 ? '255,196,0' : '248,105,107';
        style = `background:linear-gradient(90deg, rgba(${col},.55) ${x.bar}%, transparent ${x.bar}%);`;
      } else if (x.heat !== undefined) {
        style = `background:rgba(248,105,107,${(0.08 + x.heat * 0.5).toFixed(2)});`;
      }
      let k = 0;
      if (x.span > 1) {
        while (k < x.span - 1 && c + k + 1 < NCOLS) {
          const nx = cells[r][c + k + 1];
          if (nx && (nx.v !== '' || nx.act || nx.select)) break;
          k++;
        }
      }
      const span = k ? ` colspan="${k + 1}"` : '';
      h.push(`<td data-r="${r}" data-c="${c}" class="${esc(x.cls || '')}${x.act ? ' act' : ''}${sel}"${span} style="${style}" title="${esc(x.desc || x.tip || '')}">${inner}</td>`);
      c += k;
    }
    h.push('</tr>');
  }
  h.push('</tbody>');
  const wrap = grid.parentElement;
  const st = wrap.scrollTop, sl = wrap.scrollLeft;
  grid.innerHTML = h.join('');
  wrap.scrollTop = st; wrap.scrollLeft = sl;

  // tabs
  const tabs = S.panic ? [{ id: 'boss', name: 'Forecast' }, { id: 'x1', name: 'Assumptions' }, { id: 'x2', name: 'Headcount' }] : tabList();
  tabsEl.innerHTML = '<span class="nav">&#9664; &#9654;</span>' + tabs.map(t => `<span data-tab="${esc(t.id)}" class="tab${(S.panic ? t.id === 'boss' : t.id === S.tab) ? ' on' : ''}${t.ended ? ' ended' : ''}">${esc(t.name)}</span>`).join('') + '<span class="plus">+</span>';

  updateSelectionUI();
  keepDisguise();
};

const selectedCell = () => (S.cells[S.sel.r] || [])[S.sel.c] || null;

const updateSelectionUI = () => {
  const x = selectedCell();
  nameBox.value = `${COLS[S.sel.c]}${S.sel.r + 1}`;
  if (document.activeElement !== fxInput) fxInput.value = x ? (x.fx || String(x.v)) : '';
  const fresh = Date.now() - S.statusAt < 6000;
  statusL.textContent = fresh && S.status ? S.status : (x && x.act ? `Click: ${x.desc || 'run'}` : (x && (x.desc || x.tip)) || 'Ready');
  const b = ((S.snap && S.snap.battles) || []).find(q => q.id === S.tab);
  const parts = [];
  if (x && x.avg !== undefined) parts.push(`Average: ${fmtPct(x.avg)}`);
  if (b && !S.panic) parts.push(`Count: ${b.turn > 0 ? b.turn : 0}`);
  parts.push('100%');
  statusR.textContent = parts.join('     ');
};

const select = (r, c) => {
  S.sel = { r: Math.max(0, r), c: Math.max(0, Math.min(NCOLS - 1, c)) };
  grid.querySelectorAll('td.sel').forEach(td => td.classList.remove('sel'));
  grid.querySelectorAll('th.hl').forEach(th => th.classList.remove('hl'));
  const td = grid.querySelector(`td[data-r="${S.sel.r}"][data-c="${S.sel.c}"]`);
  if (td) {
    td.classList.add('sel');
    td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const colTh = grid.querySelectorAll('thead th')[S.sel.c + 1];
  if (colTh) colTh.classList.add('hl');
  const rowTh = grid.querySelectorAll('tbody tr')[S.sel.r];
  if (rowTh && rowTh.firstChild) rowTh.firstChild.classList.add('hl');
  updateSelectionUI();
};

// ---------------------------------------------------------------- actions
const currentBattle = () => ((S.snap && S.snap.battles) || []).find(x => x.id === S.tab);

const activate = () => {
  const x = selectedCell();
  if (!x || !x.act || S.panic) return;
  const a = x.act;
  const b = currentBattle();
  switch (a.type) {
    case 'tab': S.tab = a.id; S.sel = { r: 0, c: 0 }; break;
    case 'choose': {
      if (!b || !b.request) break;
      const rs = roomState(b.id);
      const f = rs.flags[a.slot] || {};
      const sfx = a.suffix ? (f.tera ? ' terastallize' : f.mega ? ' mega' : f.max ? ' dynamax' : f.z ? ' zmove' : '') : '';
      choose(b, a.slot, a.choice + sfx);
      break;
    }
    case 'flag': {
      if (!b) break;
      const rs = roomState(b.id);
      const f = rs.flags[a.slot] = rs.flags[a.slot] || {};
      const v = !f[a.key];
      for (const k of ['tera', 'mega', 'max', 'z']) f[k] = false;
      f[a.key] = v;
      break;
    }
    case 'preview': {
      if (!b) break;
      const rs = roomState(b.id);
      if (!rs.preview.includes(a.n)) rs.preview.push(a.n);
      const max = (b.request && b.request.maxChosenTeamSize) || (b.gameType === 'singles' ? 1 : 2);
      if (b.gameType === 'singles' && rs.preview.length >= 1 && !b.request.maxChosenTeamSize) submitPreview(b);
      else if (rs.preview.length >= max) submitPreview(b);
      break;
    }
    case 'previewSubmit': if (b) submitPreview(b); break;
    case 'previewReset': if (b) roomState(b.id).preview = []; break;
    case 'raw': if (b && b.request) { send(`/choose ${a.choice}|${b.request.rqid}`, b.id); markSent(b, a.choice); } break;
    case 'raw-send':
      if (!b) break;
      if (a.confirm && !window.confirm('Run this command? ' + a.msg)) break;
      send(a.msg, b.id);
      break;
    case 'undo': if (b) { send('/undo', b.id); const rs = roomState(b.id); rs.sentRqid = null; rs.pending = []; setStatus('Choice withdrawn'); } break;
    case 'clearPending': if (b) roomState(b.id).pending = []; break;
    case 'leave': if (b) { toPage('leave', { roomid: b.id }); S.tab = 'summary'; } break;
    case 'search': doSearch(); break;
    case 'cancelSearch': send('/cancelsearch'); S.lobby.searching = false; break;
    case 'opt': S.opts[a.key] = !S.opts[a.key]; saveOpts(); applyMute(); break;
    default: break;
  }
  render();
};

const submitPreview = (b) => {
  const rs = roomState(b.id);
  const n = ((b.request.side && b.request.side.pokemon) || []).length;
  const order = [...rs.preview];
  for (let i = 1; i <= n; i++) if (!order.includes(i)) order.push(i);
  const choice = 'team ' + (order.length >= 10 ? order.join(',') : order.join(''));
  send(`/choose ${choice}|${b.request.rqid}`, b.id);
  markSent(b, choice);
  setStatus('Lead submitted. Waiting for opponent.');
};

const doSearch = () => {
  const snap = S.snap || {};
  const fid = S.lobby.format;
  const fmt = (snap.formats || []).find(f => f.id === fid) || { id: fid, team: '' };
  const needsTeam = !isRandom(fid) && fmt.team !== 'preset';
  if (needsTeam) {
    const t = (snap.teams || [])[S.lobby.team];
    if (!t) { setStatus('Pick a team first (build teams in the original UI: Alt+Shift+S)'); return; }
    send(`/utm ${t.packed}`);
  } else {
    send('/utm null');
  }
  send(`/search ${fid}`);
  S.lobby.searching = true;
  S.lobby.searchedAt = Date.now();
  setStatus(`Searching ${fid}…`);
};

// ---------------------------------------------------------------- disguise
const origIcons = new Map();
let origTitle = null;
const keepDisguise = () => {
  if (!S.on) return;
  if (document.title !== FAKE_TITLE) { if (origTitle === null) origTitle = document.title; document.title = FAKE_TITLE; }
  document.querySelectorAll('link[rel~="icon"]').forEach((l) => {
    if (!origIcons.has(l)) origIcons.set(l, l.href);
    if (l.href !== FAVICON) l.href = FAVICON;
  });
  if (!document.querySelector('link[rel~="icon"]')) {
    const l = document.createElement('link'); l.rel = 'icon'; l.href = FAVICON; document.head.appendChild(l);
  }
};
const dropDisguise = () => {
  origIcons.forEach((href, l) => { l.href = href; });
  origIcons.clear();
  if (origTitle !== null) document.title = origTitle;
  origTitle = null;
};

let mutedByUs = false;
const applyMute = () => {
  toPage('disguise', { on: S.on, instant: S.opts.instant });
  if (S.on && S.opts.mute && !mutedByUs) { toPage('mute', { on: true }); mutedByUs = true; }
  if ((!S.on || !S.opts.mute) && mutedByUs) { toPage('mute', { on: false }); mutedByUs = false; }
};

const setOn = (on) => {
  S.on = on;
  saveOpts();
  if (!on) dropDisguise();
  applyMute();
  render();
};

// ---------------------------------------------------------------- snapshot handling
let firstSnap = true;
const onSnapshot = () => {
  if (firstSnap) { firstSnap = false; mutedByUs = false; applyMute(); }
  const bs = (S.snap && S.snap.battles) || [];
  for (const b of bs) {
    if (!S.knownBattles.has(b.id)) {
      S.knownBattles.add(b.id);
      tabName(b);
      // a new battle appearing ends our search and opens its sheet
      if (S.lobby.searching || (b.request && !b.ended)) { S.lobby.searching = false; S.tab = b.id; S.sel = { r: 0, c: 0 }; }
    }
  }
  if (S.lobby.searching && Date.now() - S.lobby.searchedAt > 10 * 60 * 1000) S.lobby.searching = false;
  if (document.activeElement === fxInput) { updateSelectionUI(); scheduleRender(); return; }
  render();
};
let pendingRender = null;
const scheduleRender = () => {
  if (pendingRender) return;
  pendingRender = setTimeout(() => { pendingRender = null; render(); }, 800);
};

// ---------------------------------------------------------------- keys
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.shiftKey && (e.code === 'KeyS')) { e.preventDefault(); e.stopPropagation(); setOn(!S.on); return; }
  if (e.altKey && e.shiftKey && (e.code === 'KeyQ')) {
    e.preventDefault(); e.stopPropagation();
    if (!S.on) setOn(true);
    S.panic = !S.panic; S.sel = { r: 0, c: 0 }; render(); return;
  }
  if (!S.on || document.activeElement === fxInput) return;
  const t = e.target;
  if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && root.contains(t) && t !== fxInput) return;
  const { r, c } = S.sel;
  let handled = true;
  if (e.ctrlKey && e.key === 'PageDown') { const ts = tabList(); const i = ts.findIndex(x => x.id === S.tab); S.tab = ts[(i + 1) % ts.length].id; render(); }
  else if (e.ctrlKey && e.key === 'PageUp') { const ts = tabList(); const i = ts.findIndex(x => x.id === S.tab); S.tab = ts[(i - 1 + ts.length) % ts.length].id; render(); }
  else if (e.key === 'ArrowDown') select(r + 1, c);
  else if (e.key === 'ArrowUp') select(r - 1, c);
  else if (e.key === 'ArrowLeft') select(r, c - 1);
  else if (e.key === 'ArrowRight' || e.key === 'Tab') select(r, c + 1);
  else if (e.key === 'Enter') activate();
  else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { fxInput.value = ''; fxInput.focus(); handled = false; }
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}, true);

// ---------------------------------------------------------------- boot
(async () => {
  await loadOpts();
  const start = () => {
    buildShell();
    injectPage();
    applyMute();
    render();
    setInterval(() => { if (S.on) { keepDisguise(); if (Date.now() - S.statusAt < 7000) updateSelectionUI(); } }, 1000);
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
