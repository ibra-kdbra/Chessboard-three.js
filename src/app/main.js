/**
 * Wiring.
 *
 * Builds the shell, connects the session to the renderer and the panels, and
 * owns the small amount of state that is genuinely about the interface rather
 * than the game — what is selected, what the settings say, which panel is open.
 *
 * The rule this file exists to keep: the session never touches the DOM and the
 * renderer never asks about rules. Everything that has to know about both lives
 * here.
 */
import { Session } from './session.js';
import { KeyboardControl } from './keyboard.js';
import * as store from './persistence.js';
import { Board3D } from '../render/three/board3d.js';
import { Board2D } from '../render/two/board2d.js';
import { webGLEnabled } from '../render/three/scene.js';
import { ACCESSIBLE_HIGHLIGHTS, getTheme } from '../render/three/themes.js';
import { SoundEngine } from '../audio/soundEngine.js';
import { ENGINE_PROFILES } from '../engine/engineProfiles.js';
import { Analyser } from '../engine/analyser.js';
import { el, announce, replaceChildren } from '../ui/dom.js';
import { EvalBar } from '../ui/evalBar.js';
import { ClockFace } from '../ui/clockFace.js';
import { MoveList } from '../ui/moveList.js';
import { EnginePanel } from '../ui/enginePanel.js';
import { Toaster } from '../ui/toast.js';
import { askPromotion, showDialog } from '../ui/dialog.js';
import { buildEvalGraph } from '../ui/evalGraph.js';
import { createDialogs } from './dialogs.js';
import { PIECE_NAMES, describeMove } from '../ui/pieceGlyphs.js';
import { formatEvaluation, reviewGame } from '../core/evaluation.js';
import { findHangingPieces } from '../core/staticEval.js';
import { opposite } from '../core/constants.js';
import { clearShareTarget, readShareTarget } from './share.js';

export async function bootstrap(root) {
  const settings = store.loadSettings();
  const sound = new SoundEngine({
    enabled: settings.soundEnabled,
    volume: settings.soundVolume,
  });
  const toaster = new Toaster();

  applyInterfaceTheme(settings);

  // ---------------------------------------------------------------- layout
  const boardHost = el('div.stage__board#board');
  const evalBar = new EvalBar();
  const whiteClock = new ClockFace({ color: 'w' });
  const blackClock = new ClockFace({ color: 'b' });
  const enginePanel = new EnginePanel();
  const statusLine = el('div.status');
  const openingLine = el('div', {
    style: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', minHeight: '1.1em' },
  });

  const session = new Session({ settings });
  const moveList = new MoveList({
    onSelect: (nodeId) => {
      session.goTo(nodeId);
      syncBoard({ animate: true });
    },
  });

  const panel = buildPanel({
    moveList,
    enginePanel,
    whiteClock,
    blackClock,
    openingLine,
    statusLine,
  });
  const rail = buildRail();

  const topbar = buildTopBar();
  root.append(
    el('div.app', {}, [
      topbar.element,
      el('div.app__body', {}, [
        el('div.stage', {}, [
          rail.element,
          el('div.stage__frame', {}, [evalBar.element, boardHost]),
        ]),
        panel.element,
      ]),
    ]),
  );

  // ---------------------------------------------------------------- render
  const canUseWebGL = webGLEnabled();
  if (!canUseWebGL && settings.dimensions === 3) {
    settings.dimensions = 2;
    toaster.show('WebGL is unavailable, so the board is in 2D.');
  }

  /** Applies the theme, honouring the high-contrast highlight override. */
  function themeFor() {
    const theme = getTheme(settings.theme);
    return settings.highContrast ? { ...theme, highlights: ACCESSIBLE_HIGHLIGHTS } : theme;
  }

  function createBoard() {
    const shared = {
      theme: settings.theme,
      reducedMotion: settings.reducedMotion,
      showNotation: settings.showCoordinates,
      orientation: session.playerColor === 'w' ? 'white' : 'black',
    };
    const instance =
      settings.dimensions === 3
        ? new Board3D(boardHost, {
            ...shared,
            pieceSet: settings.pieceSet,
            quality: settings.quality ?? undefined,
          })
        : new Board2D(boardHost, { ...shared, pieceSet: settings.pieceSet2d });
    instance.setTheme(themeFor());
    return instance;
  }

  let board = createBoard();

  let selected = null;
  let hintMove = null;
  /** The keyboard board cursor, drawn as a hover tint. Null when unfocused. */
  let cursorSquare = null;

  // A second engine on its own worker, so analysing never competes with the
  // opponent for a search slot.
  const analyser = new Analyser({ profile: 'lozza' });
  /** Live evaluation of the position on screen, when analysis is on. */
  let liveEvaluation = null;

  // ------------------------------------------------------------ board sync
  function highlightState() {
    const status = session.status();
    const last = session.state.node.move;
    // The coach layer: pieces of the side to move that can simply be taken.
    // Deliberately only the clear cases — an overlay that lights up half the
    // board every move is noise, and players stop reading it.
    const threatened =
      settings.coachHints && !status.result.over
        ? findHangingPieces(session.state.fen, status.turn)
            .filter((entry) => entry.loss >= 100)
            .slice(0, 3)
            .map((entry) => entry.square)
        : [];
    return {
      threatened,
      // The keyboard cursor lives here so an unrelated refresh — a hint, a
      // coach update — does not wipe the square the user is standing on.
      hover: cursorSquare,
      lastMove: last ? { from: last.from, to: last.to } : null,
      check: status.check ? session.kingSquare(status.turn) : null,
      hint: hintMove ? { from: hintMove.from, to: hintMove.to } : null,
      selected,
      legal:
        selected && settings.showLegalMoves
          ? session.state.legalMoves(selected).map((move) => ({
              to: move.to,
              capture: Boolean(move.captured),
            }))
          : [],
    };
  }

  function syncBoard({ animate = true } = {}) {
    board.setPosition(session.state.position(), { animate });
    board.setHighlights(highlightState());
    moveList.render(session.state.tree);
    renderStatus();
    if (settings.liveAnalysis)
      analyser.analyse(session.state.fen, { turn: session.turn ?? session.state.turn });
  }

  function renderStatus() {
    const status = session.status();
    const turnName = status.turn === 'w' ? 'White' : 'Black';
    const bits = [];

    if (status.result.over) {
      bits.push(el('strong', { text: describeResult(status.result) }));
    } else {
      bits.push(`${turnName} to move`);
      if (status.check)
        bits.push(el('span.status__badge', { dataset: { tone: 'check' }, text: 'Check' }));
      if (status.thinking) {
        bits.push(el('span.status__spinner'));
        bits.push(el('span.status__badge', { dataset: { tone: 'thinking' }, text: 'Thinking' }));
      }
      if (status.reviewing) bits.push(el('span.status__badge', { text: 'Reviewing' }));
    }
    replaceChildren(statusLine, bits);

    openingLine.textContent = status.opening
      ? `${status.opening.eco} · ${status.opening.name}`
      : '';

    const material = status.material;
    whiteClock.setCaptured(material.w, Math.max(0, material.balance));
    blackClock.setCaptured(material.b, Math.max(0, -material.balance));

    // Prefer the live analysis of the position being viewed; fall back to
    // whatever was recorded when the move was played.
    const evaluation =
      liveEvaluation && liveEvaluation.fen === session.state.fen
        ? liveEvaluation.evaluation
        : session.state.node.evaluation;
    evalBar.set(evaluation);

    rail.setBusy(status.thinking);
  }

  // ------------------------------------------------------------- move flow
  async function attemptMove(from, to) {
    // Only bail at the live end of a finished game. `canMove` is also false
    // while reviewing, which made dragging a piece from an earlier position do
    // nothing — even though typing the same move there branches happily.
    if (session.state.isFinished && !session.thinking) {
      board.clearSelection();
      selected = null;
      return;
    }
    let promotion;
    if (session.state.needsPromotion(from, to)) {
      promotion = await askPromotion(session.state.turn);
    }
    selected = null;
    board.clearSelection();
    hintMove = null;

    const before = session.state.ply;
    const played = await session.play({ from, to, promotion });
    if (!played && session.state.ply === before && !session.thinking) {
      sound.play('illegal');
      board.setPosition(session.state.position(), { animate: true });
      board.setHighlights(highlightState());
      return;
    }
    syncBoard();
  }

  /**
   * The two renderers implement the same contract, so the wiring is identical
   * and gets re-applied to whichever one is mounted.
   */
  function wireBoard() {
    board.on('move', ({ from, to }) => {
      attemptMove(from, to);
    });
    board.on('select', (square) => {
      selected = square;
      board.setHighlights(highlightState());
      if (square) sound.play('select');
    });
    board.on('arrow', ({ from, to }) => {
      board.setArrows([{ from, to }]);
    });
    board.on('ready', () => {
      syncBoard({ animate: false });
      if (board.capabilities.cameraModes) board.setCameraMode(settings.cameraMode);
    });
  }
  wireBoard();

  /** Swaps 2D for 3D or back, preserving position and orientation. */
  async function setDimensions(dimensions) {
    if (dimensions === settings.dimensions) return;
    if (dimensions === 3 && !canUseWebGL) {
      toaster.error('WebGL is unavailable in this browser.');
      return;
    }
    const orientation = board.orientation();
    settings.dimensions = dimensions;
    board.destroy();
    board = createBoard();
    board.orientation(orientation);
    wireBoard();
    syncBoard({ animate: false });
    store.saveSettings(settings);
  }

  // --------------------------------------------------------- session events
  session.on('move', ({ move, node }) => {
    const status = session.status();
    sound.playMove(move, { isCheck: status.check, isCheckmate: session.state.isCheckmate });
    if (settings.haptics) sound.haptic(move.captured ? [18, 20, 18] : 12);
    announce(
      `${node.moveNumber}${move.color === 'w' ? '.' : '…'} ${describeMove(move, {
        check: status.check,
        checkmate: session.state.isCheckmate,
      })}`,
    );
    syncBoard();
    persist();
  });

  session.on('thinking', () => renderStatus());
  session.on('evaluation', ({ info, turn }) => enginePanel.update(info, turn));
  session.on('clock', (snapshot) => {
    whiteClock.setTime(snapshot.w, { active: snapshot.running === 'w' });
    blackClock.setTime(snapshot.b, { active: snapshot.running === 'b' });
  });
  session.on('lowtime', ({ color }) => {
    sound.play('lowtime');
    toaster.show(`${color === 'w' ? 'White' : 'Black'} is low on time`, { tone: 'error' });
  });
  session.on('gameover', (result) => onGameOver(result));

  // The clock is recomputed from timestamps, so it needs a heartbeat to redraw.
  // Kept so teardown can stop it; an orphaned interval pins the whole session.
  const clockTimer = setInterval(() => session.clock.update(), 100);

  /**
   * Guards against a doubled ceremony. Several things can end a game at once —
   * a flag falling on the move that also delivers mate — and each of them
   * emits, so without this the dialog can open twice. Reset whenever a
   * different game starts, or every game after the first ends silently.
   */
  let ceremonyDone = false;

  async function onGameOver(result) {
    if (ceremonyDone) return;
    ceremonyDone = true;
    sound.play('gameover');
    syncBoard();
    store.clearCurrentGame();
    store.addToLibrary({
      pgn: session.state.pgn(),
      result: result.scoreString,
      reason: result.reason,
      opening: session.status().opening?.name ?? null,
      mode: session.mode,
      difficulty: settings.difficulty,
    });

    const answer = await showDialog({
      title: describeResult(result),
      subtitle: reasonText(result.reason),
      body: buildReview(reviewGame(session.state.tree)),
      actions: [
        { label: 'Close', value: null },
        { label: 'Analyse the game', value: 'analyse' },
        { label: 'Rematch', value: 'rematch', variant: 'primary', autofocus: true },
      ],
    });
    if (answer === 'rematch') await startNewGame({ color: opposite(session.playerColor) });
    else if (answer === 'analyse') await runPostGameReview();
  }

  /**
   * Scores every position in the finished game, then shows the summary.
   *
   * Without this pass the only evaluations on record are the ones the opponent
   * produced for its own moves, so half the game has no score and an accuracy
   * figure built on it would be fiction.
   */
  async function runPostGameReview() {
    const nodes = session.state.tree.mainline();
    if (!nodes.length) return;

    const progress = el('progress', { max: nodes.length + 1, value: 0, style: { width: '100%' } });
    const label = el('p.dialog__subtitle', { text: `Analysing ${nodes.length} positions…` });
    const controller = new AbortController();
    const finished = new AbortController();
    const dialog = showDialog({
      title: 'Game review',
      body: [label, progress],
      actions: [{ label: 'Stop', value: 'stop' }],
      dismissible: false,
      closeSignal: finished.signal,
    }).then((value) => {
      if (value === 'stop') controller.abort();
      return value;
    });

    await analyser.start().catch(() => {});
    const completed = await analyser.reviewLine(nodes, {
      root: session.state.tree.root,
      rootFen: session.state.tree.startFen,
      signal: controller.signal,
      onProgress: (done, total) => {
        progress.value = done;
        progress.max = total;
        label.textContent = `Analysing position ${done} of ${total}…`;
      },
    });

    // Close the progress dialog however it ended.
    finished.abort();
    await dialog;
    if (!completed) return;

    const opening = session.status().opening;
    const review = reviewGame(session.state.tree, { bookPlies: opening?.ply ?? 0 });
    moveList.render(session.state.tree);

    const answer = await showDialog({
      title: 'Game review',
      subtitle: opening ? `${opening.eco} · ${opening.name}` : undefined,
      body: [
        buildEvalGraph(nodes, {
          onSelect: (node) => {
            session.goTo(node.id);
            syncBoard({ animate: false });
          },
        }),
        buildReview(review),
      ],
      actions: [
        { label: 'Done', value: null, autofocus: true },
        { label: 'Rematch', value: 'rematch', variant: 'primary' },
      ],
    });
    if (answer === 'rematch') await startNewGame({ color: opposite(session.playerColor) });
  }

  // ------------------------------------------------------------- actions
  async function startNewGame(overrides = {}) {
    ceremonyDone = false;
    await session.newGame({ mode: session.mode, ...overrides });
    const facing = session.playerColor === 'w' ? 'white' : 'black';
    board.orientation(facing);
    evalBar.setOrientation(facing);
    keyboard.setOrientation(facing);
    selected = null;
    hintMove = null;
    board.setArrows([]);
    enginePanel.clear();
    syncBoard({ animate: false });
    sound.play('start');
  }

  /**
   * Everything that swaps in a different game runs through here: reset the
   * ceremony guard, point the board and the keyboard cursor the right way, and
   * ask the computer if it is on move.
   */
  function adoptGame({ facing = board.orientation(), prompt = false } = {}) {
    ceremonyDone = false;
    board.orientation(facing);
    evalBar.setOrientation(facing);
    keyboard.setOrientation(facing);
    syncBoard({ animate: false });
    if (prompt) session.maybePlayEngineMove();
  }

  const dialogs = createDialogs({
    session,
    board: () => board,
    settings,
    toaster,
    sound,
    analyser,
    enginePanel,
    evalBar,
    moveList,
    syncBoard,
    startNewGame,
    adoptGame,
    setDimensions,
    themeFor,
    highlightState,
    renderStatus,
    applyInterfaceTheme,
    clearLiveEvaluation: () => {
      liveEvaluation = null;
    },
  });

  const actions = {
    back: () => {
      session.back();
      syncBoard();
    },
    forward: () => {
      session.forward();
      syncBoard();
    },
    start: () => {
      session.toStart();
      syncBoard();
    },
    end: () => {
      session.toEnd();
      syncBoard();
    },
    flip: () => {
      const next = board.orientation('flip');
      evalBar.setOrientation(next);
      keyboard.setOrientation(next);
      renderStatus();
    },
    dimensions: () => setDimensions(settings.dimensions === 3 ? 2 : 3),
    hint: async () => {
      const hint = await session.hint();
      if (!hint) return toaster.show('No hint available right now.');
      hintMove = hint;
      board.setHighlights(highlightState());
      board.setArrows([{ from: hint.from, to: hint.to }]);
      toaster.show(
        hint.evaluation
          ? `Try ${hint.from}–${hint.to} (${formatEvaluation(hint.evaluation)})`
          : `Try ${hint.from}–${hint.to}`,
      );
      setTimeout(() => {
        hintMove = null;
        board.setArrows([]);
        board.setHighlights(highlightState());
      }, 4000);
    },
    takeback: async () => {
      if (session.state.ply === 0) return;
      await session.takeback();
      // Taking back un-finishes the game, so the next result deserves its own
      // ceremony. Leaving the guard set ended the game in silence: no sound,
      // no dialog, and no library entry.
      ceremonyDone = false;
      syncBoard();
      persist();
    },
    escape: () => {
      selected = null;
      board.clearSelection();
      board.setArrows([]);
      board.setHighlights(highlightState());
    },
    typing: () => {},
    help: () => dialogs.showShortcutHelp(),
    resign: () => dialogs.confirmResign(),
    review: () => runPostGameReview(),
    draw: () => dialogs.offerDraw(),
    share: () => dialogs.shareGame(),
    exportGame: () => dialogs.exportGame(),
    importGame: () => dialogs.importGame(),
    library: () => dialogs.showLibrary(),
    newGame: () => dialogs.showNewGameDialog(),
  };

  topbar.setActions(
    [
      ['Games', 'Browse your finished games', 'library', '🗀'],
      ['Import', 'Import a PGN game or FEN position', 'importGame', '↓'],
      ['Export', 'Copy or download this game as PGN', 'exportGame', '↑'],
      ['Share', 'Copy a link to this game', 'share', '↗'],
      ['Draw', 'Offer a draw', 'draw', '½'],
      ['Resign', 'Resign the game', 'resign', '⚑', 'danger'],
      ['New game', 'Start a new game', 'newGame', '＋', 'primary'],
    ],
    (action) => actions[action]?.(),
  );

  // ------------------------------------------------------------- keyboard
  const keyboard = new KeyboardControl({
    boardElement: boardHost,
    onAction: (action) => actions[action]?.(),
    onCursor: (square) => {
      cursorSquare = square;
      board.setHighlights(highlightState());
      if (!square) return;
      // Silent, the cursor was unusable: there was no way to know it had
      // reached e5 rather than e1 before committing to a move.
      const piece = session.state.position()[square];
      announce(
        piece
          ? `${square}, ${piece[0] === 'w' ? 'white' : 'black'} ${PIECE_NAMES[piece[1].toLowerCase()]}`
          : `${square}, empty`,
      );
    },
    onSquare: (square) => {
      if (selected && selected !== square) {
        attemptMove(selected, square);
        return;
      }
      selected = session.state.position()[square] ? square : null;
      board.setHighlights(highlightState());
      announce(selected ? `Selected ${square}` : `${square} is empty`);
    },
    onTyped: async (text) => {
      // Awaited: play() can have to cancel a hint before it applies anything,
      // so reading the ply synchronously called a move that WAS played illegal.
      const before = session.state.ply;
      await session.play(text);
      const accepted = session.state.ply !== before;
      if (!accepted) {
        sound.play('illegal');
        announce(`${text} is not a legal move`, { assertive: true });
      } else {
        syncBoard();
      }
      return accepted;
    },
  });

  // -------------------------------------------------------------- controls
  rail.bind(actions, {
    onNewGame: () => dialogs.showNewGameDialog(),
    onSettings: () => dialogs.showSettings(),
  });

  function persist() {
    // A finished game has been written to the library and deliberately dropped
    // from the in-progress slot. Re-saving it here — the unload handler is the
    // usual culprit — brought it back on the next load, and re-finishing it
    // filed a second copy. Note this is the ceremony flag, not a position test:
    // stepping back through the eval graph makes the position playable again.
    if (ceremonyDone) return;
    store.saveCurrentGame(session.toJSON());
  }

  analyser.on('evaluation', (result) => {
    liveEvaluation = result;
    if (result.fen !== session.state.fen) return;
    evalBar.set(result.evaluation);
    // The opponent's own engine panel takes over while it is thinking.
    if (!session.thinking) {
      enginePanel.update(
        {
          depth: result.depth,
          score: {
            ...result.evaluation,
            value: session.state.turn === 'w' ? result.evaluation.value : -result.evaluation.value,
          },
          pv: result.pv,
        },
        session.state.turn,
      );
    }
  });

  // ------------------------------------------------------------------ boot
  await session.useEngine(settings.engine);
  enginePanel.setEngine(
    ENGINE_PROFILES[settings.engine].name,
    ENGINE_PROFILES[settings.engine].strength,
  );
  session.setDifficulty(settings.difficulty);
  session.setTimeControl(settings.timeControl);

  // A shared link wins over whatever was in progress: someone followed it on
  // purpose, and their own game is still in storage if they reload without it.
  const shared = readShareTarget();
  let loadedFromLink = false;
  if (shared) {
    loadedFromLink = await dialogs.applyImport(shared.kind === 'fen' ? shared.fen : shared.pgn);
    clearShareTarget();
    if (!loadedFromLink) toaster.error('That link does not contain a readable game.');
  }

  const saved = loadedFromLink ? null : store.loadCurrentGame();
  if (saved) {
    try {
      session.loadState(saved.state, {
        mode: saved.mode ?? 'engine',
        playerColor: saved.playerColor ?? 'w',
      });
      session.restoreClock(saved.clock);
      adoptGame({
        facing: session.playerColor === 'w' ? 'white' : 'black',
        // A game restored on the computer's turn had nothing to prompt it, so
        // the board simply sat there.
        prompt: true,
      });
      toaster.show('Picked up where you left off.');
    } catch {
      // A blob from an older version, or a tree that no longer parses. Losing
      // one unfinished game is better than refusing to start.
      store.clearCurrentGame();
    }
  }

  if (settings.liveAnalysis) {
    analyser
      .start()
      .then(() => {
        analyser.setEnabled(true);
        analyser.analyse(session.state.fen, { turn: session.state.turn });
      })
      .catch(() => toaster.show('Live analysis is unavailable.'));
  }

  syncBoard({ animate: false });
  session.clock.update();

  // Browsers require a gesture before audio can start.
  document.addEventListener('pointerdown', () => sound.resume(), { once: true });
  window.addEventListener('beforeunload', persist);

  /** Tears the whole app down. Used by tests and by the dimension switch. */
  function destroy() {
    clearInterval(clockTimer);
    window.removeEventListener('beforeunload', persist);
    keyboard.dispose();
    analyser.dispose();
    board.destroy();
    session.dispose();
  }

  return {
    session,
    sound,
    keyboard,
    settings,
    actions,
    analyser,
    setDimensions,
    destroy,
    /** The mounted renderer changes when dimensions are switched. */
    get board() {
      return board;
    },
  };
}

// ------------------------------------------------------------------ helpers

function describeResult(result) {
  if (!result.over) return 'Game in progress';
  if (!result.winner) return 'Draw';
  return `${result.winner === 'w' ? 'White' : 'Black'} wins`;
}

function reasonText(reason) {
  return (
    {
      checkmate: 'by checkmate',
      resignation: 'by resignation',
      timeout: 'on time',
      agreement: 'by agreement',
      stalemate: 'Stalemate — the side to move has no legal move.',
      'insufficient-material': 'Neither side has enough material to mate.',
      'threefold-repetition': 'The same position occurred three times.',
      'fifty-move-rule': 'Fifty moves passed with no capture or pawn move.',
    }[reason] ?? ''
  );
}

function buildReview(review) {
  // Below this, too much of the game went unscored for an accuracy figure to
  // mean anything — showing one anyway reads as "you played perfectly".
  if (review.coverage < 0.9) {
    return el('p', {
      text: 'Run a full analysis to see accuracy and where the game turned.',
      style: { color: 'var(--text-2)', fontSize: 'var(--text-sm)', margin: '0' },
    });
  }

  const row = (label, white, black) => [
    el('span.review__label', { text: label }),
    el('span.review__value', { text: String(white) }),
    el('span.review__value', { text: String(black) }),
  ];
  return el('div.review', {}, [
    el('span'),
    el('span.review__label', { text: 'White' }),
    el('span.review__label', { text: 'Black' }),
    el('span.review__label', { text: 'Accuracy' }),
    el('span.review__accuracy', { text: `${review.w.accuracy}` }),
    el('span.review__accuracy', { text: `${review.b.accuracy}` }),
    ...row('Blunders', review.w.blunder, review.b.blunder),
    ...row('Mistakes', review.w.mistake, review.b.mistake),
    ...row('Inaccuracies', review.w.inaccuracy, review.b.inaccuracy),
    ...row('Book moves', review.w.book, review.b.book),
  ]);
}

function applyInterfaceTheme(settings) {
  const root = document.documentElement;
  if (settings.uiTheme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = settings.uiTheme;
  root.dataset.contrast = settings.highContrast ? 'high' : 'normal';
}

function buildTopBar() {
  const actions = el('div.topbar__actions');
  const element = el('header.topbar', {}, [
    el('h1.topbar__brand', {}, ['chessboard3', el('span', { text: 'three.js chess' })]),
    el('div.topbar__spacer'),
    actions,
  ]);

  return {
    element,
    /**
     * @param {Array<[label: string, title: string, action: string, icon: string,
     *               variant?: string]>} spec
     *
     * Each button carries both an icon and a label; narrow screens show only
     * the icon, because six labelled buttons do not fit across a phone and the
     * row simply ran off the edge.
     */
    setActions(spec, onAction) {
      actions.replaceChildren(
        ...spec.map(([label, title, action, icon, variant]) =>
          el(
            'button.button',
            {
              type: 'button',
              class:
                variant === 'primary'
                  ? 'button--primary'
                  : variant === 'danger'
                    ? 'button--danger'
                    : 'button--quiet',
              title,
              'aria-label': title,
              on: { click: () => onAction(action) },
            },
            [
              el('span.button__icon', { text: icon, 'aria-hidden': 'true' }),
              el('span.button__label', { text: label }),
            ],
          ),
        ),
      );
    },
  };
}

function buildRail() {
  const make = (label, title, action) =>
    el('button.button.button--quiet.button--icon', {
      type: 'button',
      title,
      'aria-label': title,
      text: label,
      dataset: { action },
    });

  const buttons = [
    make('⟪', 'Jump to the start', 'start'),
    make('‹', 'Back one move', 'back'),
    make('›', 'Forward one move', 'forward'),
    make('⟫', 'Jump to the latest move', 'end'),
    make('⇅', 'Flip the board', 'flip'),
    make('◫', 'Switch between 2D and 3D', 'dimensions'),
    make('◎', 'Hint', 'hint'),
    make('↩', 'Take back', 'takeback'),
    make('＋', 'New game', 'new'),
    make('⚙', 'Settings', 'settings'),
  ];
  const element = el('nav.rail', { 'aria-label': 'Game controls' }, buttons);

  return {
    element,
    setBusy(busy) {
      for (const button of buttons) {
        if (['hint', 'takeback'].includes(button.dataset.action)) button.disabled = busy;
      }
    },
    bind(actions, { onNewGame, onSettings }) {
      element.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const name = button.dataset.action;
        if (name === 'new') return onNewGame();
        if (name === 'settings') return onSettings();
        actions[name]?.();
      });
    },
  };
}

function buildPanel({ moveList, enginePanel, whiteClock, blackClock, openingLine, statusLine }) {
  const element = el('aside.panel', { 'aria-label': 'Game information' }, [
    el('div.panel__scroll', {}, [
      el('div.panel__section', {}, [
        blackClock.container,
        el('div', { style: { height: 'var(--space-2)' } }),
        whiteClock.container,
      ]),
      el('div.panel__section', {}, [statusLine, openingLine]),
      el('div.panel__section', {}, [
        el('h2.panel__title', { text: 'Engine' }),
        enginePanel.element,
      ]),
      el('div.panel__section', { style: { flex: '1' } }, [
        el('h2.panel__title', { text: 'Moves' }),
        moveList.element,
      ]),
    ]),
  ]);
  return { element };
}
