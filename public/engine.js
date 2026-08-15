// Beaver Dam search engine.
//
// Deliberately a separate implementation of the rules from party/server.js: the
// search needs a flat typed-array board, make/unmake instead of cloning, and
// zero allocation per node. difftest.mjs checks it agrees with the canonical
// rules exactly, on random positions, so the duplication stays honest.
//
// Written as a plain ES module with no Node APIs, so the same file can run in a
// Web Worker.

export const SIZE = 12;
export const N = SIZE * SIZE;
export const EMPTY = 0, RED = 1, BLACK = 2, GHOST = 3;

const opp = p => (p === RED ? BLACK : RED);
export { opp };

// ---------------------------------------------------------------- geometry
const ORTH = [], KING = [];
for (let i = 0; i < N; i++) {
  const r = (i / SIZE) | 0, c = i % SIZE, o = [], k = [];
  for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) o.push(nr * SIZE + nc);
  }
  for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) k.push(nr * SIZE + nc);
  }
  ORTH.push(Int32Array.from(o));
  KING.push(Int32Array.from(k));
}
const homeRowOf = p => (p === RED ? 0 : SIZE - 1);
const rowOf = i => (i / SIZE) | 0;

// The four slide directions, as cell-index deltas plus their row/col steps so
// bounds checks stay exact (a raw index delta would wrap around rows).
export const DIRS = [
  { dr: 0,  dc: 1  }, { dr: 0,  dc: -1 },
  { dr: 1,  dc: 0  }, { dr: -1, dc: 0  },
];

// ---------------------------------------------------------------- state
export function newState() {
  return {
    board: new Int8Array(N),
    stm: RED,
    hashLo: 0, hashHi: 0,
    ply: 0,
    passes: 0,        // consecutive passes; two ends the game
  };
}
export const isOver = st => st.passes >= 2;

// Zobrist keys, split into two 32-bit halves for a 64-bit key.
const ZLO = new Int32Array(N * 3), ZHI = new Int32Array(N * 3);
{
  let s = 0x9e3779b9;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s | 0; };
  for (let i = 0; i < N * 3; i++) { ZLO[i] = rnd(); ZHI[i] = rnd(); }
}
const ZSTM_LO = 0x5bf03635 | 0, ZSTM_HI = 0x2545f491 | 0;
const zIdx = (cell, piece) => cell * 3 + (piece - 1);

export function rehash(st) {
  let lo = 0, hi = 0;
  for (let i = 0; i < N; i++) {
    const p = st.board[i];
    if (p) { lo ^= ZLO[zIdx(i, p)]; hi ^= ZHI[zIdx(i, p)]; }
  }
  if (st.stm === BLACK) { lo ^= ZSTM_LO; hi ^= ZSTM_HI; }
  st.hashLo = lo | 0; st.hashHi = hi | 0;
}

function togglePiece(st, cell, piece) {
  const k = zIdx(cell, piece);
  st.hashLo = (st.hashLo ^ ZLO[k]) | 0;
  st.hashHi = (st.hashHi ^ ZHI[k]) | 0;
}
function toggleStm(st) {
  st.hashLo = (st.hashLo ^ ZSTM_LO) | 0;
  st.hashHi = (st.hashHi ^ ZSTM_HI) | 0;
}

// ---------------------------------------------------------------- scratch
// Generation-stamped visited arrays: no clearing between uses.
const seen = new Int32Array(N);
let stamp = 0;
const nextStamp = () => ++stamp;

const queue = new Int32Array(N);
const groupBuf = new Int32Array(N);
// Separate visited arrays per purpose. Sharing one caused genMoves to emit
// duplicate slides: canSlide()/groupAt() re-stamped the very cells genMoves was
// using to mark groups as already processed.
const groupSeen = new Int32Array(N);
const slideSeen = new Int32Array(N);

// Connected same-colour group containing `cell`. Writes into `out`, returns size.
export function groupAt(board, cell, out) {
  const colour = board[cell];
  if (!colour) return 0;
  const s = nextStamp();
  let head = 0, tail = 0, n = 0;
  queue[tail++] = cell; seen[cell] = s;
  while (head < tail) {
    const cur = queue[head++];
    out[n++] = cur;
    const nb = ORTH[cur];
    for (let i = 0; i < nb.length; i++) {
      const x = nb[i];
      if (seen[x] !== s && board[x] === colour) { seen[x] = s; queue[tail++] = x; }
    }
  }
  return n;
}

// Cells of `player` connected back to their home row. Stamps `seen` with the
// returned stamp, so callers can test membership with seen[cell] === stamp.
function markHomeConnected(board, player) {
  const s = nextStamp();
  const hr = homeRowOf(player);
  let head = 0, tail = 0;
  for (let c = 0; c < SIZE; c++) {
    const i = hr * SIZE + c;
    if (board[i] === player) { seen[i] = s; queue[tail++] = i; }
  }
  while (head < tail) {
    const cur = queue[head++];
    const nb = ORTH[cur];
    for (let i = 0; i < nb.length; i++) {
      const x = nb[i];
      if (seen[x] !== s && board[x] === player) { seen[x] = s; queue[tail++] = x; }
    }
  }
  return s;
}

// ---------------------------------------------------------------- moves
// Encoding: placement = cell | (0 << 8); slide = anchor | (1 << 8) | (dir << 12)
// PASS is a distinct sentinel — test it before anything else, since its low bits
// would otherwise read as a placement on cell 0.
export const PASS = 1 << 20;
export const isPass = m => m === PASS;
export const mkPlace = cell => cell;
export const mkSlide = (anchor, dir) => anchor | 256 | (dir << 12);
export const isSlide = m => m !== PASS && (m & 256) !== 0;
export const moveCell = m => m & 255;
export const moveDir = m => (m >> 12) & 3;

const placeSeen = new Int32Array(N);

export function genMoves(st, out) {
  const board = st.board, p = st.stm;
  let n = 0;

  // placements: own home row, plus squares adjacent to home-connected cubes,
  // both confined to the build zone
  const hr = homeRowOf(p);
  const minRow = p === RED ? 0 : SIZE - 4;
  const maxRow = p === RED ? 3 : SIZE - 1;
  const ps = nextStamp();
  for (let c = 0; c < SIZE; c++) {
    const i = hr * SIZE + c;
    if (!board[i] && placeSeen[i] !== ps) { placeSeen[i] = ps; out[n++] = mkPlace(i); }
  }
  const hs = markHomeConnected(board, p);
  for (let i = 0; i < N; i++) {
    if (board[i] !== p || seen[i] !== hs) continue;
    const nb = ORTH[i];
    for (let j = 0; j < nb.length; j++) {
      const x = nb[j], r = rowOf(x);
      if (r >= minRow && r <= maxRow && !board[x] && placeSeen[x] !== ps) {
        placeSeen[x] = ps; out[n++] = mkPlace(x);
      }
    }
  }

  // slides: each distinct group, each direction, whole path clear
  const gs = nextStamp();
  for (let i = 0; i < N; i++) {
    if (board[i] !== p || groupSeen[i] === gs) continue;
    const sz = groupAt(board, i, groupBuf);
    for (let g = 0; g < sz; g++) groupSeen[groupBuf[g]] = gs;
    const gcopy = groupBuf.slice(0, sz);
    for (let d = 0; d < 4; d++) {
      if (canSlide(board, gcopy, sz, d)) out[n++] = mkSlide(i, d);
    }
  }

  out[n++] = PASS;   // always legal, and the game's own termination mechanism
  return n;
}

// A group of size n slides exactly n squares; every square each cube crosses,
// and lands on, must be empty or vacated by the group itself.
function canSlide(board, group, n, d) {
  const { dr, dc } = DIRS[d];
  const s = nextStamp();
  for (let i = 0; i < n; i++) slideSeen[group[i]] = s;
  for (let i = 0; i < n; i++) {
    const cell = group[i];
    let r = rowOf(cell), c = cell % SIZE;
    for (let step = 1; step <= n; step++) {
      r += dr; c += dc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return false;
      const x = r * SIZE + c;
      if (board[x] && slideSeen[x] !== s) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- make/unmake
const MAX_PLY = 256;
const undoCells = [], undoCount = new Int32Array(MAX_PLY), undoKind = new Int32Array(MAX_PLY);
const undoDir = new Int32Array(MAX_PLY);
for (let i = 0; i < MAX_PLY; i++) undoCells.push(new Int32Array(N));

const undoPasses = new Int32Array(MAX_PLY);

export function makeMove(st, m) {
  const board = st.board, p = st.stm, ply = st.ply;
  undoPasses[ply] = st.passes;
  if (isPass(m)) {
    st.passes++;
    undoKind[ply] = 2; undoCount[ply] = 0;
    st.stm = opp(p); toggleStm(st); st.ply++;
    return;
  }
  st.passes = 0;
  if (!isSlide(m)) {
    const cell = moveCell(m);
    board[cell] = p;
    togglePiece(st, cell, p);
    undoKind[ply] = 0;
    undoCells[ply][0] = cell;
    undoCount[ply] = 1;
  } else {
    const d = moveDir(m), { dr, dc } = DIRS[d];
    const sz = groupAt(board, moveCell(m), groupBuf);
    const store = undoCells[ply];
    for (let i = 0; i < sz; i++) store[i] = groupBuf[i];
    undoKind[ply] = 1; undoCount[ply] = sz; undoDir[ply] = d;
    const delta = dr * sz * SIZE + dc * sz;
    for (let i = 0; i < sz; i++) { const c = store[i]; board[c] = EMPTY; togglePiece(st, c, p); }
    for (let i = 0; i < sz; i++) { const c = store[i] + delta; board[c] = p; togglePiece(st, c, p); }
  }
  st.stm = opp(p); toggleStm(st); st.ply++;
}

export function unmakeMove(st) {
  st.ply--;
  const ply = st.ply, board = st.board;
  st.stm = opp(st.stm); toggleStm(st);
  st.passes = undoPasses[ply];
  if (undoKind[ply] === 2) return;   // pass: nothing on the board changed
  const p = st.stm;
  const store = undoCells[ply], cnt = undoCount[ply];
  if (undoKind[ply] === 0) {
    board[store[0]] = EMPTY; togglePiece(st, store[0], p);
  } else {
    const { dr, dc } = DIRS[undoDir[ply]];
    const delta = dr * cnt * SIZE + dc * cnt;
    for (let i = 0; i < cnt; i++) { const c = store[i] + delta; board[c] = EMPTY; togglePiece(st, c, p); }
    for (let i = 0; i < cnt; i++) { const c = store[i]; board[c] = p; togglePiece(st, c, p); }
  }
}

// ---------------------------------------------------------------- territory
const terrOut = { red: 0, black: 0 };
const reachRed = new Int32Array(N), reachBlack = new Int32Array(N);

function floodFrom(board, homeRow, mark, s) {
  let head = 0, tail = 0;
  for (let c = 0; c < SIZE; c++) {
    const i = homeRow * SIZE + c;
    if (!board[i]) { mark[i] = s; queue[tail++] = i; }
  }
  while (head < tail) {
    const cur = queue[head++];
    const nb = ORTH[cur];
    for (let i = 0; i < nb.length; i++) {
      const x = nb[i];
      if (mark[x] !== s && !board[x]) { mark[x] = s; queue[tail++] = x; }
    }
  }
}

// Empty squares reachable from exactly one home row score for that side.
export function countTerritory(board) {
  const s = nextStamp();
  floodFrom(board, 0, reachRed, s);
  floodFrom(board, SIZE - 1, reachBlack, s);
  let r = 0, b = 0;
  for (let i = 0; i < N; i++) {
    const inR = reachRed[i] === s, inB = reachBlack[i] === s;
    if (inR && !inB) r++; else if (inB && !inR) b++;
  }
  terrOut.red = r; terrOut.black = b;
  return terrOut;
}

// ---------------------------------------------------------------- dam line
// Same three-tier cost as the UI: fewest ghost blocks, then shortest line, then
// most central. Binary heap instead of the UI's linear scan.
const centrality = r => Math.abs(2 * r - (SIZE - 1));
const STEP_COST = N * centrality(0) + 1;
const GHOST_COST = N * (STEP_COST + centrality(0)) + 1;
export { STEP_COST, GHOST_COST };

const dist = new Float64Array(N), prev = new Int32Array(N), settled = new Int32Array(N);
const heapNode = new Int32Array(N * 4), heapKey = new Float64Array(N * 4);
let heapSize = 0;

// Ties break on lower cell index, so equal-cost nodes settle in exactly the
// order the UI's linear-scan Dijkstra settles them. Without this the two pick
// different — equally cheap — dam lines, and the overlay would show the player a
// different line from the one the bot is playing to.
const heapLess = (a, b) =>
  heapKey[a] < heapKey[b] || (heapKey[a] === heapKey[b] && heapNode[a] < heapNode[b]);

function heapSwap(a, b) {
  const tn = heapNode[a], tk = heapKey[a];
  heapNode[a] = heapNode[b]; heapKey[a] = heapKey[b];
  heapNode[b] = tn; heapKey[b] = tk;
}

function heapPush(node, key) {
  let i = heapSize++;
  heapNode[i] = node; heapKey[i] = key;
  while (i > 0) {
    const par = (i - 1) >> 1;
    if (!heapLess(i, par)) break;
    heapSwap(i, par);
    i = par;
  }
}
function heapPop() {
  const top = heapNode[0];
  heapSize--;
  if (heapSize > 0) {
    heapNode[0] = heapNode[heapSize]; heapKey[0] = heapKey[heapSize];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < heapSize && heapLess(l, m)) m = l;
      if (r < heapSize && heapLess(r, m)) m = r;
      if (m === i) break;
      heapSwap(m, i);
      i = m;
    }
  }
  return top;
}

// Writes the ghost squares into `ghosts`, returns how many.
export function findDamGhosts(board, ghosts) {
  const s = nextStamp();
  heapSize = 0;
  for (let i = 0; i < N; i++) { dist[i] = Infinity; prev[i] = -1; }
  const stepCost = cell => (board[cell] ? 0 : GHOST_COST) + STEP_COST + centrality(rowOf(cell));
  for (let r = 0; r < SIZE; r++) {
    const i = r * SIZE;
    dist[i] = stepCost(i);
    heapPush(i, dist[i]);
  }
  while (heapSize > 0) {
    const cur = heapPop();
    if (settled[cur] === s) continue;
    settled[cur] = s;
    if (cur % SIZE === SIZE - 1) break;
    const nb = KING[cur];
    for (let i = 0; i < nb.length; i++) {
      const x = nb[i];
      if (settled[x] === s) continue;
      const nd = dist[cur] + stepCost(x);
      if (nd < dist[x]) { dist[x] = nd; prev[x] = cur; heapPush(x, nd); }
    }
  }
  // Mirror the UI exactly: scan the right column and take the strictly-smallest
  // distance, so the lowest row wins a tie.
  let end = -1, endD = Infinity;
  for (let r = 0; r < SIZE; r++) {
    const i = r * SIZE + (SIZE - 1);
    if (dist[i] < endD) { endD = dist[i]; end = i; }
  }
  if (end === -1 || endD === Infinity) return -1;
  let n = 0;
  for (let i = end; i !== -1; i = prev[i]) if (!board[i]) ghosts[n++] = i;
  return n;
}

// ---------------------------------------------------------------- eval
const ghostBuf = new Int32Array(N);
const MID = (SIZE - 1) / 2;

// Pure dam projection, no extra terms. Tested against forward-weighted material
// and advancement at depth 5: the plain eval had the best record, and the
// differences between weighted variants were intransitive, i.e. noise.
export const defaultWeights = { material: 0, adv: 0 };

// Positive is good for RED. Pure function of the position, so it is safe to
// cache in the transposition table.
export function evaluate(board, w = defaultWeights) {
  const act = countTerritory(board);
  const actMargin = act.red - act.black;

  const gc = findDamGhosts(board, ghostBuf);
  let projMargin = actMargin, ghosts = SIZE;
  if (gc >= 0) {
    ghosts = gc;
    for (let i = 0; i < gc; i++) board[ghostBuf[i]] = GHOST;
    const proj = countTerritory(board);
    projMargin = proj.red - proj.black;
    for (let i = 0; i < gc; i++) board[ghostBuf[i]] = EMPTY;
  }

  const trust = Math.max(0, 1 - ghosts / SIZE);
  let v = actMargin + (projMargin - actMargin) * trust;

  if (w.material || w.adv) {
    let red = 0, black = 0;
    for (let i = 0; i < N; i++) {
      const p = board[i];
      if (!p) continue;
      const r = rowOf(i);
      const a = p === RED ? r : SIZE - 1 - r;
      const s = w.material + w.adv * (a + Math.max(0, a - MID));
      if (p === RED) red += s; else black += s;
    }
    v += red - black;
  }
  return v;
}

// ---------------------------------------------------------------- transposition table
const TT_BITS = 20, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
const ttKey = new Int32Array(TT_SIZE);
const ttMove = new Int32Array(TT_SIZE);
const ttVal = new Float64Array(TT_SIZE);
const ttMeta = new Int32Array(TT_SIZE);   // depth << 2 | flag
const EXACT = 0, LOWER = 1, UPPER = 2;
let ttGen = 0;
export function clearTT() { ttKey.fill(0); ttGen++; }

// ---------------------------------------------------------------- search
// Indexed by st.ply, which search() resets to 0 so it means "depth below the
// root", not "how many moves the game has lasted".
const moveLists = [];
for (let i = 0; i < MAX_PLY; i++) moveLists.push(new Int32Array(512));
const orderScore = new Float64Array(512);

export const stats = { nodes: 0, evals: 0, ttHits: 0, aborted: false };
let deadline = Infinity;

// Killer moves (two per ply) and a history table. Both are pure ordering aids:
// they change how fast the tree is searched, never the value returned.
const MOVE_SPACE = 1 << 14;
const killer1 = new Int32Array(MAX_PLY), killer2 = new Int32Array(MAX_PLY);
const history = new Float64Array(2 * MOVE_SPACE);
// PASS gets its own slot: its low bits would otherwise alias placement on cell 0.
const histIdx = (p, m) => (p === RED ? 0 : MOVE_SPACE) + (m === PASS ? MOVE_SPACE - 1 : (m & (MOVE_SPACE - 1)));
export let orderingEnabled = true;
export function setOrdering(on) { orderingEnabled = on; }
function clearOrderingTables() { killer1.fill(0); killer2.fill(0); history.fill(0); }

function orderMoves(st, list, n, ttBest) {
  const p = st.stm, ply = st.ply;
  for (let i = 0; i < n; i++) {
    const m = list[i];
    let s;
    if (m === ttBest) s = 1e9;
    else if (orderingEnabled && m === killer1[ply]) s = 9e8;
    else if (orderingEnabled && m === killer2[ply]) s = 8e8;
    else {
      if (isPass(m)) {
        s = 0;   // legal everywhere and rarely best, so try it last
      } else if (!isSlide(m)) {
        const r = rowOf(moveCell(m));
        s = 100 + (p === RED ? r : SIZE - 1 - r);
      } else {
        const d = DIRS[moveDir(m)];
        const fwd = p === RED ? d.dr : -d.dr;
        s = 50 + fwd * 10;
      }
      if (orderingEnabled) s += history[histIdx(p, m)];
    }
    orderScore[i] = s;
  }
  // insertion sort: n is small (~20) and this keeps it allocation-free
  for (let i = 1; i < n; i++) {
    const m = list[i], s = orderScore[i];
    let j = i - 1;
    while (j >= 0 && orderScore[j] < s) { list[j + 1] = list[j]; orderScore[j + 1] = orderScore[j]; j--; }
    list[j + 1] = m; orderScore[j + 1] = s;
  }
}

function negamax(st, depth, alpha, beta, w) {
  stats.nodes++;
  if ((stats.nodes & 1023) === 0 && Date.now() > deadline) { stats.aborted = true; return 0; }

  // Two passes end the game, and its value is the exact count — no heuristic.
  // This is what gives passing its meaning: a side that is ahead can bank the
  // score, a side that is behind must keep playing.
  if (isOver(st)) {
    const t = countTerritory(st.board);
    const m = t.red - t.black;
    return st.stm === RED ? m : -m;
  }

  // Pass count is part of the position: the same board one pass in is not the
  // same node as the same board with the counter reset.
  const passMix = st.passes * 0x9e3779b9;
  const idx = (st.hashLo ^ (st.hashHi << 1) ^ passMix) & TT_MASK;
  const want = (st.hashHi ^ (st.passes * 0x85ebca6b)) | 1;
  let ttBest = 0;
  if (ttKey[idx] === want) {
    const meta = ttMeta[idx], d = meta >> 2, flag = meta & 3;
    ttBest = ttMove[idx];
    if (d >= depth) {
      const v = ttVal[idx];
      if (flag === EXACT) { stats.ttHits++; return v; }
      if (flag === LOWER && v >= beta) { stats.ttHits++; return v; }
      if (flag === UPPER && v <= alpha) { stats.ttHits++; return v; }
    }
  }

  if (depth === 0) {
    stats.evals++;
    const v = evaluate(st.board, w);
    return st.stm === RED ? v : -v;
  }

  const list = moveLists[st.ply];
  const n = genMoves(st, list);
  if (n === 0) {
    stats.evals++;
    const v = evaluate(st.board, w);
    return st.stm === RED ? v : -v;
  }
  orderMoves(st, list, n, ttBest);

  const alpha0 = alpha, ply = st.ply, stm = st.stm;
  let best = -Infinity, bestMove = list[0];
  for (let i = 0; i < n; i++) {
    const m = list[i];
    makeMove(st, m);
    let v;
    if (i === 0 || !orderingEnabled) {
      v = -negamax(st, depth - 1, -beta, -alpha, w);
    } else {
      // PVS: assume the first move is best and verify the rest with a null
      // window, re-searching only when one beats alpha.
      v = -negamax(st, depth - 1, -alpha - 1e-9, -alpha, w);
      if (v > alpha && v < beta) v = -negamax(st, depth - 1, -beta, -alpha, w);
    }
    unmakeMove(st);
    if (stats.aborted) return 0;
    if (v > best) { best = v; bestMove = m; }
    if (best > alpha) alpha = best;
    if (alpha >= beta) {
      if (orderingEnabled && m !== killer1[ply]) { killer2[ply] = killer1[ply]; killer1[ply] = m; }
      if (orderingEnabled) history[histIdx(stm, m)] += depth * depth;
      break;
    }
  }

  ttKey[idx] = want;
  ttMove[idx] = bestMove;
  ttVal[idx] = best;
  ttMeta[idx] = (depth << 2) | (best <= alpha0 ? UPPER : best >= beta ? LOWER : EXACT);
  return best;
}

// Iterative deepening. Returns the best move found within the budget.
export function search(st, { maxDepth = 64, timeMs = 1000, weights = defaultWeights } = {}) {
  deadline = Date.now() + timeMs;
  stats.nodes = 0; stats.evals = 0; stats.ttHits = 0; stats.aborted = false;
  rehash(st);
  st.ply = 0;   // ply is the search stack pointer, not the game's move count
  clearOrderingTables();

  const root = new Int32Array(512);
  const n = genMoves(st, root);
  if (n === 0) return { move: -1, score: 0, depth: 0 };

  let bestMove = root[0], bestScore = 0, reached = 0, rootMoves = [];
  for (let depth = 1; depth <= maxDepth; depth++) {
    let alpha = -Infinity;
    let localBest = bestMove, localScore = -Infinity;
    const scored = [];
    orderMoves(st, root, n, bestMove);
    for (let i = 0; i < n; i++) {
      const m = root[i];
      makeMove(st, m);
      const v = -negamax(st, depth - 1, -Infinity, -alpha, weights);
      unmakeMove(st);
      if (stats.aborted) break;
      scored.push({ move: m, score: v });
      if (v > localScore) { localScore = v; localBest = m; }
      if (v > alpha) alpha = v;
    }
    if (stats.aborted) break;
    bestMove = localBest; bestScore = localScore; reached = depth;
    // Scores for non-best moves are alpha-bounded rather than exact, which is
    // fine for the only thing they are used for: picking a plausible weaker
    // move at low difficulty.
    rootMoves = scored;
    if (Date.now() > deadline) break;
  }
  return { move: bestMove, score: bestScore, depth: reached, nodes: stats.nodes, rootMoves };
}
