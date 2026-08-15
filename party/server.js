const DIRS = [[0,1],[0,-1],[1,0],[-1,0]];
const SIZE = 12;

function freshBoard() {
  return Array.from({length: SIZE}, () => Array(SIZE).fill(null));
}

function getGroup(board, r, c) {
  const color = board[r][c];
  if (!color) return [];
  const visited = new Set();
  const queue = [[r, c]];
  visited.add(r * SIZE + c);
  while (queue.length) {
    const [cr, cc] = queue.shift();
    for (const [dr, dc] of DIRS) {
      const nr = cr + dr, nc = cc + dc;
      const id = nr * SIZE + nc;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && !visited.has(id) && board[nr][nc] === color) {
        visited.add(id);
        queue.push([nr, nc]);
      }
    }
  }
  return [...visited].map(id => [Math.floor(id / SIZE), id % SIZE]);
}

function connectedToHome(board, player) {
  const homeRow = player === 'red' ? 0 : SIZE - 1;
  const visited = new Set();
  const queue = [];
  for (let c = 0; c < SIZE; c++) {
    if (board[homeRow][c] === player) {
      visited.add(homeRow * SIZE + c);
      queue.push([homeRow, c]);
    }
  }
  while (queue.length) {
    const [cr, cc] = queue.shift();
    for (const [dr, dc] of DIRS) {
      const nr = cr + dr, nc = cc + dc;
      const id = nr * SIZE + nc;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && !visited.has(id) && board[nr][nc] === player) {
        visited.add(id);
        queue.push([nr, nc]);
      }
    }
  }
  return [...visited].map(id => [Math.floor(id / SIZE), id % SIZE]);
}

function getValidPlacements(board, player) {
  const homeRow = player === 'red' ? 0 : SIZE - 1;
  const minRow = player === 'red' ? 0 : SIZE - 4;
  const maxRow = player === 'red' ? 3 : SIZE - 1;
  const valid = new Set();
  for (let c = 0; c < SIZE; c++) {
    if (!board[homeRow][c]) valid.add(homeRow * SIZE + c);
  }
  for (const [r, c] of connectedToHome(board, player)) {
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr >= minRow && nr <= maxRow && nc >= 0 && nc < SIZE && !board[nr][nc]) {
        valid.add(nr * SIZE + nc);
      }
    }
  }
  return valid;
}

function canMove(board, group, dr, dc) {
  const n = group.length;
  const groupSet = new Set(group.map(([r,c]) => r * SIZE + c));
  for (const [r, c] of group) {
    for (let step = 1; step <= n; step++) {
      const nr = r + dr * step, nc = c + dc * step;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) return false;
      const id = nr * SIZE + nc;
      if (board[nr][nc] && !groupSet.has(id)) return false;
    }
  }
  return true;
}

function doMove(board, group, dr, dc) {
  const n = group.length;
  const color = board[group[0][0]][group[0][1]];
  for (const [r, c] of group) board[r][c] = null;
  for (const [r, c] of group) board[r + dr * n][c + dc * n] = color;
}

function countTerritory(board) {
  function flood(homeRow) {
    const reached = new Set();
    const queue = [];
    for (let c = 0; c < SIZE; c++) {
      if (!board[homeRow][c]) {
        reached.add(homeRow * SIZE + c);
        queue.push([homeRow, c]);
      }
    }
    while (queue.length) {
      const [cr, cc] = queue.shift();
      for (const [dr, dc] of DIRS) {
        const nr = cr + dr, nc = cc + dc;
        const id = nr * SIZE + nc;
        if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && !reached.has(id) && !board[nr][nc]) {
          reached.add(id);
          queue.push([nr, nc]);
        }
      }
    }
    return reached;
  }
  const redReach = flood(0);
  const blackReach = flood(SIZE - 1);
  const tMap = {};
  let rs = 0, bs = 0;
  for (const id of redReach) {
    if (blackReach.has(id)) tMap[id] = 'neutral';
    else { tMap[id] = 'red'; rs++; }
  }
  for (const id of blackReach) {
    if (!redReach.has(id)) { tMap[id] = 'black'; bs++; }
  }
  return { redScore: rs, blackScore: bs, map: tMap };
}

function notationFor(player) {
  return player === 'red' ? 'R' : 'B';
}

function dirName(dr, dc) {
  if (dr === -1) return 'U';
  if (dr === 1) return 'D';
  if (dc === -1) return 'L';
  return 'R';
}

export default class GameServer {
  constructor(room) {
    this.room = room;
    this.players = { red: null, black: null };     // playerId strings
    this.board = freshBoard();
    this.currentPlayer = 'red';
    this.phase = 'waiting';  // waiting, play, scoring, over
    this.consecutivePasses = 0;
    this.message = '';
    this.territoryMap = null;
    this.moveLog = [];
    // Identifies this game to clients so they can store its movelist locally.
    this.gameId = Math.random().toString(36).slice(2, 10);
  }

  roleOf(playerId) {
    if (this.players.red === playerId) return 'red';
    if (this.players.black === playerId) return 'black';
    return null;
  }

  broadcastState() {
    for (const conn of this.room.getConnections()) {
      const pid = conn.state?.playerId;
      const role = pid ? this.roleOf(pid) : 'spectator';
      conn.send(JSON.stringify({
        type: 'state',
        board: this.board,
        currentPlayer: this.currentPlayer,
        phase: this.phase,
        consecutivePasses: this.consecutivePasses,
        message: this.message,
        territoryMap: this.territoryMap,
        players: this.players,
        playerRole: role,
        moveLog: this.moveLog,
        gameId: this.gameId,
      }));
    }
  }

  onConnect(connection, ctx) {
    // Client will send a "join" message with their playerId
  }

  onClose(connection) {
    // Don't remove player — allow reconnect
  }

  onMessage(msg, sender) {
    let data;
    try { data = JSON.parse(msg); } catch { return; }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;

    if (data.type === 'join') {
      const pid = data.playerId;
      // Validate playerId: must be a short alphanumeric string
      if (typeof pid !== 'string' || pid.length === 0 || pid.length > 20 || !/^[a-zA-Z0-9]+$/.test(pid)) return;

      sender.setState({ playerId: pid });

      // Reconnecting player?
      const existingRole = this.roleOf(pid);
      if (existingRole) {
        this.broadcastState();
        return;
      }

      // Assign role
      if (!this.players.red) {
        this.players.red = pid;
      } else if (!this.players.black) {
        this.players.black = pid;
        if (this.phase === 'waiting') {
          this.phase = 'play';
        }
      }
      // else: room full, they're a spectator

      this.broadcastState();
      return;
    }

    // All other actions require a role and it to be their turn
    const pid = sender.state?.playerId;
    const role = pid ? this.roleOf(pid) : null;
    if (!role) return;

    // For resign, player doesn't need to be current player
    if (data.type === 'resign') {
      if (this.phase === 'over') return;
      const winner = role === 'red' ? 'Black' : 'Red';
      this.moveLog.push(`${notationFor(role)} RESIGN`);
      this.phase = 'over';
      this.message = `${role[0].toUpperCase() + role.slice(1)} resigns. ${winner} wins!`;
      this.broadcastState();
      return;
    }

    // Draw and count can be done by either player in scoring phase
    if (data.type === 'draw' && this.phase === 'scoring') {
      this.moveLog.push('DRAW');
      this.phase = 'over';
      this.message = 'Game ended in a draw.';
      this.broadcastState();
      return;
    }

    if (data.type === 'count' && this.phase === 'scoring') {
      this.moveLog.push('COUNT');
      const res = countTerritory(this.board);
      this.territoryMap = res.map;
      this.phase = 'over';
      if (res.redScore > res.blackScore) this.message = `Red wins! (Red ${res.redScore} \u2013 Black ${res.blackScore})`;
      else if (res.blackScore > res.redScore) this.message = `Black wins! (Red ${res.redScore} \u2013 Black ${res.blackScore})`;
      else this.message = `Tie! (Red ${res.redScore} \u2013 Black ${res.blackScore})`;
      this.broadcastState();
      return;
    }

    if (data.type === 'resume' && this.phase === 'scoring') {
      this.moveLog.push('RESUME');
      this.phase = 'play';
      this.consecutivePasses = 0;
      this.broadcastState();
      return;
    }

    // Remaining actions require it to be this player's turn
    if (role !== this.currentPlayer || this.phase !== 'play') return;

    if (data.type === 'place') {
      const { r, c } = data;
      if (!Number.isInteger(r) || !Number.isInteger(c)) return;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return;
      if (this.board[r][c]) return;
      if (!getValidPlacements(this.board, this.currentPlayer).has(r * SIZE + c)) return;
      this.moveLog.push(`${notationFor(this.currentPlayer)} P ${r},${c}`);
      this.board[r][c] = this.currentPlayer;
      this.consecutivePasses = 0;
      this.endTurn();
      return;
    }

    if (data.type === 'move') {
      const { r, c, dr, dc } = data;
      if (!Number.isInteger(r) || !Number.isInteger(c) || !Number.isInteger(dr) || !Number.isInteger(dc)) return;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return;
      if (this.board[r][c] !== this.currentPlayer) return;
      // Validate direction is cardinal unit vector
      if (!DIRS.some(([a,b]) => a === dr && b === dc)) return;
      const group = getGroup(this.board, r, c);
      if (!group.length) return;
      if (!canMove(this.board, group, dr, dc)) return;
      this.moveLog.push(`${notationFor(this.currentPlayer)} M ${r},${c},${dirName(dr, dc)}`);
      doMove(this.board, group, dr, dc);
      this.consecutivePasses = 0;
      this.endTurn();
      return;
    }

    if (data.type === 'pass') {
      this.moveLog.push(`${notationFor(this.currentPlayer)} X`);
      this.consecutivePasses++;
      if (this.consecutivePasses >= 2) {
        this.phase = 'scoring';
        this.broadcastState();
        return;
      }
      this.endTurn();
      return;
    }
  }

  endTurn() {
    this.currentPlayer = this.currentPlayer === 'red' ? 'black' : 'red';
    this.broadcastState();
  }
}
