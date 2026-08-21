# Third-party notices

This repository distributes several third-party components. They keep their own
licences, which are **not** the project's MIT licence.

## Chess engines

| Component | Version | Licence | Source |
| --- | --- | --- | --- |
| Stockfish | 5 (asm.js build, 2014) | **GPL-3.0-only** | <https://stockfishchess.org/> |
| Lozza | build 116 | MIT | <http://op12no2.me/toys/lozza> |
| p4wn | bundled | Public domain | <http://p4wn.sf.net/> |

### Stockfish and the GPL

`js/stockfish.js` is a compiled build of Stockfish 5, released under the GNU
General Public License version 3. The full licence text is at
[`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt).

What that means for anyone redistributing this repository:

- The Stockfish build must keep its GPL-3.0 licence and this notice.
- Recipients are entitled to the **corresponding source** for that build. This
  repository ships only the compiled artefact; the source it was built from is
  the Stockfish 5 release, available from the Stockfish project and its
  [GitHub repository](https://github.com/official-stockfish/Stockfish).
- Stockfish runs in its own Web Worker and communicates only over UCI text
  messages, so the rest of this project is not a derivative work of it. It is
  still *distributed* with it, which is why this notice exists.

If you would rather not distribute GPL code, delete `js/stockfish.js` and remove
the `stockfish` entry from `src/engine/engineProfiles.js`. The game runs on
Lozza and p4wn alone.

## Libraries

| Component | Version | Licence |
| --- | --- | --- |
| three.js | 0.185.1 | MIT |
| chess.js | 1.4.0 | BSD-2-Clause |
| chessboard.js / chessboard3.js (legacy) | vendored | MIT |
| jQuery (legacy pages only) | 2.1.3 | MIT |
| Raphaël, SweetAlert, prettify (legacy pages only) | vendored | MIT |

## Data

| Component | Licence | Source |
| --- | --- | --- |
| ECO opening book (`src/data/openings.js`) | MIT | [eco-chess](https://github.com/arcanous/eco-chess) by Harijs Deksnis |

## Art assets

The 3D piece models in `assets/chesspieces/` and their Blender sources in
`blend/` are part of this repository and covered by its MIT licence.
