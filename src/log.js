// Turns Showdown battle protocol lines into terse, spreadsheet-friendly log rows.
const nameOf = (ident) => {
  if (!ident) return '';
  const i = ident.indexOf(': ');
  return i >= 0 ? ident.slice(i + 2) : ident;
};
const sideOf = (ident) => (ident || '').slice(0, 2);
const clean = (s) => (s || '').replace(/^(move|item|ability): /, '');
const from = (kw) => {
  const f = kw.find(k => k.startsWith('[from]'));
  return f ? ` (${clean(f.slice(7).trim())})` : '';
};

const SKIP = new Set([
  '', 't:', 'split', 'request', 'upkeep', 'gametype', 'player', 'teamsize', 'gen', 'tier', 'rule', 'clearpoke',
  'poke', 'teampreview', 'start', 'j', 'J', 'l', 'L', 'n', 'N', 'rated', 'seed', 'title', 'join', 'leave',
  'badge', 'bigerror', 'gen', ':', 'timestamp', 'uhtml', 'uhtmlchange', 'html', 'debug', '-hint', 'done',
  'init', 'variation', 'controlshtml', 'fieldhtml', 'tempnotify', 'tempnotifyoff', '-anim', 'sentchoice',
  'updatepoke', 'resisted_n', 'askreg', 'notify',
]);

const STAT = { atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe', accuracy: 'Acc', evasion: 'Eva' };

// returns { kind, text, side } or null
export const formatLine = (line, mySideId) => {
  if (!line || line[0] !== '|') return null;
  const parts = line.slice(1).split('|');
  const cmd = parts[0];
  if (SKIP.has(cmd)) return null;
  const args = parts.slice(1);
  const kw = args.filter(a => a.startsWith('['));
  const pos = args.filter(a => !a.startsWith('['));
  const who = (id) => {
    const s = sideOf(id);
    const tag = !mySideId ? s.toUpperCase() : s === mySideId ? 'You' : 'Opp';
    return `${tag} ${nameOf(id)}`;
  };
  const side = sideOf(pos[0]);
  const r = (kind, text) => ({ kind, text, side });
  switch (cmd) {
    case 'turn': return { kind: 'turn', text: `Turn ${pos[0]}` };
    case 'move': {
      const tgt = pos[2] && pos[2] !== pos[0] ? ` -> ${nameOf(pos[2])}` : '';
      return r('move', `${who(pos[0])}: ${pos[1]}${tgt}${kw.includes('[miss]') ? ' (missed)' : ''}${kw.includes('[still]') ? '' : ''}`);
    }
    case 'switch': case 'drag': case 'replace':
      return r('switch', `${who(pos[0])} in [${(pos[2] || '').split(' ')[0]}]${cmd === 'drag' ? ' (forced)' : ''}`);
    case 'swap': return r('info', `${who(pos[0])} swapped position`);
    case 'faint': return r('faint', `${who(pos[0])} fainted`);
    case '-damage': return r('dmg', `${who(pos[0])} HP ${pos[1]}${from(kw)}`);
    case '-heal': return r('heal', `${who(pos[0])} HP ${pos[1]}${from(kw)}`);
    case '-sethp': return r('info', `${who(pos[0])} HP ${pos[1]}`);
    case '-status': return r('status', `${who(pos[0])} ${pos[1].toUpperCase()}${from(kw)}`);
    case '-curestatus': return r('status', `${who(pos[0])} cured ${pos[1] || ''}`);
    case '-cureteam': return r('status', `${who(pos[0])} team cured`);
    case '-boost': return r('boost', `${who(pos[0])} ${STAT[pos[1]] || pos[1]} +${pos[2]}${from(kw)}`);
    case '-unboost': return r('boost', `${who(pos[0])} ${STAT[pos[1]] || pos[1]} -${pos[2]}${from(kw)}`);
    case '-setboost': return r('boost', `${who(pos[0])} ${STAT[pos[1]] || pos[1]} = ${pos[2]}`);
    case '-clearboost': case '-clearallboost': case '-clearnegativeboost': case '-clearpositiveboost':
      return r('boost', `${pos[0] ? who(pos[0]) + ' ' : ''}boosts cleared`);
    case '-weather':
      return pos[0] === 'none' ? r('field', 'Weather ended') : kw.includes('[upkeep]') ? null : r('field', `Weather: ${pos[0]}${from(kw)}`);
    case '-fieldstart': return r('field', `Field: ${clean(pos[0])}`);
    case '-fieldend': return r('field', `Field ended: ${clean(pos[0])}`);
    case '-sidestart': return r('field', `${sideOf(pos[0]) === mySideId ? 'Your' : 'Opp'} side: ${clean(pos[1])}`);
    case '-sideend': return r('field', `${sideOf(pos[0]) === mySideId ? 'Your' : 'Opp'} side ended: ${clean(pos[1])}`);
    case '-supereffective': return r('eff', '  super effective');
    case '-resisted': return r('eff', '  resisted');
    case '-immune': return r('eff', `  ${nameOf(pos[0])} immune${from(kw)}`);
    case '-crit': return r('eff', '  critical hit');
    case '-miss': return r('eff', `  missed ${nameOf(pos[1] || '')}`);
    case '-fail': return r('eff', `  failed${pos[1] ? ' (' + clean(pos[1]) + ')' : ''}`);
    case '-block': return r('eff', `  blocked (${clean(pos[1])})`);
    case '-item': return r('item', `${who(pos[0])} item: ${pos[1]}${from(kw)}`);
    case '-enditem': return r('item', `${who(pos[0])} lost ${pos[1]}${from(kw)}`);
    case '-ability': return r('item', `${who(pos[0])} ability: ${pos[1]}${from(kw)}`);
    case '-endability': return r('item', `${who(pos[0])} ability suppressed`);
    case '-terastallize': return r('item', `${who(pos[0])} Tera ${pos[1]}`);
    case '-mega': return r('item', `${who(pos[0])} Mega Evolved`);
    case 'detailschange': case '-formechange': return r('info', `${who(pos[0])} -> ${(pos[1] || '').split(',')[0]}`);
    case '-transform': return r('info', `${who(pos[0])} transformed into ${nameOf(pos[1])}`);
    case '-start': return r('info', `${who(pos[0])} ${clean(pos[1])}${from(kw)}`);
    case '-end': return r('info', `${who(pos[0])} ${clean(pos[1])} ended`);
    case '-activate': return r('info', `${pos[0] ? who(pos[0]) + ' ' : ''}${clean(pos[1])}`);
    case '-singleturn': case '-singlemove': return r('info', `${who(pos[0])} ${clean(pos[1])}`);
    case '-prepare': return r('info', `${who(pos[0])} preparing ${pos[1]}`);
    case '-mustrecharge': return r('info', `${who(pos[0])} must recharge`);
    case '-hitcount': return r('eff', `  hit ${pos[1]} time(s)`);
    case '-center': case '-combine': case '-waiting': return null;
    case 'cant': return r('info', `${who(pos[0])} can't move (${clean(pos[1])})`);
    case 'win': return { kind: 'result', text: `WINNER: ${pos[0]}` };
    case 'tie': return { kind: 'result', text: 'TIE' };
    case 'c': case 'chat': return { kind: 'chat', text: `${(pos[0] || '').trim()}: ${pos.slice(1).join('|')}` };
    case 'c:': return { kind: 'chat', text: `${(pos[1] || '').trim()}: ${pos.slice(2).join('|')}` };
    case 'inactive': case 'inactiveoff': return { kind: 'timer', text: pos.join(' ') };
    case 'raw': return { kind: 'info', text: pos.join('|').replace(/<[^>]*>/g, '').slice(0, 200) };
    case 'error': return { kind: 'error', text: pos.join(' ') };
    case 'message': return { kind: 'info', text: pos.join(' ') };
    default:
      if (cmd.startsWith('-')) return r('info', `${cmd.slice(1)} ${pos.map(nameOf).join(' ')}`);
      return null;
  }
};

export const formatLog = (lines, mySideId) => {
  const out = [];
  let turn = 0;
  let prev = '';
  for (const l of lines) {
    const f = formatLine(l, mySideId);
    if (!f) continue;
    if (f.kind === 'turn') turn = parseInt(f.text.slice(5), 10) || turn;
    if (f.text === prev) continue;
    prev = f.text;
    out.push({ ...f, turn });
  }
  return out;
};
