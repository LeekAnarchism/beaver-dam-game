// The AI engine (public/engine.js) reimplements the rules on a flat typed-array
// board so the search can use make/unmake and allocate nothing per node. That
// duplication is only safe if it provably matches the canonical rules in
// party/server.js — which is what this checks, on positions reached by legal
// play.
//
//   npm test
//
// If you change a rule, change it in party/server.js, public/index.html AND
// public/engine.js, then run this.
import * as E from '../public/engine.js';
import {
  freshBoard, getGroup, getValidPlacements, canMove, doMove, countTerritory, SIZE, DIRS,
} from '../party/server.js';

// ---- canonical-side helpers, written the slow obvious way on purpose ----
function refActions(board, player) {
  const acts = [];
  for (const id of getValidPlacements(board, player)) acts.push(`P:${id}`);
  const seen = new Set();
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    if (board[r][c] !== player || seen.has(r * SIZE + c)) continue;
    const g = getGroup(board, r, c);
    for (const [gr, gc] of g) seen.add(gr * SIZE + gc);
    const anchor = Math.min(...g.map(([gr, gc]) => gr * SIZE + gc));
    DIRS.forEach(([dr, dc], di) => { if (canMove(board, g, dr, dc)) acts.push(`M:${anchor}:${di}`); });
  }
  return acts;
}

// Independent reference for the dam line: plain Dijkstra, no heap, so a bug in
// the engine's heap can't hide behind an identical bug here.
function refDamGhosts(board) {
  const N = SIZE * SIZE;
  const centrality = r => Math.abs(2 * r - (SIZE - 1));
  const STEP = N * centrality(0) + 1;
  const GH = N * (STEP + centrality(0)) + 1;
  const cost = (r, c) => (board[r][c] ? 0 : GH) + STEP + centrality(r);
  const dist = new Array(N).fill(Infinity), prev = new Array(N).fill(-1), done = new Array(N).fill(false);
  for (let r = 0; r < SIZE; r++) dist[r * SIZE] = cost(r, 0);
  for (;;) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < bd) { bd = dist[i]; best = i; }
    if (best === -1) break;
    done[best] = true;
    const r = (best / SIZE) | 0, c = best % SIZE;
    if (c === SIZE - 1) break;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
      const id = nr * SIZE + nc, nd = bd + cost(nr, nc);
      if (nd < dist[id]) { dist[id] = nd; prev[id] = best; }
    }
  }
  let end = -1, ed = Infinity;
  for (let r = 0; r < SIZE; r++) { const i = r * SIZE + (SIZE - 1); if (dist[i] < ed) { ed = dist[i]; end = i; } }
  if (end === -1 || ed === Infinity) return null;
  const ghosts = [];
  for (let i = end; i !== -1; i = prev[i]) if (!board[(i / SIZE) | 0][i % SIZE]) ghosts.push(i);
  return ghosts.sort((a, b) => a - b);
}

function rng(seed) {
  let s = seed | 0;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

// ---- the comparison ----
const fails = { moves: 0, terr: 0, dam: 0, unmake: 0, hash: 0 };
const notes = [];
let positions = 0;

const buf = new Int32Array(512);
const ghostBuf = new Int32Array(E.N);

for (let game = 0; game < 40; game++) {
  const rnd = rng(6000 + game);
  const st = E.newState();
  const refBoard = freshBoard();
  let player = 'red';

  for (let ply = 0; ply < 60; ply++) {
    positions++;

    const ref = new Set(refActions(refBoard, player));
    const n = E.genMoves(st, buf);
    const eng = new Set();
    for (let i = 0; i < n; i++) {
      const m = buf[i];
      if (E.isPass(m)) continue;   // the canonical helper doesn't enumerate passes
      eng.add(E.isSlide(m) ? `M:${E.moveCell(m)}:${E.moveDir(m)}` : `P:${E.moveCell(m)}`);
    }
    if (ref.size !== eng.size || [...ref].some(k => !eng.has(k))) {
      if (!fails.moves) notes.push(`move generation: game ${game} ply ${ply} — canonical ${ref.size}, engine ${eng.size}`);
      fails.moves++;
    }

    const rt = countTerritory(refBoard), et = E.countTerritory(st.board);
    if (rt.redScore !== et.red || rt.blackScore !== et.black) {
      if (!fails.terr) notes.push(`territory: game ${game} ply ${ply} — canonical ${rt.redScore}/${rt.blackScore}, engine ${et.red}/${et.black}`);
      fails.terr++;
    }

    const refG = refDamGhosts(refBoard);
    const gc = E.findDamGhosts(st.board, ghostBuf);
    const engG = Array.from(ghostBuf.slice(0, Math.max(gc, 0))).sort((a, b) => a - b);
    if (!refG || gc < 0 || refG.length !== engG.length || refG.some((v, i) => v !== engG[i])) {
      if (!fails.dam) notes.push(`dam line: game ${game} ply ${ply} — canonical ${refG && refG.length}, engine ${gc}`);
      fails.dam++;
    }

    E.rehash(st);
    const board0 = Int8Array.from(st.board), lo0 = st.hashLo, hi0 = st.hashHi;
    for (let i = 0; i < n; i++) {
      E.makeMove(st, buf[i]);
      E.unmakeMove(st);
      let ok = st.hashLo === lo0 && st.hashHi === hi0;
      if (ok) for (let c = 0; c < E.N; c++) if (st.board[c] !== board0[c]) { ok = false; break; }
      if (!ok) {
        if (!fails.unmake) notes.push(`make/unmake: game ${game} ply ${ply} did not restore the position`);
        fails.unmake++;
        st.board.set(board0); st.hashLo = lo0; st.hashHi = hi0;
      }
    }

    const refList = refActions(refBoard, player);
    if (!refList.length) break;
    const pick = refList[Math.floor(rnd() * refList.length)];
    let chosen = -1;
    for (let i = 0; i < n; i++) {
      const m = buf[i];
      if (E.isPass(m)) continue;
      const k = E.isSlide(m) ? `M:${E.moveCell(m)}:${E.moveDir(m)}` : `P:${E.moveCell(m)}`;
      if (k === pick) { chosen = m; break; }
    }
    if (chosen === -1) break;

    E.makeMove(st, chosen);
    const incLo = st.hashLo, incHi = st.hashHi;
    E.rehash(st);
    if (incLo !== st.hashLo || incHi !== st.hashHi) {
      if (!fails.hash) notes.push(`incremental hash drifted from a full rehash at game ${game} ply ${ply}`);
      fails.hash++;
    }

    // apply the same move to the canonical board
    const [kind, a, b] = pick.split(':');
    if (kind === 'P') {
      refBoard[(a / SIZE) | 0][a % SIZE] = player;
    } else {
      const anchor = +a, di = +b;
      const g = getGroup(refBoard, (anchor / SIZE) | 0, anchor % SIZE);
      doMove(refBoard, g, DIRS[di][0], DIRS[di][1]);
    }
    player = player === 'red' ? 'black' : 'red';
  }
}

const rows = [
  ['move generation', fails.moves],
  ['territory count', fails.terr],
  ['dam line', fails.dam],
  ['make/unmake', fails.unmake],
  ['incremental hash', fails.hash],
];
console.log(`engine vs canonical rules — ${positions} positions from 40 games\n`);
for (const [name, f] of rows) console.log(`  ${name.padEnd(18)} ${f === 0 ? 'ok' : `${f} MISMATCHES`}`);
if (notes.length) { console.log(''); notes.forEach(n => console.log('  ' + n)); }

const total = rows.reduce((s, [, f]) => s + f, 0);
console.log(total === 0 ? '\nPASS — engine matches the canonical rules' : '\nFAIL — engine diverges');
process.exit(total === 0 ? 0 : 1);
