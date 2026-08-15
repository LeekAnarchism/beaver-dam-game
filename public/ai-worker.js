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

function stateFrom(boardArray, stm, passes) {
  const st = E.newState();
  for (let i = 0; i < E.N; i++) st.board[i] = boardArray[i];
  st.stm = stm; st.passes = passes; st.ply = 0;
  E.rehash(st);
  return st;
}

// Turn an engine move into the same shape a human click produces, so the main
// thread can apply it through its existing code path.
function describe(m) {
  if (m === -1) return { kind: 'pass' };
  if (E.isPass(m)) return { kind: 'pass' };
  const cell = E.moveCell(m);
  const r = (cell / E.SIZE) | 0, c = cell % E.SIZE;
  if (!E.isSlide(m)) return { kind: 'place', r, c };
  const d = E.DIRS[E.moveDir(m)];
  return { kind: 'move', r, c, dr: d.dr, dc: d.dc };
}

// Weaker levels pick among moves within `slack` of the best rather than playing
// a random blunder — the bot stays coherent, it just misses the sharpest line.
function chooseMove(result, slack) {
  if (!slack || !result.rootMoves || result.rootMoves.length === 0) return result.move;
  const playable = result.rootMoves.filter(x => !E.isPass(x.move));
  if (!playable.length) return result.move;
  const best = Math.max(...playable.map(x => x.score));
  const pool = playable.filter(x => x.score >= best - slack);
  return pool[Math.floor(Math.random() * pool.length)].move;
}

self.onmessage = (e) => {
  const { board, stm, passes, level, id } = e.data;
  const cfg = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, level | 0))];
  const st = stateFrom(board, stm, passes);

  // Pass policy. Without this a human can never end the game: they pass, the
  // bot moves, the counter resets, forever. So when the opponent has just passed
  // and the bot is not behind on the exact count, it accepts the ending. If it
  // IS behind, it plays on rather than banking a loss.
  if (st.passes === 1) {
    const t = E.countTerritory(st.board);
    const margin = stm === E.RED ? t.red - t.black : t.black - t.red;
    if (margin >= 0) {
      self.postMessage({ id, action: { kind: 'pass' }, depth: 0, nodes: 0, level: cfg.name, reason: 'accepting the end' });
      return;
    }
  }

  const t0 = Date.now();
  const result = E.search(st, { maxDepth: cfg.maxDepth, timeMs: cfg.timeMs });
  const move = chooseMove(result, cfg.slack);

  self.postMessage({
    id,
    action: describe(move),
    depth: result.depth,
    nodes: result.nodes,
    ms: Date.now() - t0,
    level: cfg.name,
  });
};
