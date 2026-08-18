// Regression tests for two bugs found in a real game against the Max-level AI:
//
//   1. The human was 44 points ahead with the dam sealed, passed ten times, and
//      the AI refused to pass because it was behind — so the game could not end
//      and the human had to resign a won game.
//   2. In that dead position the AI shuffled one cube between two squares
//      forever, repeating the same position ten times.
//
//   npm test
import * as E from '../public/engine.js';
import { decide, resetHistory } from '../public/ai-worker.js';

const S = E.SIZE;
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// A dead, sealed position: a solid Red wall across row 8, so Red holds rows 0-7
// and Black is shut into rows 9-11 and losing badly. Nothing Black plays can
// change the count.
function deadPosition() {
  const b = new Array(E.N).fill(0);
  for (let c = 0; c < S; c++) b[8 * S + c] = E.RED;
  b[10 * S + 3] = E.BLACK;
  b[10 * S + 7] = E.BLACK;
  return b;
}

const board = deadPosition();
const t = E.countTerritory(Int8Array.from(board));
console.log(`\nai endgame behaviour — sealed position, red ${t.red} black ${t.black}\n`);
check('position really is sealed and lost for Black', t.red > t.black, `${t.red} vs ${t.black}`);

// 1. The human passes. The AI must accept the ending even though it is behind.
resetHistory();
const r = decide({ board, stm: E.BLACK, passes: 1, level: 4, id: 1 });
check('AI passes back so the game can end', r.action.kind === 'pass',
  `got ${r.action.kind}${r.reason ? ` (${r.reason})` : ''}`);

// 2. Playing on in a dead position must not degenerate into a two-move loop.
resetHistory();
const seen = [];
let cur = board.slice();
for (let i = 0; i < 8; i++) {
  const d = decide({ board: cur, stm: E.BLACK, passes: 0, level: 3, id: 10 + i });
  const a = d.action;
  seen.push(JSON.stringify(a));
  if (a.kind === 'pass') break;
  const st = E.newState();
  for (let k = 0; k < E.N; k++) st.board[k] = cur[k];
  st.stm = E.BLACK; E.rehash(st);
  if (a.kind === 'place') E.makeMove(st, E.mkPlace(a.r * S + a.c));
  else {
    const di = [[0,1],[0,-1],[1,0],[-1,0]].findIndex(([dr, dc]) => dr === a.dr && dc === a.dc);
    E.makeMove(st, E.mkSlide(a.r * S + a.c, di));
  }
  cur = Array.from(st.board);
}
const distinct = new Set(seen).size;
check('no two-move shuffle loop', distinct > 2, `${distinct} distinct moves in ${seen.length}`);

// 3. Ahead and the opponent passes: bank the win. Territory depends on the home
// rows, which do not move, so making Black the winner means putting the wall
// high up the board rather than recolouring the pieces.
resetHistory();
const winning = new Array(E.N).fill(0);
for (let c = 0; c < S; c++) winning[3 * S + c] = E.BLACK;
winning[5 * S + 4] = E.BLACK;
const wt = E.countTerritory(Int8Array.from(winning));
check('control position really is winning for Black', wt.black > wt.red, `${wt.black} vs ${wt.red}`);
const r3 = decide({ board: winning, stm: E.BLACK, passes: 1, level: 3, id: 99 });
check('AI banks the win when ahead', r3.action.kind === 'pass' && r3.reason === 'accepting the end',
  `got ${r3.action.kind}${r3.reason ? ` (${r3.reason})` : ''}`);

console.log(failures === 0 ? '\nPASS — AI ends games properly' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
