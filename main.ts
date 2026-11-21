// Sokoban solver: push-optimal, room by room.
//
// Idea: a level from this competition is a hallway with one to four small
// rooms off it. A box pushed out of a room through its door can never come
// back, so every box stays in its own room and the level's push-optimal
// count is the sum of the rooms' optima. Each room holds 3 or 4 boxes, so a
// breadth-first search over pushes solves a room exactly, and the rooms are
// solved one after another with the other rooms' boxes standing as walls.
//
// A search state is the boxes' squares plus the player's reachable region
// (named by its lowest square). States are expanded in order of pushes
// made, so the first solved state met is push-optimal. Two prunings keep
// the search small, and neither prunes a solvable state:
//   - a dead square: a square from which no push, ignoring the other
//     boxes, can ever bring a box onto a goal (found by pulling back
//     from the goals). A box on a dead square is lost.
//   - a frozen 2x2 block: four squares of walls and boxes holding a box
//     off its goal. Nothing in the block can ever move again.
//
// The search budget is counted in states, never in wall-clock time, and
// every tie is broken in a fixed order, so two runs answer byte for byte
// alike. No clock, no randomness, no network, no files outside /input
// and /output.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input
//   MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Four steps: up, down, left, right. The lower letter is a step, the upper
// letter the same step pushing a box.
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// How many states one push search may keep before it gives up.
const ROOM_STATE_CAP = 400_000;
const WHOLE_STATE_CAP = 800_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text: # wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Live squares: every square from which a box alone can be pushed onto
 * some goal. Found by pulling backwards from the goals: a square y is live
 * when a box on y can be pushed to a live square x, which needs the player
 * to stand on the far side (y - d) and that square to be open floor.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood fill from `from` over open floor with `occupied` squares blocked.
 * Returns the lowest square reached (the region's name) and fills `seen`
 * with the region's squares.
 */
function flood(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Uint8Array,
): number {
  const { w, wall } = level;
  const stack = [from];
  seen[from] = 1;
  let low = from;
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (p < low) low = p;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || seen[q]) continue;
      seen[q] = 1;
      stack.push(q);
    }
  }
  return low;
}

/** True when the box just pushed to `t` sits in a frozen 2x2 block. */
function isFrozen(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    const filled = (s: number): boolean => s >= 0 && s < wall.length && Boolean(wall[s] || occupied[s]);
    if (!filled(a) || !filled(b) || !filled(c) || !filled(d)) continue;
    const stuckOffGoal = (s: number): boolean => Boolean(occupied[s] && !goal[s]);
    if (stuckOffGoal(a) || stuckOffGoal(b) || stuckOffGoal(c) || stuckOffGoal(d)) return true;
  }
  return false;
}

/**
 * Push-optimal solution of one level (a room, or a whole level) as
 * { pushes, moves }, or null when the search gives up or there is none.
 * Breadth-first over pushes: states leave the queue in order of pushes
 * made, so the first solved state is optimal.
 */
function solvePushes(level: Level, cap: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = level.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;

  const occupied = new Uint8Array(size);
  const seen = new Uint8Array(size);
  const region = new Uint8Array(size);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  // State storage: boxes in one flat array, plus parent index and the push
  // (from -> to) that made each state. The player's square after a push is
  // the pushed box's old square, so it needs no storage of its own.
  const boxRows = new Int32Array(cap * Math.max(n, 1));
  const parent = new Int32Array(cap).fill(-1);
  const pushFrom = new Int32Array(cap).fill(-1);
  const pushTo = new Int32Array(cap).fill(-1);
  let count = 0;

  // A state's key: its region's lowest square, then its boxes, packed as
  // digits in base `size`. Exact while size ** (n + 1) stays under 2 ** 53,
  // which holds for rooms of up to 5 boxes on these boards.
  const useNumberKey = n <= 5;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!useNumberKey) return `${low}:${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const store = (boxes: number[]): number => {
    const idx = count++;
    boxRows.set(boxes, idx * n);
    return idx;
  };
  const boxesOf = (idx: number): number[] => Array.from(boxRows.subarray(idx * n, idx * n + n));

  for (const b of level.boxes) occupied[b] = 1;
  seen.fill(0);
  const startLow = flood(level, occupied, level.player, seen);
  for (const b of level.boxes) occupied[b] = 0;
  const start = store(level.boxes);
  const visited = new Map<number | string, number>();
  visited.set(keyOf(level.boxes, startLow), start);
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  let found = -1;
  for (let head = 0; found < 0 && head < count; head++) {
    const boxes = boxesOf(head);
    for (const b of boxes) occupied[b] = 1;
    // The player's square after the push that made this state is the box
    // square the push vacated; for the start state it is level.player.
    const playerSq = head === 0 ? level.player : pushFrom[head]!;
    region.fill(0);
    flood(level, occupied, playerSq, region);
    for (let bi = 0; bi < n && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        const behind = b - d;
        if (behind < 0 || behind >= size || t < 0 || t >= size) continue;
        // The player must be able to stand behind the box, and the square
        // beyond it must be open floor, live, and empty.
        if (!region[behind] || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (isFrozen(level, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        seen.fill(0);
        const low = flood(level, occupied, b, seen);
        const key = keyOf(next, low);
        occupied[t] = 0;
        occupied[b] = 1;
        if (visited.has(key)) continue;
        if (count >= cap) return null;
        const idx = store(next);
        parent[idx] = head;
        pushFrom[idx] = b;
        pushTo[idx] = t;
        visited.set(key, idx);
        if (solved(next)) {
          found = idx;
          break;
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Rebuild the push path, then turn it into moves: walk to each push's
  // square (boxes standing), then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = boxesOf(s);
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** Shortest walk from `from` to `to` around walls and boxes, lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part
 * left that holds a box is a room. Null when the level is no set of rooms:
 * a box starts in the hallway, a goal is cut away, or some part holds a
 * different count of boxes and goals.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  }
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Where the player stands after playing `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * Solve a level room by room. Each room is solved with the other rooms'
 * boxes as walls (a finished room's boxes sit on its goals), and the
 * player walks on from where the last room left it. Falls back to a
 * search over the whole level when the level is no set of rooms, or when
 * a room's search gives up.
 */
function solveLevel(level: Level): string {
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solvePushes(sub, ROOM_STATE_CAP);
      if (solved === null) {
        ok = false;
        break;
      }
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      room.done = true;
    }
    if (ok) return moves;
  }
  const whole = solvePushes(level, WHOLE_STATE_CAP);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
