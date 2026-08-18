# Beaver Dam

A two-player abstract strategy game played on a 12×12 board. Players build and move groups of
cubes to seal off territory — the player who dams off the most open water on their side wins.

Runs in the browser, with local hot-seat play, online multiplayer over
[PartyKit](https://partykit.io), and a replay viewer.

---

## Rules

### Setup

- The board is **12×12** and starts empty.
- **Red** owns the top row (row 0) as its *home row*; **Black** owns the bottom row (row 11).
- Red moves first.

Coordinates are `row,col`, both 0-indexed from the top-left.

### The turn

On your turn you do exactly one of three things:

1. **Place** a new cube,
2. **Move** a group of your cubes, or
3. **Pass**.

There is no capturing — cubes are never removed from the board once placed.

### Placing

You may place a cube on:

- **any empty square in your own home row**, or
- **any empty square orthogonally adjacent to one of your cubes that is connected to your home
  row**, where "connected" means linked by an orthogonally-adjacent chain of your own cubes back
  to your home row.

Placement is additionally limited to your **build zone**: the four rows nearest your home.

| Player | Home row | Build zone |
| ------ | -------- | ---------- |
| Red    | row 0    | rows 0–3   |
| Black  | row 11   | rows 8–11  |

The board draws small grey dots on the left and right edges marking where each build zone ends.
Squares you may legally place on are shaded **green**.

Two consequences worth knowing:

- **You can only build outward from home.** A group that has been moved loose from your home row
  can no longer be extended by placement — only moved.
- **You cannot place past row 3 (or row 8).** The only way to get cubes into the middle of the
  board is to *move* them there.

### Moving

Click one of your cubes to select the **group** it belongs to: all your cubes reachable from it
through orthogonal adjacency. The selected group is outlined in yellow.

The group then slides as a rigid block in one of the four cardinal directions, and it always
travels **exactly N squares, where N is the number of cubes in the group**. A three-cube group
moves three squares; a seven-cube group moves seven.

The move is legal only if **every square each cube passes through, and lands on, is empty** (or is
vacated by the group itself) and stays on the board. Nothing is pushed, jumped, or captured — the
path must be clear the whole way. Legal landing squares are shaded **blue**; click one to commit,
or press **Cancel** to reselect.

Movement is *not* restricted to the build zone. Big groups hit harder but are far easier to block:
growing a group makes it travel further than you may want.

### Passing and ending the game

Passing is allowed at any time. **Two consecutive passes** end the play phase and move the game to
scoring, where either player may choose:

- **Count Territory** — score the position and end the game;
- **Declare Draw** — end the game as a draw;
- **Resume Play** — go back to playing (the pass counter resets);
- **Resign** — concede.

Either player may resign at any point, including on the opponent's turn.

### Scoring

Territory is measured by flood-filling the **empty** squares:

1. From every empty square in Red's home row, flood outward through empty squares. Everything
   reached is *Red-reachable*.
2. Do the same from Black's home row for *Black-reachable*.
3. An empty square reachable by **only one** player scores one point for that player. Squares
   reachable by both are **neutral** and score nothing. Squares reachable by neither (fully sealed
   pockets) also score nothing.

Cubes themselves are worth no points — only the water they enclose. **Highest score wins**; equal
scores are a tie. At the end of a counted game the board shades Red territory pink and Black
territory grey.

The strategic core follows from this: you score by completing a dam that cuts open squares off
from your opponent's side while leaving them connected to yours. A leak anywhere along your wall
makes the whole region neutral and worthless.

One consequence is easy to miss and worth knowing: because the flood spreads only up, down, left
and right, **a diagonal chain of cubes seals just as well as a solid row**. A staircase of twelve
cubes zig-zagging between two rows cuts the board in half exactly as a straight line of twelve
does. Cubes of *either* colour block the flood, too — so your opponent's wall can form part of the
barrier that encloses your territory.

Note the edge case: if your home row is *completely full* of cubes, your flood has nowhere to
start and you score zero. Leave yourself a gap.

---

## Running the game

Requires Node.js (18+ recommended).

```bash
npm install
```

```bash
npm run dev
```

This starts `partykit dev`, which serves the client from `public/` and runs the game server from
`party/server.js`. Open the printed URL — by default <http://127.0.0.1:1999>.

Local dev state is written to `.partykit/`; it is safe to delete and should not be committed.

## Playing

The lobby offers six options:

- **Local Multiplayer** — hot-seat on one screen, both sides played in the same browser tab. No
  server round-trip; the whole game runs client-side.
- **Local vs AI** — play the computer. You are Red and move first.
- **Host Game** — generates a six-character room code and a shareable invite link, then waits for
  an opponent. The host is assigned Red.
- **Join Game** — enter a room code (or open an invite link, which pre-fills it). The joiner is
  assigned Black. Anyone joining a full room watches as a spectator.
- **Replay Game** — paste a movelist to step through a finished game.
- **Saved Games** — every game played on this device, newest first, ready to replay.

Each browser session gets a random player ID stored in `sessionStorage`. Reconnecting with the
same ID reclaims your seat, so a refresh or a dropped connection does not forfeit the game — the
client reconnects automatically.

The server is authoritative for online games: it validates every placement and move, so an
edited client cannot make an illegal one.

### Movelists and replays

Every game — local *and* online — records a movelist, viewable and copyable with the **Movelist**
button during play. Paste one into **Replay Game** to step through it with `|<`, `<`, `>`, `>|`
and an auto-play button. The format is one move per line:

| Notation      | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| `R P 0,4`     | Red places a cube at row 0, column 4                           |
| `B M 9,3,U`   | Black moves the group containing (9,3) up; `U`/`D`/`L`/`R`     |
| `R X`         | Red passes                                                     |
| `B RESIGN`    | Black resigns                                                  |
| `COUNT`       | Territory is counted and the game ends                         |
| `DRAW`        | The game ends in a draw                                        |
| `RESUME`      | Play resumes from scoring after two passes                     |

For online games the movelist is kept by the server and sent with every state update, so it stays
complete across a reconnect and includes moves the opponent made while you were away.

### Playing the AI

**Local vs AI** puts you against a search engine running in a Web Worker, so the board stays
responsive while it thinks. It's entirely client-side — online games are unaffected.

**Difficulty can be changed at any point during a game**, from the dropdown next to the board. The
level is sent with every request rather than fixed when the game starts, so a change takes effect
on the AI's very next move. No restart, no lost position.

| Level | Search depth | Budget | Move choice |
| ----- | ------------ | ------ | ----------- |
| Beginner | 1 | 0.2s | any move within 10 points of best |
| Easy | 2 | 0.4s | within 5 points |
| Normal | 3 | 0.8s | within 2 points |
| Strong | 4 | 1.5s | best only |
| Max | up to 8 | 2.5s | best only |

Weaker levels don't play random blunders — they pick among moves close to the best, so the AI stays
coherent and just misses the sharpest line. Under the board it reports the depth it reached, the
nodes it searched and how long it took.

Two things worth knowing about how it plays:

- **Depth changes its character a lot.** At Normal it will often walk a single cube back and forth
  rather than commit; at Max it builds properly, mirroring your wall and contesting the middle. If
  the AI looks aimless, turn the difficulty up.
- **It will accept an ending.** If you pass, the AI passes back whenever it is either not behind on
  the exact count, or behind with no move left that could improve its score. Without that you could
  never finish a game against it — you'd pass, it would move, and the pass counter would reset
  forever. It only plays on if it is behind *and* still has something to play for.
- **It won't shuffle.** The AI refuses moves that recreate a position it has already been in, so a
  dead position produces varied play or a pass rather than the same two moves forever.

The AI's moves go through exactly the same code path as your clicks, so they're recorded in the
movelist, highlighted as the last move, and saved for replay like any other game.

### Dam projection

The **Show Dam** button overlays the board with the cheapest dam the current position allows, and
the territory that dam would produce. It's available during play, in the scoring and finished
states, and in replays.

It works by finding the cheapest line of cubes crossing the board from the left edge to the right
edge. Steps go to any of the eight neighbouring squares, since a diagonal chain seals just as well
as a straight one. Crossing an existing cube is free — of *either* colour, because any cube blocks
the flood — while an empty square costs a **ghost block**, drawn as a dashed purple square.

Ghosts are not all priced the same, because the cheapest crossing is not always the *likeliest* dam:

- **A ghost placed diagonally costs 1.5×.** A diagonal bridge is a thinner, more tenuous thing to
  commit to. Crossing an *existing* diagonal cube is still free — a real diagonal chain seals
  perfectly well; it's only bridging diagonally that's speculative.
- **Each further ghost in the same unbroken gap costs more than the last**, so three separate
  1-wide holes are preferred to one 3-wide hole. A small gap is far likelier to get plugged than
  a big one.
- **Ghosts and distance are commensurable** — one ghost is worth about seven steps of line. This is
  what stops the projection wandering halfway across the board to pick up a stray cube and save a
  single ghost. Previously the line would happily run a long diagonal from a lone home-row block up
  to a bar in the middle, which is not a dam anyone would actually build.

Because of that last rule the drawn line is the most **plausible** dam rather than strictly the
cheapest one, so its ghost count can occasionally be one higher than the bare theoretical minimum.
That's deliberate: a line you might really build is more useful than one you wouldn't.

The board is then scored as if those ghosts were real, which shades the projected territory either
side of the line. Ghost blocks are occupied squares, so — like real cubes — they score for neither
player.

Reading it:

| Overlay | Meaning |
| ------- | ------- |
| Purple dot on a cube | that cube is part of the cheapest dam |
| Dashed purple square | a ghost block: a gap the dam still needs filling |
| Pink / grey tints | territory each side would hold once the dam closes |

Where ties exist the line prefers, in order, the fewest ghost blocks, then the shortest line, then
the most central one — so an empty board shows a sensible midline rather than hugging a home row.

The projection is deliberately optimistic: it assumes the dam closes. A position two blocks short
of sealing can project Red 30 / Black 95 while the actual count is 0–0, because until the last gap
closes every square is reachable by both players. The difference between the two numbers is what
the dam is worth. It also tends to show that walls built too close to your own home row hand the
opponent the larger half — a sealed line on row 8 splits the board 96–36 in Red's favour.

### Saved games

Games are saved to the browser's `localStorage` under the key `beaver-saved-games`, so you can
look at them again later on the same device. Each entry holds the movelist, the date, whether the
game was local or online (with the room code), and the result.

Saving happens move by move rather than at the end, so a game you abandoned or one that was
interrupted is kept too — it just shows as *Unfinished*. The **Saved Games** screen lists them
newest first with a **Replay** button per game, a **×** to delete one, and **Clear All**.

Two things worth knowing:

- Storage is **per device and per browser**. Both players in an online game save their own copy;
  the server does not keep games after a room shuts down.
- The list is capped at the 50 most recent games; older ones drop off the end.

## Deploying

Deployment targets PartyKit's hosted platform. Log in once:

```bash
npx partykit login
```

Then deploy:

```bash
npm run deploy
```

The project name and entry point come from [partykit.json](partykit.json) — it deploys
`party/server.js` as the room server and serves `public/` as static assets. The deployed game
lands at `https://beaver-dam-game.<your-partykit-username>.partykit.dev`.

## Project layout

| Path                                     | Purpose                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| [party/server.js](party/server.js)       | Authoritative game server: rules, validation, turn state, movelist, broadcasting |
| [public/index.html](public/index.html)   | The entire client — lobby, board rendering, local rules engine, replay, saved games |
| [public/engine.js](public/engine.js)     | AI search: alpha-beta with transposition table, PVS, killers, dam-projection eval |
| [public/ai-worker.js](public/ai-worker.js) | Web Worker wrapper — difficulty levels, pass policy, repetition avoidance |
| [test/](test)                            | `npm test` — engine vs canonical rules, and AI endgame behaviour        |
| [partykit.json](partykit.json)           | PartyKit project config                                                 |

The rules exist in **three** places: `party/server.js` for online play, `public/index.html` for
local play and replay, and `public/engine.js` for the AI. The third is deliberate — the search
needs a flat typed-array board and make/unmake, which the readable rules code doesn't provide — but
it means a rule change must land in all three. The engine is pinned to the canonical rules by a
differential test that compares move generation, territory, dam projection, evaluation and
make/unmake across thousands of positions; keep that passing when you touch the rules.
