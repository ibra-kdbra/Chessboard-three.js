# The original site

These are the pages this repository shipped before the rewrite, moved here
unchanged apart from asset paths. They are kept for reference — the 3D piece
models, the camera framing and the position-diff animation planner all came from
`js/chessboard3.js`, and it is useful to be able to look at the original.

**They do not work properly, and they did not before the move.** An audit of the
original code found, among other things:

- `play.html` binds a HINT button with an empty `id`, so 27 lines of hint logic
  never ran; the FEN and PGN panes it writes to do not exist; the eval gauge is
  commented out, and the call that writes to it throws on every status update;
  and `onSnapEnd` never re-syncs the board, so castling, en passant and
  promotion render wrongly.
- `bare.html` loads three.js from a plain-HTTP CDN, which every modern browser
  blocks as mixed content from an HTTPS page. The page is entirely non-functional.
- Every page leaks a WebGL context and a perpetual animation loop each time the
  board is rebuilt, which the 2D/3D toggle does on every click.

The playable game is now at the repository root. Do not build on these files.
