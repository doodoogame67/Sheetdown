// Runs in the Showdown page's own JS context (injected by content.js).
// Reads client state (classic Backbone `app` or Preact `PS`) and relays it to the
// content script as plain JSON. Executes send commands coming back.
(() => {
  if (window.__sheetdownPage) return;
  window.__sheetdownPage = true;

  const TAG = 'sheetdown';
  const LOG_LINES = 400;

  const host = () => {
    if (window.PS && typeof window.PS.join === 'function') return 'preact';
    if (window.app && typeof window.app.receive === 'function') return 'classic';
    return null;
  };

  const rawSend = (msg, roomid) => {
    const h = host();
    if (h === 'preact') return window.PS.send(msg, roomid || undefined);
    if (h === 'classic') return roomid ? window.app.send(msg, roomid) : window.app.send(msg);
  };

  const serPokemon = (p, side) => {
    if (!p) return null;
    return {
      ident: p.ident || '',
      name: p.name || '',
      speciesForme: p.speciesForme || '',
      details: p.details || '',
      level: p.level || 100,
      gender: p.gender || '',
      hp: p.hp,
      maxhp: p.maxhp,
      fainted: !!p.fainted,
      status: p.status || '',
      boosts: { ...(p.boosts || {}) },
      item: p.item || '',
      prevItem: p.prevItem || '',
      ability: p.ability || '',
      baseAbility: p.baseAbility || '',
      teraType: p.teraType || '',
      terastallized: p.terastallized || '',
      moves: (p.moveTrack || []).map(m => m[0]),
      volatiles: Object.keys(p.volatiles || {}),
      active: side.active.includes(p),
      activeIndex: side.active.indexOf(p),
    };
  };

  const serSide = (s, isMe) => {
    if (!s) return null;
    return {
      sideid: s.sideid,
      name: s.name,
      isMe,
      totalPokemon: s.totalPokemon,
      rating: s.rating || '',
      sideConditions: Object.fromEntries(
        Object.entries(s.sideConditions || {}).map(([k, v]) => [k, { name: v[0], levels: v[1] }])
      ),
      pokemon: (s.pokemon || []).map(p => serPokemon(p, s)),
      active: (s.active || []).map(p => (p ? s.pokemon.indexOf(p) : -1)),
    };
  };

  const listRooms = () => {
    const h = host();
    if (h === 'preact') return window.PS.rooms || {};
    if (h === 'classic') return window.app.rooms || {};
    return {};
  };

  const serBattleRoom = (id, room) => {
    const b = room.battle;
    if (!b) return null;
    let request = null;
    try { request = room.request ? JSON.parse(JSON.stringify(room.request)) : null; } catch (e) { request = null; }
    const mySideId = request && request.side ? request.side.id : null;
    const near = b.mySide || (b.sides && b.sides[0]);
    const far = b.farSide || (b.sides && b.sides[1]);
    const nearIsMe = !!(mySideId && near && near.sideid === mySideId);
    const q = b.stepQueue || [];
    return {
      id,
      title: room.title || id,
      gen: b.gen,
      tier: b.tier || '',
      gameType: b.gameType || 'singles',
      turn: b.turn,
      ended: !!b.ended,
      weather: b.weather || '',
      pseudoWeather: (b.pseudoWeather || []).map(w => w[0]),
      mySideId,
      near: serSide(near, nearIsMe),
      far: serSide(far, false),
      request,
      log: q.slice(Math.max(0, q.length - LOG_LINES)),
      logTotal: q.length,
    };
  };

  let fast = false;
  let quiet = false;
  // While disguised the battle scene is invisible, so skip its animations; otherwise
  // the client's state lags several turns behind the server during long animations.
  const fastForward = (rooms) => {
    if (!fast) return;
    for (const id of Object.keys(rooms)) {
      const bt = rooms[id] && rooms[id].battle;
      if (!bt || typeof bt.seekTurn !== 'function') continue;
      try {
        if (!bt.atQueueEnd && bt.seeking === null && bt.currentStep < (bt.stepQueue || []).length) bt.seekTurn(Infinity);
      } catch (e) { /* ignore */ }
    }
  };

  // Desktop notifications would say "Pokemon Showdown" in the OS tray.
  try {
    const RealNotification = window.Notification;
    if (RealNotification) {
      const Wrapped = function (title, opts) {
        if (quiet) return { close() {}, addEventListener() {}, removeEventListener() {} };
        return new RealNotification(title, opts);
      };
      Wrapped.prototype = RealNotification.prototype;
      Object.defineProperty(Wrapped, 'permission', { get: () => RealNotification.permission });
      Wrapped.requestPermission = RealNotification.requestPermission.bind(RealNotification);
      window.Notification = Wrapped;
    }
  } catch (e) { /* ignore */ }

  const snapshot = () => {
    const h = host();
    if (!h) return { host: null };
    const rooms = listRooms();
    fastForward(rooms);
    const battles = [];
    const roomList = [];
    for (const id of Object.keys(rooms)) {
      const room = rooms[id];
      if (!room || !id) continue;
      roomList.push({ id, type: room.type || '', title: room.title || id });
      if (room.battle && id.startsWith('battle-')) {
        try {
          const s = serBattleRoom(id, room);
          if (s) battles.push(s);
        } catch (e) {
          battles.push({ id, error: String(e && e.message) });
        }
      }
    }
    let user = '';
    let teams = [];
    let formats = [];
    try {
      if (h === 'preact') {
        user = window.PS.user && window.PS.user.name;
        teams = (window.PS.teams && window.PS.teams.list || []).map(t => ({ name: t.name, format: t.format, packed: t.packedTeam || '' }));
      } else {
        user = window.app.user && window.app.user.get('name');
        teams = (window.Storage && window.Storage.teams || []).map(t => ({ name: t.name, format: t.format, packed: t.team || '' }));
      }
      const bf = window.BattleFormats || {};
      formats = Object.keys(bf)
        .filter(k => bf[k] && bf[k].searchShow !== false && bf[k].effectType !== 'Section' && !bf[k].isSection)
        .map(k => ({ id: k, name: bf[k].name || k, team: bf[k].team || '', section: bf[k].section || '', rated: !!bf[k].rated }));
    } catch (e) { /* ignore */ }
    return { host: h, user, teams, formats, rooms: roomList, battles };
  };

  let lastJson = '';
  const push = (force) => {
    let snap;
    try { snap = snapshot(); } catch (e) { snap = { host: host(), error: String(e && e.message) }; }
    const json = JSON.stringify(snap);
    if (!force && json === lastJson) return;
    lastJson = json;
    window.postMessage({ source: TAG + '-page', type: 'snapshot', json }, '*');
  };

  const handlers = {
    send({ msg, roomid }) { rawSend(msg, roomid); },
    leave({ roomid }) {
      const h = host();
      if (h === 'preact') window.PS.leave(roomid);
      else if (h === 'classic') window.app.removeRoom(roomid);
    },
    focus({ roomid }) {
      const h = host();
      if (h === 'preact') window.PS.focusRoom ? window.PS.focusRoom(roomid) : window.PS.join(roomid);
      else if (h === 'classic') window.app.focusRoom(roomid);
    },
    mute({ on }) {
      try { if (window.BattleSound) window.BattleSound.setMute(!!on); } catch (e) { /* ignore */ }
    },
    refresh() { push(true); },
    disguise({ on, instant }) { quiet = !!on; fast = !!on && instant !== false; },
  };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== TAG + '-content') return;
    const fn = handlers[d.type];
    if (fn) {
      try { fn(d.payload || {}); } catch (e) { console.warn('[sheetdown]', e); }
      setTimeout(() => push(true), 50);
    }
  });

  setInterval(() => push(false), 350);
  push(true);
})();
