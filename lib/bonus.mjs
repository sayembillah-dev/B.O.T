// ════════════════════════════════════════════════════════════════════
//  BONUS PICKUPS — supply-drop crates fall from the sky every so often
//  (not frequent, never near a player), land on the terrain, and are
//  absorbed by driving over them. In online games the server owns the
//  drop schedule + type rolls and broadcasts crate state.
// ════════════════════════════════════════════════════════════════════

export const BONUS_DEFS = {
  x2:       { label: '×2',  name: '2× DAMAGE — next 2 hits', color: '#ffd75e' },
  x3:       { label: '×3',  name: '2× DAMAGE — next 3 hits', color: '#ff9d5e' },
  cluster:  { label: '💥',  name: 'CLUSTER BOMB',            color: '#8fd0ff' },
  hp10:     { label: '+10', name: 'REPAIR +10',              color: '#7be37b' },
  hp15:     { label: '+15', name: 'REPAIR +15',              color: '#4ee36b' },
  guided:   { label: '🎯',  name: 'GUIDED MISSILE',          color: '#ff5ad0' },
  tomahawk: { label: '🪓',  name: 'TOMAHAWK',                color: '#ff5a4e' },
};

// weighted loot table — guided/tomahawk are super rare, as ordered
const DROP_TABLE = [
  ['x2', 22], ['x3', 14],
  ['cluster', 16],
  ['hp10', 16], ['hp15', 12],
  ['guided', 7],   // super rare
  ['tomahawk', 5], // super rare
];

export function pickDropType(rnd = Math.random) {
  const total = DROP_TABLE.reduce((s, [, w]) => s + w, 0);
  let roll = rnd() * total;
  for (const [t, w] of DROP_TABLE) { roll -= w; if (roll <= 0) return t; }
  return 'x2';
}
