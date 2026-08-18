// AI opponent. Runs the search off the main thread so the board stays
// responsive while the bot thinks.
//
// Difficulty arrives with every request rather than being fixed at construction,
// so changing it mid-game takes effect on the bot's very next move.
import * as E from './engine.js';

export const LEVELS = [
  { name: 'Beginner', maxDepth: 1, timeMs: 200,  slack: 10 },
  { name: 'Easy',     maxDepth: 2, timeMs: 400,  slack: 5  },
  { name: 'Normal',   maxDepth: 3, timeMs: 800,  slack: 2  },
  { name: 'Strong',   maxDepth: 4, timeMs: 1500, slack: 0  },
  { name: 'Max',      maxDepth: 8, timeMs: 2500, slack: 0  },
];

const scratch = new Int32Array(512);

// Every position the bot has been asked to move from, plus every position its
// own move created. Used to refuse moves that recreate a position we have
// already been in — without it the bot shuffles between two squares forever
// once nothing can improve its score.
let history = new Set();

function stateFrom(boardArray, stm, passes) {
  const st = E.newState();
  for (let i = 0; i < E.N; i++) st.board[i] = boardArray[i];
  st.stm = stm; st.passes = passes; st.ply = 0;
  E.rehash(st);
  return st;
}

function boardKey(board, stm) {
  let s = stm === E.RED ? 'R' : 'B';
  for (let i = 0; i < E.N; i++) s += board[i];
  return s;
}

// Exact territory margin for `me`, independent of whose turn it is.
function exactMargin(board, me) {
  const t = E.countTerritory(board);
  return me === E.RED ? t.red - t.black : t.black - t.red;
}

// Is there any move at all that raises our real score? If not, the position is
// dead and playing on just shuffles cubes around.
function canImprove(st) {
  const me = st.stm;
  const base = exactMargin(st.board, me);
  const n = E.genMoves(st, scratch);
  const moves = Array.from(scratch.slice(0, n));
  for (const m of moves) {
    if (E.isPass(m)) continue;
    E.makeMove(st, m);
    const after = exactMargin(st.board, me);
    E.unmakeMove(st);
    if (after > base) return true;
  }
  return false;
}

function keyAfter(st, m) {
  E.makeMove(st, m);
  const k = boardKey(st.board, st.stm);
  E.unmakeMove(st);
  return k;
}

// Turn an engine move into the same shape a human click produces, so the main
// thread can apply it through its existing code path.
function describe(m) {
  if (m === -1 || E.isPass(m)) return { kind: 'pass' };
  const cell = E.moveCell(m);
  const r = (cell / E.SIZE) | 0, c = cell % E.SIZE;
  if (!E.isSlide(m)) return { kind: 'place', r, c };
  const d = E.DIRS[E.moveDir(m)];
  return { kind: 'move', r, c, dr: d.dr, dc: d.dc };
}

// Weaker levels pick among moves within `slack` of the best rather than playing
// a random blunder — the bot stays coherent, it just misses the sharpest line.
// Moves that would repeat a previous position are avoided wherever possible,
// even at some cost in score.
function pickMove(st, result, slack) {
  const cands = (result.rootMoves && result.rootMoves.length
    ? result.rootMoves
    : [{ move: result.move, score: 0 }]).filter(x => !E.isPass(x.move));
  if (!cands.length) return result.move;

  const best = Math.max(...cands.map(c => c.score));
  const pool = cands.filter(c => c.score >= best - (slack || 0));

  const freshPool = pool.filter(c => !history.has(keyAfter(st, c.move)));
  if (freshPool.length) {
    return freshPool[Math.floor(Math.random() * freshPool.length)].move;
  }
  // Everything in the preferred pool repeats — take the best move anywhere that
  // doesn't, rather than loop.
  const freshAny = cands.filter(c => !history.has(keyAfter(st, c.move)));
  if (freshAny.length) {
    const top = Math.max(...freshAny.map(c => c.score));
    const tied = freshAny.filter(c => c.score === top);
    return tied[Math.floor(Math.random() * tied.length)].move;
  }
  return pool[Math.floor(Math.random() * pool.length)].move;
}

export function resetHistory() { history = new Set(); }

// Pure decision function, exported so it can be tested outside a Worker.
export function decide({ board, stm, passes, level, id }) {
  const cfg = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, level | 0))];
  const st = stateFrom(board, stm, passes);
  history.add(boardKey(st.board, st.stm));

  // Pass policy. Without this a human can never end the game: they pass, the
  // bot moves, the counter resets, forever. The bot accepts the ending when it
  // is not behind — or when it IS behind but nothing it can play would improve
  // its score, which is the position a beaten bot is in.
  if (st.passes === 1) {
    const margin = exactMargin(st.board, stm);
    if (margin >= 0 || !canImprove(st)) {
      return {
        id, action: { kind: 'pass' }, depth: 0, nodes: 0, level: cfg.name,
        reason: margin >= 0 ? 'accepting the end' : 'nothing left to play for',
      };
    }
  }

  const t0 = Date.now();
  const result = E.search(st, { maxDepth: cfg.maxDepth, timeMs: cfg.timeMs });
  const move = pickMove(st, result, cfg.slack);
  if (!E.isPass(move) && move !== -1) history.add(keyAfter(st, move));

  return {
    id,
    action: describe(move),
    depth: result.depth,
    nodes: result.nodes,
    ms: Date.now() - t0,
    level: cfg.name,
  };
}

// Worker plumbing. Guarded so the module can also be imported in Node for tests.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (e) => {
    if (e.data && e.data.type === 'reset') { resetHistory(); return; }
    self.postMessage(decide(e.data));
  };
}
