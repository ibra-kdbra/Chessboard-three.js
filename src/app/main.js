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
import { KeyboardControl, SHORTCUTS } from './keyboard.js';
import * as store from './persistence.js';
import { Board3D, CAMERA_MODES } from '../render/three/board3d.js';
import { webGLEnabled } from '../render/three/scene.js';
import { THEMES, ACCESSIBLE_HIGHLIGHTS, getTheme } from '../render/three/themes.js';
import { PIECE_SETS } from '../render/three/pieces.js';
import { SoundEngine } from '../audio/soundEngine.js';
import { ENGINE_PROFILES } from '../engine/engineProfiles.js';
import { DIFFICULTY_LEVELS } from '../engine/opponent.js';
import { TIME_CONTROLS } from '../core/clock.js';
import { el, options, announce, replaceChildren } from '../ui/dom.js';
import { EvalBar } from '../ui/evalBar.js';
import { ClockFace } from '../ui/clockFace.js';
import { MoveList } from '../ui/moveList.js';
import { EnginePanel } from '../ui/enginePanel.js';
import { Toaster } from '../ui/toast.js';
import { showDialog, askPromotion } from '../ui/dialog.js';
import { describeMove } from '../ui/pieceGlyphs.js';
import { formatEvaluation, reviewGame } from '../core/evaluation.js';
import { opposite } from '../core/constants.js';

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

  root.append(
    el('div.app', {}, [
      buildTopBar(),
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
  if (!webGLEnabled()) {
    boardHost.append(
      el('div', {
        style: {
          display: 'grid',
          placeItems: 'center',
          height: '100%',
          padding: '2rem',
          textAlign: 'center',
          color: 'var(--text-2)',
        },
        text: 'This browser cannot run WebGL, so the 3D board is unavailable.',
      }),
    );
    toaster.error('WebGL is unavailable — the 3D board cannot start.');
    return null;
  }

  const board = new Board3D(boardHost, {
    theme: settings.theme,
    pieceSet: settings.pieceSet,
    quality: settings.quality ?? undefined,
    reducedMotion: settings.reducedMotion,
    showNotation: settings.showCoordinates,
  });

  if (settings.highContrast) {
    board.theme = { ...getTheme(settings.theme), highlights: ACCESSIBLE_HIGHLIGHTS };
    board.setTheme(board.theme);
  }

  let selected = null;
  let hintMove = null;

  // ------------------------------------------------------------ board sync
  function highlightState() {
    const status = session.status();
    const last = session.state.node.move;
    return {
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

    const evaluation = session.state.node.evaluation;
    evalBar.set(evaluation);

    rail.setBusy(status.thinking);
  }

  // ------------------------------------------------------------- move flow
  async function attemptMove(from, to) {
    if (!session.canMove && !session.thinking) {
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
  setInterval(() => session.clock.update(), 100);

  async function onGameOver(result) {
    sound.play(result.winner ? 'gameover' : 'gameover');
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

    const review = reviewGame(session.state.tree);
    const answer = await showDialog({
      title: describeResult(result),
      subtitle: reasonText(result.reason),
      body: buildReview(review),
      actions: [
        { label: 'Review the game', value: 'review' },
        { label: 'Rematch', value: 'rematch', variant: 'primary', autofocus: true },
      ],
    });
    if (answer === 'rematch') await startNewGame({ color: opposite(session.playerColor) });
  }

  // ------------------------------------------------------------- actions
  async function startNewGame(overrides = {}) {
    await session.newGame({ mode: session.mode, ...overrides });
    board.orientation(session.playerColor === 'w' ? 'white' : 'black');
    evalBar.setOrientation(session.playerColor === 'w' ? 'white' : 'black');
    selected = null;
    hintMove = null;
    board.setArrows([]);
    enginePanel.clear();
    syncBoard({ animate: false });
    sound.play('start');
  }

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
      renderStatus();
    },
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
    help: () => showShortcutHelp(),
  };

  // ------------------------------------------------------------- keyboard
  const keyboard = new KeyboardControl({
    boardElement: boardHost,
    onAction: (action) => actions[action]?.(),
    onCursor: (square) => {
      board.setHighlights({ ...highlightState(), hover: square });
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
    onTyped: (text) => {
      // `play` is async, but it applies the move before its first await, so the
      // ply is already updated when this returns — which is what lets the
      // keyboard layer know whether to clear the buffer.
      const before = session.state.ply;
      session.play(text);
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
  rail.bind(actions, { onNewGame: () => showNewGameDialog(), onSettings: () => showSettings() });

  function persist() {
    store.saveCurrentGame(session.toJSON());
  }

  async function showNewGameDialog() {
    const modeSelect = el(
      'select.select',
      {},
      options(
        [
          ['engine', 'Play the computer'],
          ['hotseat', 'Two players, one device'],
          ['analysis', 'Analysis board'],
        ],
        session.mode,
      ),
    );
    const colorSelect = el(
      'select.select',
      {},
      options(
        [
          ['w', 'Play as White'],
          ['b', 'Play as Black'],
          ['random', 'Random side'],
        ],
        settings.playerColor,
      ),
    );
    const levelSelect = el(
      'select.select',
      {},
      options(
        DIFFICULTY_LEVELS.map((level) => [
          String(level.level),
          `${level.level}. ${level.name}${level.approxElo ? ` · ~${level.approxElo}` : ''}`,
        ]),
        String(settings.difficulty),
      ),
    );
    const timeSelect = el(
      'select.select',
      {},
      options(
        TIME_CONTROLS.map((control) => [control.id, `${control.label} · ${control.category}`]),
        settings.timeControl,
      ),
    );
    const engineSelect = el(
      'select.select',
      {},
      options(
        Object.values(ENGINE_PROFILES).map((profile) => [
          profile.id,
          `${profile.name} · ${profile.strength}`,
        ]),
        settings.engine,
      ),
    );

    const answer = await showDialog({
      title: 'New game',
      body: [
        field('Mode', modeSelect),
        field('Side', colorSelect),
        field('Difficulty', levelSelect),
        field('Time control', timeSelect),
        field('Engine', engineSelect),
      ],
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Start', value: 'start', variant: 'primary', autofocus: true },
      ],
    });
    if (answer !== 'start') return;

    settings.difficulty = Number(levelSelect.value);
    settings.timeControl = timeSelect.value;
    settings.playerColor = colorSelect.value;
    store.saveSettings(settings);

    session.setMode(modeSelect.value);
    if (engineSelect.value !== settings.engine) {
      await session.useEngine(engineSelect.value);
      settings.engine = engineSelect.value;
      enginePanel.setEngine(
        ENGINE_PROFILES[engineSelect.value].name,
        ENGINE_PROFILES[engineSelect.value].strength,
      );
    }
    session.setDifficulty(settings.difficulty);
    session.setTimeControl(settings.timeControl);
    await startNewGame({ color: colorSelect.value });
  }

  async function showSettings() {
    const themeSelect = el(
      'select.select',
      {},
      options(
        Object.values(THEMES).map((theme) => [theme.id, theme.name]),
        settings.theme,
      ),
    );
    const pieceSelect = el(
      'select.select',
      {},
      options(
        Object.values(PIECE_SETS).map((set) => [set.id, set.name]),
        settings.pieceSet,
      ),
    );
    const cameraSelect = el(
      'select.select',
      {},
      options(
        Object.values(CAMERA_MODES).map((mode) => [mode.id, mode.name]),
        settings.cameraMode,
      ),
    );
    const uiThemeSelect = el(
      'select.select',
      {},
      options(
        [
          ['system', 'Match the system'],
          ['dark', 'Dark'],
          ['light', 'Light'],
        ],
        settings.uiTheme,
      ),
    );

    const toggle = (label, checked, onChange) => {
      const input = el('input', {
        type: 'checkbox',
        checked,
        on: { change: (e) => onChange(e.target.checked) },
      });
      return el('label.switch', {}, [label, input]);
    };
    const volume = el('input.range', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(settings.soundVolume),
      on: {
        input: (e) => {
          settings.soundVolume = Number(e.target.value);
          sound.setVolume(settings.soundVolume);
        },
      },
    });

    themeSelect.addEventListener('change', () => {
      settings.theme = themeSelect.value;
      applyBoardTheme();
    });
    pieceSelect.addEventListener('change', () => {
      settings.pieceSet = pieceSelect.value;
      board.setPieceSet(settings.pieceSet);
    });
    cameraSelect.addEventListener('change', () => {
      settings.cameraMode = cameraSelect.value;
      board.setCameraMode(settings.cameraMode);
    });
    uiThemeSelect.addEventListener('change', () => {
      settings.uiTheme = uiThemeSelect.value;
      applyInterfaceTheme(settings);
    });

    function applyBoardTheme() {
      const theme = getTheme(settings.theme);
      board.setTheme(
        settings.highContrast ? { ...theme, highlights: ACCESSIBLE_HIGHLIGHTS } : theme,
      );
    }

    await showDialog({
      title: 'Settings',
      body: [
        field('Board theme', themeSelect),
        field('Piece set', pieceSelect),
        field('Camera', cameraSelect),
        field('Interface', uiThemeSelect),
        toggle('Sound', settings.soundEnabled, (on) => {
          settings.soundEnabled = on;
          sound.setEnabled(on);
        }),
        el('div.field', {}, [el('span.field__label', { text: 'Volume' }), volume]),
        toggle('Show legal moves', settings.showLegalMoves, (on) => {
          settings.showLegalMoves = on;
          board.setHighlights(highlightState());
        }),
        toggle('Board coordinates', settings.showCoordinates, (on) => {
          settings.showCoordinates = on;
          if (board.board.notation) board.board.notation.visible = on;
        }),
        toggle('High-contrast highlights', settings.highContrast, (on) => {
          settings.highContrast = on;
          applyBoardTheme();
        }),
        toggle('Reduce motion', settings.reducedMotion, (on) => {
          settings.reducedMotion = on;
          board.setReducedMotion(on);
        }),
        toggle('Vibration on mobile', settings.haptics, (on) => {
          settings.haptics = on;
        }),
      ],
      actions: [{ label: 'Done', value: 'done', variant: 'primary', autofocus: true }],
    });
    store.saveSettings(settings);
  }

  function showShortcutHelp() {
    return showDialog({
      title: 'Keyboard',
      subtitle: 'The whole game is playable without a pointer.',
      body: el(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: 'var(--space-2) var(--space-4)',
            fontSize: 'var(--text-sm)',
          },
        },
        SHORTCUTS.flatMap(([keys, description]) => [
          el('kbd', {
            text: keys,
            style: { fontFamily: 'var(--font-mono)', color: 'var(--text-1)' },
          }),
          el('span', { text: description, style: { color: 'var(--text-2)' } }),
        ]),
      ),
      actions: [{ label: 'Close', value: 'close', variant: 'primary', autofocus: true }],
    });
  }

  // ------------------------------------------------------------------ boot
  await session.useEngine(settings.engine);
  enginePanel.setEngine(
    ENGINE_PROFILES[settings.engine].name,
    ENGINE_PROFILES[settings.engine].strength,
  );
  session.setDifficulty(settings.difficulty);
  session.setTimeControl(settings.timeControl);

  const saved = store.loadCurrentGame();
  if (saved) {
    try {
      session.loadState(saved.state, {
        mode: saved.mode ?? 'engine',
        playerColor: saved.playerColor ?? 'w',
      });
      board.orientation(session.playerColor === 'w' ? 'white' : 'black');
      evalBar.setOrientation(session.playerColor === 'w' ? 'white' : 'black');
      toaster.show('Picked up where you left off.');
    } catch {
      // A blob from an older version, or a tree that no longer parses. Losing
      // one unfinished game is better than refusing to start.
      store.clearCurrentGame();
    }
  }

  board.on('ready', () => {
    syncBoard({ animate: false });
    board.setCameraMode(settings.cameraMode);
  });
  syncBoard({ animate: false });
  session.clock.update();

  // Browsers require a gesture before audio can start.
  document.addEventListener('pointerdown', () => sound.resume(), { once: true });
  window.addEventListener('beforeunload', persist);

  return { session, board, sound, keyboard, settings, actions };
}

// ------------------------------------------------------------------ helpers

function field(label, control) {
  return el('div.field', {}, [el('span.field__label', { text: label }), control]);
}

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
  ]);
}

function applyInterfaceTheme(settings) {
  const root = document.documentElement;
  if (settings.uiTheme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = settings.uiTheme;
  root.dataset.contrast = settings.highContrast ? 'high' : 'normal';
}

function buildTopBar() {
  return el('header.topbar', {}, [
    el('h1.topbar__brand', {}, ['chessboard3', el('span', { text: 'three.js chess' })]),
    el('div.topbar__spacer'),
  ]);
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
