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
import { webGLEnabled } from '../render/webgl.js';
import { ACCESSIBLE_HIGHLIGHTS, getTheme } from '../render/three/themes.js';
import { SoundEngine } from '../audio/soundEngine.js';
import { ENGINE_PROFILES } from '../engine/engineProfiles.js';
import { Analyser } from '../engine/analyser.js';
import { el, announce, replaceChildren } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { EvalBar } from '../ui/evalBar.js';
import { ClockFace } from '../ui/clockFace.js';
import { MoveList } from '../ui/moveList.js';
import { EnginePanel } from '../ui/enginePanel.js';
import { Toaster } from '../ui/toast.js';
import { StarPrompt, GAMES_BEFORE_ASKING } from '../ui/starPrompt.js';
import { askPromotion, showDialog } from '../ui/dialog.js';
import { buildEvalGraph } from '../ui/evalGraph.js';
import { createDialogs } from './dialogs.js';
import { highlightState as buildHighlights } from './highlights.js';
import { PIECE_NAMES, describeMove } from '../ui/pieceGlyphs.js';
import { formatEvaluation, reviewGame } from '../core/evaluation.js';
import { opposite } from '../core/constants.js';
import { clearShareTarget, readShareTarget } from './share.js';

/** Where the star prompt sends people. */
const REPOSITORY_URL = 'https://github.com/ibra-kdbra/Chessboard-three.js';

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
  const openingLine = el('div.matchmeta__opening');

  const session = new Session({ settings });
  const moveList = new MoveList({
    onSelect: (nodeId) => {
      session.goTo(nodeId);
      syncBoard({ animate: true });
    },
  });

  const transport = buildTransport();
  const assist = buildAssist();
  const starPrompt = new StarPrompt({
    url: REPOSITORY_URL,
    onAnswer: () => store.markStarPromptAnswered(),
  });
  const panel = buildPanel({
    moveList,
    enginePanel,
    whiteClock,
    blackClock,
    openingLine,
    statusLine,
    transport,
    assist,
    starPrompt,
  });

  const topbar = buildTopBar();
  root.append(
    el('div.app', {}, [
      topbar.element,
      el('div.app__body', {}, [
        el('div.stage', {}, [el('div.stage__frame', {}, [evalBar.element, boardHost])]),
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

  /**
   * Loads and mounts the renderer for the current setting.
   *
   * The two renderers are imported on demand rather than at module scope: the
   * 3D one drags in the whole three.js runtime, and a visitor who has chosen
   * the 2D board — or whose browser cannot give us WebGL — was downloading
   * roughly a megabyte across 29 requests to render a canvas that never uses
   * any of it.
   */
  async function createBoard() {
    const shared = {
      theme: settings.theme,
      reducedMotion: settings.reducedMotion,
      showNotation: settings.showCoordinates,
      orientation: session.playerColor === 'w' ? 'white' : 'black',
    };
    let instance;
    if (settings.dimensions === 3) {
      const { Board3D } = await import('../render/three/board3d.js');
      instance = new Board3D(boardHost, {
        ...shared,
        pieceSet: settings.pieceSet,
        // Only when the user has actually chosen one; otherwise let the board
        // probe the device rather than being handed a non-answer.
        ...(settings.quality ? { quality: settings.quality } : {}),
      });
    } else {
      const { Board2D } = await import('../render/two/board2d.js');
      instance = new Board2D(boardHost, { ...shared, pieceSet: settings.pieceSet2d });
    }
    instance.setTheme(themeFor());
    return instance;
  }

  let board = await createBoard();

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
  /** The board's highlight state, from `./highlights.js`. */
  function highlightState() {
    return buildHighlights({ session, settings, selected, cursorSquare, hintMove });
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

    // Whose move it is, on the rows themselves. Nothing is lit once the game is
    // over: a finished game has no side to move, and leaving a row glowing
    // after a checkmate reads as "your turn".
    const toMove = status.result.over ? null : status.turn;
    whiteClock.setActive(toMove === 'w', status.flagged === 'w');
    blackClock.setActive(toMove === 'b', status.flagged === 'b');

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

    // Every control that can be pointless right now says so.
    transport.setState({
      atStart: session.state.ply === 0,
      atEnd: !session.state.isReviewing,
    });
    assist.setState({
      thinking: status.thinking,
      canHint: !status.result.over && !session.state.isReviewing,
      canTakeback: session.state.ply > 0,
    });
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

  /** Counts swaps so a superseded one can throw away the board it built. */
  let swapSeq = 0;

  /**
   * Swaps 2D for 3D or back, preserving position and orientation.
   *
   * Two things this has to survive, both of which arrived when the renderers
   * started loading over the network rather than at page load:
   *
   * A second swap while the first is still importing. The old code destroyed
   * the board up front, so the second call read orientation off a dead board
   * and both calls went on to mount one — leaving an orphaned canvas covering
   * a live board that was rendering off-screen, with no error to say so.
   *
   * An import that never arrives. Destroying first meant a failed fetch left
   * no board mounted at all and nothing to recover with.
   *
   * So: build the replacement first, and only tear down the working one once
   * there is something to put in its place and this swap is still the current
   * one.
   */
  async function setDimensions(dimensions) {
    if (dimensions === settings.dimensions) return;
    if (dimensions === 3 && !canUseWebGL) {
      toaster.error('WebGL is unavailable in this browser.');
      return;
    }
    const orientation = board.orientation();
    const previous = settings.dimensions;
    settings.dimensions = dimensions;
    const seq = ++swapSeq;

    let next;
    try {
      next = await createBoard();
    } catch {
      if (seq === swapSeq) settings.dimensions = previous;
      toaster.error('That board could not be loaded. Check your connection and try again.');
      return;
    }

    if (seq !== swapSeq) {
      // A later swap took over. Nothing else holds this one, so free it here.
      next.destroy();
      return;
    }

    board.destroy();
    board = next;
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
    whiteClock.setTime(snapshot.w);
    blackClock.setTime(snapshot.b);
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

    // After the result has been dealt with, never during it: the ask belongs
    // behind the game, not in front of it.
    maybeAskForAStar();
  }

  /** Shows the star prompt once, and only once someone has played a few games. */
  function maybeAskForAStar() {
    if (store.starPromptAnswered()) return;
    if (store.loadLibrary().length < GAMES_BEFORE_ASKING) return;
    starPrompt.show();
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
    settings: () => dialogs.showSettings(),
    resign: () => dialogs.confirmResign(),
    review: () => runPostGameReview(),
    draw: () => dialogs.offerDraw(),
    share: () => dialogs.shareGame(),
    exportGame: () => dialogs.exportGame(),
    importGame: () => dialogs.importGame(),
    library: () => dialogs.showLibrary(),
    newGame: () => dialogs.showNewGameDialog(),
  };

  const runAction = (action) => actions[action]?.();
  topbar.setControls(
    {
      // Navigation, not a game action: it is the only control here that does
      // not touch the game in front of you, so it does not sit with the ones
      // that do.
      nav: [['Games', 'Browse your finished games', 'library', 'library']],
      actions: [
        ['Draw', 'Offer a draw', 'draw', 'draw'],
        ['Resign', 'Resign the game', 'resign', 'resign', 'danger'],
        ['New game', 'Start a new game', 'newGame', 'newGame', 'primary'],
      ],
      // Real, but rarely. Three transfer actions and a shortcut sheet were
      // taking more than half the row's permanent slots for things most players
      // never touch — and on a phone that row ran off the edge of the screen.
      overflow: [
        ['Import', 'Import a PGN game or FEN position', 'importGame', 'import'],
        ['Export', 'Copy or download this game as PGN', 'exportGame', 'export'],
        ['Share', 'Copy a link to this game', 'share', 'share'],
        // The shortcut sheet used to be reachable only by pressing the shortcut
        // for it, which helps exactly the people who did not need it.
        ['Keyboard shortcuts', 'Keyboard shortcuts (Shift ?)', 'help', 'help'],
      ],
    },
    runAction,
  );
  topbar.setUtilities([['Settings', 'Settings', 'settings', 'settings']], runAction);
  topbar.setStarLink({ url: REPOSITORY_URL, label: 'Star Boxwood' });

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
  transport.bind(actions);
  assist.bind(actions);

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
    store,
    maybeAskForAStar,
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

/** One labelled button, used by the nav, the action row and the overflow menu. */
function labelledButton([label, title, action, iconName, variant], onAction) {
  const button = el('button.button', {
    type: 'button',
    class:
      variant === 'primary'
        ? 'button--primary'
        : variant === 'danger'
          ? 'button--danger'
          : 'button--quiet',
    title,
    'aria-label': label,
    on: { click: () => onAction(action) },
  });
  button.append(icon(iconName, 16), el('span.button__label', { text: label }));
  return button;
}

/**
 * The header.
 *
 * Reading order, left to right: who this is, where you can go, what you can do
 * to the game in front of you, and then the chrome. The star sits with the
 * wordmark rather than in the far corner — an open-source project's identity
 * includes being one, and the corner is the last place anyone looks.
 */
function buildTopBar() {
  const identity = el('div.topbar__identity', {}, [el('h1.topbar__brand', { text: 'Boxwood' })]);
  const nav = el('div.topbar__nav');
  const actions = el('div.topbar__actions');
  const utilities = el('div.topbar__utilities');
  // A popover, not an absolutely-positioned dropdown: `.app` is `overflow:
  // hidden` and the action row scrolls on narrow screens, so a normal menu is
  // clipped by both. The top layer is immune to either.
  const menu = el('div.topbar__menu#topbar-more', { popover: 'auto' });
  const trigger = el('button.button.button--quiet.button--icon', {
    type: 'button',
    title: 'More actions',
    'aria-label': 'More actions',
    popovertarget: 'topbar-more',
  });
  trigger.append(icon('more'));

  const element = el('header.topbar', {}, [
    identity,
    nav,
    el('div.topbar__spacer'),
    actions,
    utilities,
    menu,
  ]);

  // What the bar shows depends on how much bar there is. Controls move into the
  // menu rather than shrinking below the touch floor or scrolling off the edge:
  // seven controls plus a wordmark measured 409px of content in a 380px window,
  // and pushed the whole page sideways.
  //
  // Two stops, in order of what a player gives up least. First the game actions
  // that are not the primary one — a draw offer is a rare decision. Then the
  // library, which is somewhere you go rather than something you do to the game
  // in front of you.
  //
  // The width is read on resize rather than subscribed to with
  // `matchMedia().onchange`: that event is not delivered at all under an
  // emulated viewport, so the bar kept whatever layout it booted with and a
  // phone got the desktop row.
  const NARROW = 640;
  const TINY = 480;
  let navSpec = [];
  let actionSpec = [];
  let menuSpec = [];
  let onAction = () => {};
  let laidOut = null;

  function render() {
    const width = window.innerWidth;
    const layout = width <= TINY ? 'tiny' : width <= NARROW ? 'narrow' : 'wide';
    // Rebuilding on every resize event would throw away focus mid-drag, and
    // the answer only changes twice across the whole range.
    if (layout === laidOut) return;
    laidOut = layout;

    const demotedNav = layout === 'tiny' ? navSpec : [];
    const demotedActions =
      layout === 'wide' ? [] : actionSpec.filter((entry) => entry[4] !== 'primary');
    const build = (spec) => spec.map((entry) => labelledButton(entry, onAction));
    nav.replaceChildren(...build(navSpec.filter((entry) => !demotedNav.includes(entry))));
    actions.replaceChildren(
      ...build(actionSpec.filter((entry) => !demotedActions.includes(entry))),
    );
    // Navigation leads, then the actions it displaced, then the things that
    // live here at every width.
    menu.replaceChildren(...build([...demotedNav, ...demotedActions, ...menuSpec]));
  }

  window.addEventListener('resize', render);

  // The top layer has no idea where the trigger is, so an unanchored popover
  // lands in the corner of the viewport. CSS anchor positioning is not broadly
  // supported yet, so the placement is measured on open.
  //
  // It anchors by `right`, not `left`, on purpose: the menu is still `display:
  // none` while `beforetoggle` runs, so its own width cannot be read yet, and
  // right-alignment is the one edge that does not need it. Measuring after the
  // frame instead was the earlier attempt, and it lost the race often enough to
  // leave the menu in the corner.
  menu.addEventListener('beforetoggle', (event) => {
    if (event.newState !== 'open') return;
    const at = trigger.getBoundingClientRect();
    menu.style.left = 'auto';
    // Flush with the trigger, with no inset of its own: the button is already
    // as close to the edge as the header lets anything get, and holding the
    // menu 8px further in only broke the alignment on the narrowest phones.
    // Staying inside the window is `max-width`'s job, not this one's.
    menu.style.right = `${Math.round(Math.max(0, window.innerWidth - at.right))}px`;
    menu.style.top = `${Math.round(at.bottom + 6)}px`;
  });

  // Picking something is a decision; the menu should not linger.
  menu.addEventListener('click', (event) => {
    if (event.target.closest('button')) menu.hidePopover();
  });

  return {
    element,

    /**
     * @param {object} spec
     * @param {Array<[label: string, title: string, action: string, icon: string,
     *               variant?: string]>} spec.nav where you can go, kept away
     *   from the controls that act on the game in front of you
     * @param {Array} spec.actions what the game can be told to do
     * @param {Array} spec.overflow the same shape, for things that exist but do
     *   not deserve permanent space
     * @param {(action: string) => void} handler
     *
     * All three lists go in together because the split between them moves with
     * the window, and rendering one from a stale copy of another put duplicate
     * controls in the bar.
     */
    setControls({ nav: navItems, actions: actionItems, overflow }, handler) {
      navSpec = navItems;
      actionSpec = actionItems;
      menuSpec = overflow;
      onAction = handler;
      laidOut = null;
      render();
    },

    /**
     * The chrome that is not part of playing. Separated from the game actions
     * so a once-a-session control never sits beside one that ends the game.
     */
    setUtilities(spec, handler) {
      utilities.replaceChildren(
        ...spec.map(([label, title, action, iconName]) => {
          const button = el('button.button.button--quiet.button--icon', {
            type: 'button',
            title,
            'aria-label': label,
            on: { click: () => handler(action) },
          });
          button.append(icon(iconName));
          return button;
        }),
        trigger,
      );
    },

    /**
     * The permanent star link, beside the wordmark.
     *
     * The earned prompt in the panel is a nudge after a few games; this is the
     * door that is always open. It used to be the last item in the far right
     * cluster, which is where a page puts the things it hopes you will not
     * click — the exact opposite of what it is for.
     */
    setStarLink({ url, label }) {
      const link = el('a.button.starlink', {
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: `${label} on GitHub`,
      });
      link.append(icon('star', 16), el('span.button__label', { text: 'Star' }));
      identity.append(link);
    },
  };
}

/**
 * Move navigation, as a strip that lives on the move list.
 *
 * It used to be four buttons in a left rail, a screen's width away from the
 * move list they actually drive — press on the left, read the result on the
 * right, press again. Attaching them to the list removes that round trip, and
 * is where every chess player already looks for them.
 */
function buildTransport() {
  const make = (name, label, hint, action) => {
    const button = el('button.button.button--quiet.button--icon', {
      type: 'button',
      title: `${label} (${hint})`,
      'aria-label': label,
      dataset: { action },
    });
    button.append(icon(name));
    return button;
  };

  const buttons = [
    make('first', 'Jump to the start', 'Home', 'start'),
    make('previous', 'Back one move', '←', 'back'),
    make('next', 'Forward one move', '→', 'forward'),
    make('last', 'Jump to the latest move', 'End', 'end'),
    make('flip', 'Flip the board', 'Shift F', 'flip'),
  ];
  const byAction = Object.fromEntries(buttons.map((b) => [b.dataset.action, b]));

  const element = el('div.transport', { role: 'toolbar', 'aria-label': 'Move navigation' }, [
    el('div.transport__group', {}, buttons.slice(0, 4)),
    byAction.flip,
  ]);

  return {
    element,
    /**
     * Greys out what would do nothing. These used to stay lit at both ends of
     * the game, so a click on "back" at move one was a silent no-op — and a
     * screen reader announced an actionable control that was not.
     */
    setState({ atStart, atEnd }) {
      byAction.start.disabled = atStart;
      byAction.back.disabled = atStart;
      byAction.forward.disabled = atEnd;
      byAction.end.disabled = atEnd;
    },
    bind(actions) {
      element.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (button && !button.disabled) actions[button.dataset.action]?.();
      });
    },
  };
}

/**
 * Hint and take back: the two controls that change or reveal the game.
 *
 * Both carry a permanent label. As icons they were unreadable — and worse,
 * "take back" and "back one move" are the same idea in a player's head with
 * very different consequences, so leaving them as two similar glyphs two slots
 * apart invited exactly the wrong click.
 */
function buildAssist() {
  const make = (name, label, hint, action) => {
    const button = el('button.button.button--quiet', {
      type: 'button',
      title: `${label} (${hint})`,
      dataset: { action },
    });
    button.append(icon(name, 16), el('span.button__label', { text: label }));
    return button;
  };

  const buttons = [
    make('hint', 'Hint', 'Shift H', 'hint'),
    make('takeback', 'Take back', 'Shift T', 'takeback'),
  ];
  const element = el('div.assist', {}, buttons);

  return {
    element,
    setState({ thinking, canHint, canTakeback }) {
      buttons[0].disabled = thinking || !canHint;
      buttons[1].disabled = thinking || !canTakeback;
    },
    bind(actions) {
      element.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (button && !button.disabled) actions[button.dataset.action]?.();
      });
    },
  };
}

function buildPanel({
  moveList,
  enginePanel,
  whiteClock,
  blackClock,
  openingLine,
  statusLine,
  transport,
  assist,
  starPrompt,
}) {
  // One band, not three sections.
  //
  // The two players, the status and the opening used to be three bordered
  // blocks with a heading each, and together they held 239px of a 336px column
  // whatever the window was doing. At 620px tall that left the move list 50px —
  // one row of a game that might run eighty. They are one band now: a row per
  // player carrying their own clock and captures, and a two-line footer for the
  // state of the game.
  //
  // The engine readout moved to the bottom. It is ambient — you glance at it —
  // and it was competing for the fixed budget at the top with the two things
  // you actually read.
  //
  // Only the move list scrolls. The band is pinned, because a long game used to
  // push the clocks off the top of the screen: losing the most time-critical
  // readout in the product at exactly the moment it matters most.
  const element = el('aside.panel', { 'aria-label': 'Game information' }, [
    el('div.panel__fixed.panel__match', {}, [
      el('h2.visually-hidden', { text: 'Players' }),
      // The pair is one surface. Two bordered cards read as two things that
      // happen to be near each other; one raised block with two rows in it
      // reads as the match, which is what it is.
      el('div.matchband', {}, [blackClock.element, whiteClock.element]),
      el('div.matchmeta', {}, [statusLine, openingLine]),
    ]),
    el('section.panel__moves', {}, [
      el('h2.visually-hidden', { text: 'Moves' }),
      moveList.element,
      transport.element,
    ]),
    el('section.panel__engine', {}, [
      el('h2.visually-hidden', { text: 'Engine' }),
      enginePanel.element,
    ]),
    assist.element,
    starPrompt.element,
  ]);
  return { element };
}
