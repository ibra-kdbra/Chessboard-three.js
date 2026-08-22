/**
 * Every modal the game puts up.
 *
 * Extracted from the wiring layer, which had grown past 1200 lines with twenty
 * nested closures in it. These still close over the session and the renderer —
 * a dialog that changes the engine has to be able to change the engine — but
 * they take that as an explicit context rather than reaching into an enclosing
 * scope, so what each one touches is visible at the top of the file.
 */
import { DIFFICULTY_LEVELS } from '../engine/opponent.js';
import { ENGINE_PROFILES } from '../engine/engineProfiles.js';
import { TIME_CONTROLS } from '../core/clock.js';
import { THEMES } from '../render/three/themes.js';
import { PIECE_SETS } from '../render/three/pieces.js';
import { PIECE_IMAGE_SETS } from '../render/two/board2d.js';
import { CAMERA_MODES } from '../render/three/board3d.js';
import { SHORTCUTS } from './keyboard.js';
import * as store from './persistence.js';
import { buildShareUrl, copyText, downloadText, suggestFilename } from './share.js';
import { el, options } from '../ui/dom.js';
import { showDialog } from '../ui/dialog.js';

/** A labelled form row. */
function field(label, control) {
  return el('div.field', {}, [el('span.field__label', { text: label }), control]);
}

/**
 * Builds the dialog set for one running app.
 *
 * @param {{ session, board: () => object, settings: object, toaster, sound,
 *           analyser, enginePanel, evalBar, syncBoard: Function,
 *           startNewGame: Function, setDimensions: Function,
 *           themeFor: Function, highlightState: Function,
 *           renderStatus: Function, moveList }} context
 */
export function createDialogs(context) {
  const {
    session,
    settings,
    toaster,
    sound,
    analyser,
    enginePanel,
    syncBoard,
    startNewGame,
    adoptGame,
    applyInterfaceTheme,
    clearLiveEvaluation,
    setDimensions,
    themeFor,
    highlightState,
    renderStatus,
  } = context;
  /** The mounted renderer changes when dimensions are switched. */
  const board = () => context.board();

  // ------------------------------------------------ resign, draw, transfer

  async function confirmResign() {
    if (session.state.isFinished) return;
    const answer = await showDialog({
      title: 'Resign?',
      subtitle: 'The game is recorded as a loss.',
      actions: [
        { label: 'Keep playing', value: null, autofocus: true },
        { label: 'Resign', value: 'resign', variant: 'danger' },
      ],
    });
    // Not onGameOver(...) — adjudicate emits `gameover`, which already runs it.
    if (answer === 'resign') session.resign();
  }

  async function offerDraw() {
    if (session.state.isFinished) return;
    if (session.mode !== 'engine') {
      const answer = await showDialog({
        title: 'Offer a draw?',
        subtitle: 'Both players must agree.',
        actions: [
          { label: 'Cancel', value: null },
          { label: 'Agree a draw', value: 'draw', variant: 'primary', autofocus: true },
        ],
      });
      if (answer === 'draw') session.agreeDraw();
      return;
    }
    // Against the engine, a draw offer is answered by the position rather than
    // by negotiation: it accepts only when it is not better off playing on.
    const evaluation = session.state.node.evaluation;
    const enginePov = evaluation ? (session.playerColor === 'w' ? -1 : 1) * evaluation.value : 0;
    const accepted = evaluation ? enginePov < 40 : false;
    if (accepted) {
      toaster.show('Draw accepted.');
      session.agreeDraw();
    } else {
      toaster.show('Draw declined — play on.');
    }
  }

  async function exportGame() {
    const pgn = session.state.pgn();
    const opening = session.status().opening?.name;
    const answer = await showDialog({
      title: 'Export',
      subtitle: 'PGN keeps your variations, comments and evaluations.',
      body: el('textarea.select', {
        readonly: true,
        rows: 8,
        value: pgn,
        style: { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', resize: 'vertical' },
      }),
      actions: [
        { label: 'Close', value: null },
        { label: 'Download', value: 'download' },
        { label: 'Copy PGN', value: 'copy', variant: 'primary', autofocus: true },
      ],
    });
    if (answer === 'copy') {
      toaster.show((await copyText(pgn)) ? 'PGN copied.' : 'Could not reach the clipboard.');
    } else if (answer === 'download') {
      downloadText(suggestFilename(opening), pgn);
    }
  }

  async function shareGame() {
    const url = session.state.ply
      ? buildShareUrl({ pgn: session.state.pgn() })
      : buildShareUrl({ fen: session.state.fen });
    const answer = await showDialog({
      title: 'Share',
      subtitle: 'The whole game travels in the link. Nothing is uploaded.',
      body: el('input.select', {
        readonly: true,
        value: url,
        style: { fontSize: 'var(--text-xs)' },
      }),
      actions: [
        { label: 'Close', value: null },
        { label: 'Copy link', value: 'copy', variant: 'primary', autofocus: true },
      ],
    });
    if (answer === 'copy') {
      toaster.show((await copyText(url)) ? 'Link copied.' : 'Could not reach the clipboard.');
    }
  }

  /** The library of finished games, newest first. */
  async function showLibrary() {
    const finished = new AbortController();
    const games = store.loadLibrary();
    if (!games.length) {
      toaster.show('No finished games saved yet.');
      return;
    }

    const list = el('div', {
      style: { display: 'grid', gap: 'var(--space-1)', maxHeight: '22rem', overflowY: 'auto' },
    });
    let chosen = null;
    for (const game of games) {
      const when = new Date(game.savedAt).toLocaleDateString();
      list.append(
        el(
          'button.button',
          {
            type: 'button',
            style: { justifyContent: 'space-between', textAlign: 'left', width: '100%' },
            on: {
              click: () => {
                chosen = game;
                // Closing the <dialog> directly settles nothing; the controller
                // is what resolves the promise this function is awaiting.
                finished.abort();
              },
            },
          },
          [
            el('span', { text: game.opening ?? 'Unnamed opening' }),
            el('span', {
              text: `${game.result}  ·  ${when}`,
              style: { color: 'var(--text-3)', fontSize: 'var(--text-xs)' },
            }),
          ],
        ),
      );
    }

    const answer = showDialog({
      title: 'Saved games',
      subtitle: `${games.length} finished ${games.length === 1 ? 'game' : 'games'}, newest first.`,
      body: list,
      actions: [{ label: 'Close', value: null }],
      closeSignal: finished.signal,
    });
    await answer;

    if (chosen?.pgn) {
      const loaded = await applyImport(chosen.pgn);
      if (loaded) {
        session.state.toEnd();
        syncBoard({ animate: false });
      }
    }
  }

  async function importGame() {
    const input = el('textarea.select', {
      rows: 7,
      placeholder: 'Paste a PGN game, or a FEN position…',
      style: { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', resize: 'vertical' },
    });
    const answer = await showDialog({
      title: 'Import',
      subtitle: 'A PGN game or a single FEN position.',
      body: input,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Load', value: 'load', variant: 'primary' },
      ],
    });
    if (answer !== 'load') return;
    const applied = await applyImport(input.value.trim());
    if (!applied) toaster.error('That is not a PGN game or a FEN position.');
  }

  /** Loads pasted or shared text, whichever kind it turns out to be. */
  async function applyImport(text) {
    if (!text) return false;
    await session.cancelThinking();
    try {
      if (text.includes('[') || /\d+\s*\./.test(text)) {
        session.loadPgn(text);
      } else {
        session.loadState({
          version: 1,
          startFen: text,
          tree: { version: 1, startFen: text, headers: {}, children: [] },
        });
      }
    } catch {
      return false;
    }
    session.setMode('analysis');
    adoptGame({ facing: 'white' });
    toaster.success('Loaded. You are in analysis mode — play either side.');
    return true;
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
    // The piece-set options and the Camera row are built for whichever renderer
    // is mounted right now. Switching Board swaps it underneath us, so close
    // and reopen against the new one rather than leaving stale controls that
    // throw when used.
    const swap = new AbortController();
    let swapped = false;
    const themeSelect = el(
      'select.select',
      {},
      options(
        Object.values(THEMES).map((theme) => [theme.id, theme.name]),
        settings.theme,
      ),
    );
    // The two renderers have different piece sets — 3D models versus sprite
    // sheets — so the picker follows whichever board is mounted.
    const in3d = settings.dimensions === 3;
    const pieceSelect = el(
      'select.select',
      {},
      options(
        in3d
          ? Object.values(PIECE_SETS).map((set) => [set.id, set.name])
          : Object.values(PIECE_IMAGE_SETS).map((set) => [set.id, set.name]),
        in3d ? settings.pieceSet : settings.pieceSet2d,
      ),
    );
    const dimensionSelect = el(
      'select.select',
      {},
      options(
        [
          ['3', '3D board'],
          ['2', '2D board'],
        ],
        String(settings.dimensions),
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
      if (settings.dimensions === 3) settings.pieceSet = pieceSelect.value;
      else settings.pieceSet2d = pieceSelect.value;
      board().setPieceSet(pieceSelect.value);
    });
    dimensionSelect.addEventListener('change', async () => {
      await setDimensions(Number(dimensionSelect.value));
      swapped = true;
      swap.abort();
    });
    cameraSelect.addEventListener('change', () => {
      settings.cameraMode = cameraSelect.value;
      board().setCameraMode(settings.cameraMode);
    });
    uiThemeSelect.addEventListener('change', () => {
      settings.uiTheme = uiThemeSelect.value;
      applyInterfaceTheme(settings);
    });

    function applyBoardTheme() {
      board().setTheme(themeFor());
    }

    await showDialog({
      title: 'Settings',
      closeSignal: swap.signal,
      body: [
        field('Board', dimensionSelect),
        field('Board theme', themeSelect),
        field('Piece set', pieceSelect),
        settings.dimensions === 3 ? field('Camera', cameraSelect) : null,
        field('Interface', uiThemeSelect),
        toggle('Sound', settings.soundEnabled, (on) => {
          settings.soundEnabled = on;
          sound.setEnabled(on);
        }),
        el('div.field', {}, [el('span.field__label', { text: 'Volume' }), volume]),
        toggle('Show legal moves', settings.showLegalMoves, (on) => {
          settings.showLegalMoves = on;
          board().setHighlights(highlightState());
        }),
        toggle('Board coordinates', settings.showCoordinates, (on) => {
          settings.showCoordinates = on;
          // Through the contract both renderers implement: reaching into the
          // 3D scene graph threw on the 2D board, and skipped the config the
          // 3D board rereads whenever the theme rebuilds it.
          board().setShowNotation(on);
        }),
        toggle('High-contrast highlights', settings.highContrast, (on) => {
          settings.highContrast = on;
          applyBoardTheme();
        }),
        toggle('Reduce motion', settings.reducedMotion, (on) => {
          settings.reducedMotion = on;
          board().setReducedMotion(on);
        }),
        toggle('Vibration on mobile', settings.haptics, (on) => {
          settings.haptics = on;
        }),
        toggle('Warn about pieces I can lose', settings.coachHints, (on) => {
          settings.coachHints = on;
          board().setHighlights(highlightState());
        }),
        toggle('Live evaluation bar', settings.liveAnalysis, async (on) => {
          settings.liveAnalysis = on;
          if (on) {
            await analyser.start().catch(() => {});
            analyser.setEnabled(true);
            analyser.analyse(session.state.fen, { turn: session.state.turn });
          } else {
            analyser.setEnabled(false);
            clearLiveEvaluation();
            renderStatus();
          }
        }),
      ],
      actions: [{ label: 'Done', value: 'done', variant: 'primary', autofocus: true }],
    });
    store.saveSettings(settings);
    // Reopened rather than recursed into blindly: the new body reads the
    // settings just saved, so the Board select shows what is actually mounted.
    if (swapped) return showSettings();
    return undefined;
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

  return {
    confirmResign,
    offerDraw,
    exportGame,
    shareGame,
    showLibrary,
    importGame,
    applyImport,
    showNewGameDialog,
    showSettings,
    showShortcutHelp,
  };
}
