// Damage/speed engine built on @smogon/calc (same library Showdex uses).
import { Generations, Pokemon, Move, Field, calculate, toID } from '@smogon/calc';
import { getFinalSpeed } from '@smogon/calc/dist/mechanics/util';

const gens = {};
export const getGen = (n) => {
  const num = Math.min(9, Math.max(1, n || 9));
  if (!gens[num]) gens[num] = Generations.get(num);
  return gens[num];
};

export const formatIdOf = (tier) => toID(tier || '');
export { toID };

// Pokemon whose stats are known exactly (from the server request). @smogon/calc
// recomputes stats inside clone(), so the override has to survive cloning.
class FixedPokemon extends Pokemon {
  fixStats(stats, maxhp, curhp) {
    this._fixed = { stats: { ...stats }, maxhp, curhp };
    this._apply();
    return this;
  }
  _apply() {
    const f = this._fixed;
    if (!f) return;
    for (const k of ['atk', 'def', 'spa', 'spd', 'spe']) {
      if (f.stats[k]) { this.rawStats[k] = f.stats[k]; this.stats[k] = f.stats[k]; }
    }
    if (f.maxhp) { this.rawStats.hp = f.maxhp; this.stats.hp = f.maxhp; }
    if (f.curhp !== undefined) this.originalCurHP = Math.max(0, Math.min(f.curhp, this.rawStats.hp));
  }
  clone() {
    const c = super.clone();
    Object.setPrototypeOf(c, FixedPokemon.prototype);
    c._fixed = this._fixed;
    c._apply();
    return c;
  }
}

const STATUS_MAP = { brn: 'brn', par: 'par', slp: 'slp', frz: 'frz', psn: 'psn', tox: 'tox' };

export const speciesOf = (poke) => {
  if (!poke) return '';
  if (poke.speciesForme) return poke.speciesForme;
  const d = poke.details || '';
  return d.split(',')[0].trim();
};

const safeSpeciesName = (gen, name) => {
  let sp = gen.species.get(toID(name));
  if (sp) return sp.name;
  // cosmetic / battle-only formes the calc doesn't know: fall back to base
  const base = name.split('-')[0];
  sp = gen.species.get(toID(base));
  return sp ? sp.name : null;
};

const itemName = (gen, id) => {
  if (!id) return undefined;
  const it = gen.items.get(toID(id));
  return it ? it.name : undefined;
};
const abilityName = (gen, id) => {
  if (!id) return undefined;
  const a = gen.abilities.get(toID(id));
  return a ? a.name : undefined;
};
export const moveData = (gen, id) => gen.moves.get(toID(id));
const allMovesCache = {};
export const allMoveNames = (gen) => {
  if (!allMovesCache[gen.num]) {
    const out = [];
    for (const m of gen.moves) if (!m.isMax && !m.isZ && m.name !== '(No Move)') out.push(m.name);
    allMovesCache[gen.num] = out.sort((a, b) => a.localeCompare(b));
  }
  return allMovesCache[gen.num];
};

const pctHP = (p) => (p && p.maxhp ? p.hp / p.maxhp : 1);

// ---------- set guessing (randbats / smogon presets) ----------

const flat = (x) => (Array.isArray(x) ? x : x ? [x] : []);

const lookupEntry = (sets, gen, species) => {
  if (!sets) return null;
  if (sets[species]) return sets[species];
  const sp = gen.species.get(toID(species));
  if (sp && sp.baseSpecies && sets[sp.baseSpecies]) return sets[sp.baseSpecies];
  const key = Object.keys(sets).find(k => toID(k) === toID(species));
  if (key) return sets[key];
  // cosmetic formes (Alcremie-Ruby-Swirl, Vivillon-Ocean, ...): strip suffixes until something matches
  const parts = species.split('-');
  while (parts.length > 1) {
    parts.pop();
    const k2 = Object.keys(sets).find(k => toID(k) === toID(parts.join('-')));
    if (k2) return sets[k2];
  }
  return null;
};

// returns { source, level, ability, item, nature, evs, ivs, teraType, moves[] }
export const guessSet = (gen, sets, isRandom, poke) => {
  const species = speciesOf(poke);
  const entry = lookupEntry(sets, gen, species);
  const revealed = (poke.moves || []).map(toID);
  const overlap = (moves) => moves.filter(m => revealed.includes(toID(m))).length;
  if (!entry) return null;
  if (isRandom) {
    const roles = entry.roles ? Object.entries(entry.roles) : [['Random', entry]];
    let best = null;
    for (const [name, r] of roles) {
      const mv = flat(r.moves);
      const score = overlap(mv);
      if (!best || score > best.score) best = { name, r, score };
    }
    const r = best.r;
    const pool = [...new Set(roles.flatMap(([, x]) => flat(x.moves)))];
    return {
      pool,
      source: `randbats: ${best.name}`,
      level: entry.level,
      ability: flat(r.abilities || entry.abilities)[0],
      item: flat(r.items || entry.items)[0],
      teraType: flat(r.teraTypes)[0],
      nature: undefined,
      evs: { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84, ...(entry.evs || {}), ...(r.evs || {}) },
      ivs: { ...(entry.ivs || {}), ...(r.ivs || {}) },
      moves: flat(r.moves),
    };
  }
  let best = null;
  for (const [name, s] of Object.entries(entry)) {
    const mv = (s.moves || []).flatMap(flat);
    const score = overlap(mv);
    if (!best || score > best.score) best = { name, s, score, mv };
  }
  const s = best.s;
  const pool = [...new Set(Object.values(entry).flatMap(x => (x.moves || []).flatMap(flat)))];
  return {
    pool,
    source: `smogon: ${best.name}`,
    level: undefined,
    ability: flat(s.ability)[0],
    item: flat(s.item)[0],
    teraType: flat(s.teratypes || s.teraTypes)[0],
    nature: flat(s.nature)[0],
    evs: flat(s.evs)[0] || {},
    ivs: flat(s.ivs)[0] || {},
    moves: best.mv,
  };
};

// ---------- building calc Pokemon ----------

// Protosynthesis / Quark Drive: the client tracks the boosted stat as a volatile
const boostedStatOf = (p) => {
  for (const v of p.volatiles || []) {
    const m = /^(?:protosynthesis|quarkdrive)(atk|def|spa|spd|spe)$/.exec(v);
    if (m) return m[1];
  }
  return undefined;
};

const boostsOf = (p) => {
  const b = {};
  for (const k of ['atk', 'def', 'spa', 'spd', 'spe']) if (p.boosts && p.boosts[k]) b[k] = p.boosts[k];
  return b;
};

const parseCondition = (cond) => {
  // "245/301 brn" | "0 fnt"
  const [hpPart, status] = (cond || '').split(' ');
  const [cur, max] = hpPart.split('/').map(Number);
  return { cur: cur || 0, max: max || 0, status: status || '' };
};

// mine: battle pokemon + server request pokemon (exact stats)
export const buildMine = (gen, bp, rp, opts = {}) => {
  const name = safeSpeciesName(gen, speciesOf(bp) || speciesOf(rp));
  if (!name) return null;
  const cond = parseCondition(rp && rp.condition);
  const tera = bp.terastallized || (opts.tera ? (rp && rp.teraType) : undefined);
  const p = new FixedPokemon(gen, name, {
    level: bp.level || 100,
    ability: abilityName(gen, (rp && (rp.ability || rp.baseAbility)) || bp.ability),
    item: itemName(gen, rp ? rp.item : bp.item),
    status: STATUS_MAP[bp.status] || '',
    boosts: boostsOf(bp),
    boostedStat: boostedStatOf(bp),
    teraType: tera || undefined,
    gender: bp.gender || undefined,
  });
  if (rp && rp.stats) p.fixStats(rp.stats, cond.max, cond.cur);
  return p;
};

// foe: battle pokemon with presets filling unknowns
export const buildFoe = (gen, bp, set, opts = {}) => {
  const name = safeSpeciesName(gen, speciesOf(bp));
  if (!name) return null;
  const knownItem = bp.item || (bp.prevItem ? '' : undefined);
  const item = knownItem === undefined ? (set && set.item) : knownItem;
  const ability = bp.ability || bp.baseAbility || (set && set.ability);
  const tera = bp.terastallized || (opts.tera ? ((set && set.teraType) || bp.teraType) : undefined);
  const p = new Pokemon(gen, name, {
    level: bp.level || (set && set.level) || 100,
    ability: abilityName(gen, ability),
    item: itemName(gen, item),
    nature: (set && set.nature) || undefined,
    evs: (set && set.evs) || (gen.num >= 3 ? { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84 } : undefined),
    ivs: (set && set.ivs) || undefined,
    status: STATUS_MAP[bp.status] || '',
    boosts: boostsOf(bp),
    boostedStat: boostedStatOf(bp),
    teraType: tera || undefined,
    gender: bp.gender || undefined,
  });
  p.originalCurHP = Math.max(0, Math.round(p.rawStats.hp * pctHP(bp)));
  return p;
};

// ---------- field ----------

const WEATHER = {
  sunnyday: 'Sun', raindance: 'Rain', sandstorm: 'Sand', hail: 'Hail', snow: 'Snow', snowscape: 'Snow',
  desolateland: 'Harsh Sunshine', primordialsea: 'Heavy Rain', deltastream: 'Strong Winds',
};
const TERRAIN = { electricterrain: 'Electric', grassyterrain: 'Grassy', mistyterrain: 'Misty', psychicterrain: 'Psychic' };

export const weatherName = (w) => WEATHER[toID(w)] || '';
export const terrainName = (pw) => {
  for (const x of pw || []) { const t = TERRAIN[toID(x)]; if (t) return t; }
  return '';
};

const sideState = (side) => {
  const sc = side ? side.sideConditions || {} : {};
  const has = (k) => !!sc[k];
  return {
    isReflect: has('reflect'),
    isLightScreen: has('lightscreen'),
    isAuroraVeil: has('auroraveil'),
    isTailwind: has('tailwind'),
    // hazards deliberately omitted: they only matter on switch-in, and the calc would
    // fold them into KO chances for a Pokemon that is already on the field
    isFriendGuard: false,
  };
};

export const buildField = (gen, battle, attackerSide, defenderSide, actives) => {
  const pw = (battle.pseudoWeather || []).map(toID);
  const abil = (actives || []).map(p => toID(p && (p.ability || p.baseAbility)));
  return new Field({
    gameType: battle.gameType === 'doubles' ? 'Doubles' : 'Singles',
    weather: weatherName(battle.weather) || undefined,
    terrain: terrainName(battle.pseudoWeather) || undefined,
    isGravity: pw.includes('gravity'),
    isMagicRoom: pw.includes('magicroom'),
    isWonderRoom: pw.includes('wonderroom'),
    isBeadsOfRuin: abil.includes('beadsofruin'),
    isSwordOfRuin: abil.includes('swordofruin'),
    isTabletsOfRuin: abil.includes('tabletsofruin'),
    isVesselOfRuin: abil.includes('vesselofruin'),
    attackerSide: sideState(attackerSide),
    defenderSide: sideState(defenderSide),
  });
};

// ---------- calculations ----------

export const calcMove = (gen, attacker, defender, moveName, field, opts = {}) => {
  const md = moveData(gen, moveName);
  if (!md) return null;
  const base = { name: md.name, type: md.type, category: md.category, bp: md.basePower };
  if (!attacker || !defender) return base;
  if (md.category === 'Status') return { ...base, status: true };
  try {
    const move = new Move(gen, md.name, {
      ability: attacker.ability,
      item: attacker.item,
      species: attacker.name,
      isCrit: !!opts.crit,
      useMax: !!opts.max,
      useZ: !!opts.z,
    });
    const res = calculate(gen, attacker, defender, move, field);
    const r = res.range();
    const maxHP = defender.maxHP();
    const lo = Array.isArray(r) ? r[0] : r;
    const hi = Array.isArray(r) ? r[1] : r;
    let ko = '';
    try { ko = res.kochance(false).text || ''; } catch (e) { ko = ''; }
    let desc = '';
    try { desc = res.fullDesc('%', false); } catch (e) { try { desc = res.desc(); } catch (e2) { desc = ''; } }
    return {
      ...base,
      bp: move.bp,
      type: move.type,
      minPct: maxHP ? (lo / maxHP) * 100 : 0,
      maxPct: maxHP ? (hi / maxHP) * 100 : 0,
      minDmg: lo,
      maxDmg: hi,
      ko,
      desc,
      curPct: maxHP ? (defender.curHP() / maxHP) * 100 : 0,
    };
  } catch (e) {
    return { ...base, error: String(e && e.message) };
  }
};

export const speedOf = (gen, p, field, sideIsAttacker = true) => {
  if (!p) return 0;
  try {
    return getFinalSpeed(gen, p, field, sideIsAttacker ? field.attackerSide : field.defenderSide);
  } catch (e) {
    return p.stats.spe;
  }
};

// Speed envelope for a foe (field must have the foe as attackerSide): [min (0 EV, -nature, 0 IV), max (252+, +nature, 31 IV)] at current boosts.
export const speedRange = (gen, bp, field) => {
  const name = safeSpeciesName(gen, speciesOf(bp));
  if (!name) return null;
  const mk = (evs, ivs, nature) => {
    const p = new Pokemon(gen, name, {
      level: bp.level || 100, evs: { spe: evs }, ivs: { spe: ivs }, nature,
      boosts: boostsOf(bp), status: STATUS_MAP[bp.status] || '',
      ability: abilityName(gen, bp.ability || bp.baseAbility),
      item: itemName(gen, bp.item),
    });
    return speedOf(gen, p, field, true);
  };
  return [mk(0, 0, 'Brave'), mk(252, 31, 'Timid')];
};
