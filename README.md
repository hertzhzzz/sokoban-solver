# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/hertzhzzz/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/hertzhzzz/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver in TypeScript (Node 22, no dependencies). It reads every level of a set from `/input/<id>/level.txt` and writes the player's moves to `/output/<id>/solution.txt`.

## How it works

A level from this competition is a hallway with one to four small rooms off it. A box pushed out of a room through its door can never come back, so every box stays in its own room and the level's push-optimal count is the sum of the rooms' optima. The solver:

1. Splits the level into rooms by cutting the dead squares of the player's row (the hallway: a box there reaches no goal).
2. Solves each room with a breadth-first search over pushes. A state is the boxes' squares plus the player's reachable region (named by its lowest square). States leave the queue in order of pushes made, so the first solved state is push-optimal.
3. Prunes two dead ends that can never lead to a solution: dead squares (found by pulling back from the goals) and frozen 2x2 blocks of walls and boxes.
4. Solves the rooms one after another, the other rooms' boxes standing as walls, and the player walking on from where the last room left it.

The search budget is counted in states, never in wall-clock time, and every tie is broken in a fixed order, so two runs answer byte for byte alike.

## Results

Practice set: **1,000,000 / 1,000,000** — all 5 levels solved in exactly the push-optimal count (13, 16, 29, 47, 60 pushes), in about 1.3 seconds. The house baseline (plain A*) scores 200,000 on the same set (it solves only the first level). Three freshly drawn sets from the kit's generator also score 1,000,000 each.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<input-dir> MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=trpdktbz&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
