// Fetches preset sets (same public sources Showdex uses) and caches them for a day.
const api = typeof browser !== 'undefined' ? browser : chrome;
const BASE = 'https://pkmn.github.io';
const TTL = 24 * 60 * 60 * 1000;
const mem = {};

const candidates = (fid, gen, random) => {
  const g = `gen${gen || 9}`;
  if (random) {
    const doubles = /doubles/.test(fid);
    return [
      `${BASE}/randbats/data/${fid}.json`,
      `${BASE}/randbats/data/${g}random${doubles ? 'doubles' : ''}battle.json`,
    ];
  }
  const doubles = /doubles|vgc/.test(fid);
  return [
    `${BASE}/smogon/data/sets/${fid}.json`,
    `${BASE}/smogon/data/sets/${g}${doubles ? 'doublesou' : 'ou'}.json`,
  ];
};

const fetchSets = async ({ formatid, gen, random }) => {
  const key = `sets:${formatid}`;
  if (mem[key]) return mem[key];
  try {
    const stored = await api.storage.local.get(key);
    const hit = stored[key];
    if (hit && Date.now() - hit.at < TTL) { mem[key] = hit.data; return hit.data; }
  } catch (e) { /* ignore */ }
  for (const url of candidates(formatid, gen, random)) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      mem[key] = data;
      try { await api.storage.local.set({ [key]: { at: Date.now(), data } }); } catch (e) { /* quota */ }
      return data;
    } catch (e) { /* try next */ }
  }
  return null;
};

api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'getSets') return fetchSets(msg).then(data => ({ data }));
  return undefined;
});
