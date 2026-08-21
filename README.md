# chessboard3

A chess game in the browser, rendered in 3D with three.js. Play the computer at
ten graded strengths, or two of you on one device — with clocks, an evaluation
bar, an opening book, a move tree that keeps your variations, and six board
themes.

No build step. The source ships as native ES modules and runs from any static
server.

```bash
npm install
npm run dev        # http://127.0.0.1:8080
```

## What is here

| Path           |                                                                              |
| -------------- | ---------------------------------------------------------------------------- |
| `index.html`   | The game.                                                                    |
| `sandbox.html` | Renderer playground — themes, piece sets, camera modes.                      |
| `src/core/`    | Rules, move tree, PGN, clock, evaluation, opening book. No DOM, no three.js. |
| `src/engine/`  | UCI adapter over the engine workers, and the opponent.                       |
| `src/render/`  | The 3D board, and the contract a 2D one would implement.                     |
| `src/ui/`      | Design tokens and the panel components.                                      |
| `src/app/`     | Session, keyboard, persistence, wiring.                                      |
| `engines/`     | Lozza, Stockfish 5 and p4wn, as Web Workers.                                 |
| `tools/`       | Vendoring, asset conversion, model verification, dev helpers.                |
| `legacy/`      | The original site, preserved. See `legacy/README.md`.                        |

## Playing

Drag a piece, or click it and click where it goes. The whole game also works
from the keyboard: **Tab** to the board then arrow keys and **Enter**, or just
type the move — `Nf3`, `exd5`, `O-O` — and press **Enter**.

|              |                                       |
| ------------ | ------------------------------------- |
| `←` `→`      | Step through the game                 |
| `Home` `End` | Jump to the start, or the latest move |
| `F`          | Flip the board                        |
| `H`          | Hint                                  |
| `T`          | Take back                             |
| `?`          | Show every shortcut                   |

Right-drag across the board to draw an arrow.

## Engines

Three ship with the game, all as Web Workers.

|                 | Strength | Notes                                         |
| --------------- | -------- | --------------------------------------------- |
| **Lozza**       | ≈2300    | Fast to start, sharp. The default.            |
| **Stockfish 5** | ≈3000    | A 1.1MB asm.js build. The strongest option.   |
| **p4wn**        | ≈1100    | Tiny. A good opponent while you are learning. |

None of them can be interrupted — each runs its search on the worker's own event
loop, so a `stop` message is only read after the search it was meant to stop has
already finished. Cancelling therefore discards the worker and starts another.
Each also deviates from UCI in its own way; `src/engine/engineProfiles.js`
records what each one actually does and the adapter normalises it.

### Difficulty

Ten rungs. Only Stockfish offers native weakening (`Skill Level`), and no
bundled engine has `UCI_Elo` — that arrived in Stockfish 11. So a rung pairs a
search budget with softmax sampling over the candidate moves at a temperature in
centipawns, plus a separate chance of a real blunder at the lower rungs. Cutting
the search alone does not work: a shallow search still never hangs a queen, so
"easy" plays inhumanly solid chess and then suddenly wins.

## Development

```bash
npm run dev          # static server on :8080
npm test             # unit tests (vitest) — the DOM-free core
npm run test:e2e     # browser tests (playwright) — renderer, engines, the app
npm run lint
npm run check        # lint + format + unit tests
```

The renderer and the engines are only tested in a real browser. A jsdom
approximation of WebGL, or of a classic-script Worker, would test the
approximation — and Lozza literally changes its move notation depending on
whether it thinks it is running under node or in a page.

### Assets

The 3D piece models were authored for a three.js JSON format whose loader was
removed from the library years ago.

```bash
npm run assets       # legacy JSON Geometry v3 -> indexed BufferGeometry
node tools/verify-models.mjs
```

`verify-models` runs the retired r80 loader inside a `vm` sandbox and compares
triangle count, extents and total surface area against the converted output. All
18 models match to within floating-point noise. Nothing else in the pipeline is
allowed to be taken on trust.

### Vendoring

```bash
npm run vendor       # three + chess.js -> vendor/, with an import map
npm run vendor -- --dev   # readable three build, for debugging
```

Only the transitive closure of the addons actually imported is copied — 13 files
rather than the 8.8MB `examples/jsm` tree.

## Licence

MIT, except for the bundled engines. Stockfish is **GPL-3.0**; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) before redistributing.

## Credits

Built on [three.js](https://threejs.org/) and
[chess.js](https://github.com/jhlywa/chess.js). The board widget, the piece
models and the position-diff animation planner descend from
[chessboard3.js](https://github.com/blunderdome/chessboard3js) by Chris Oakman
and Justin Rosenthal. Opening book from
[eco-chess](https://github.com/arcanous/eco-chess).
