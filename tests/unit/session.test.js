import { describe, expect, it, vi } from 'vitest';
import { Session } from '../../src/app/session.js';

/**
 * Session drives the game but touches no DOM, so it is testable in node — with
 * one exception: it constructs a UciEngine only when `useEngine` is called, so
 * these tests exercise everything up to that point without a Worker.
 */
const makeSession = (settings = {}) =>
  new Session({
    settings: { playerColor: 'w', timeControl: 'unlimited', difficulty: 5, ...settings },
  });

describe('Session takeback', () => {
  it('does nothing at the start of a game', async () => {
    const session = makeSession();
    await session.takeback();
    expect(session.state.ply).toBe(0);
  });

  it('undoes only one ply when the computer has not replied', async () => {
    const session = makeSession();
    session.state.move('e4');
    await session.takeback();
    // Undoing two here would take back a move the player never made.
    expect(session.state.ply).toBe(0);
  });

  it('undoes the reply and the move together once both exist', async () => {
    const session = makeSession();
    session.state.move('e4');
    session.state.move('e5');
    await session.takeback();
    expect(session.state.ply).toBe(0);
    expect(session.state.turn).toBe('w');
  });

  it('leaves the player on move in a longer game', async () => {
    const session = makeSession();
    for (const san of ['e4', 'e5', 'Nf3']) session.state.move(san);
    await session.takeback();
    expect(session.state.ply).toBe(2);
    expect(session.state.turn).toBe('w');
  });

  it('undoes a single ply in hotseat, where both sides are human', async () => {
    const session = makeSession();
    session.setMode('hotseat');
    for (const san of ['e4', 'e5']) session.state.move(san);
    await session.takeback();
    expect(session.state.ply).toBe(1);
  });
});

describe('Session state', () => {
  it('re-wires listeners when the game is replaced', () => {
    const session = makeSession();
    const onChange = vi.fn();
    session.on('change', onChange);

    session.loadPgn('[Event "x"]\n\n1. d4 d5 2. c4 *');
    session.state.move('e6');

    // A replaced state that kept the old listeners would go silent.
    expect(onChange).toHaveBeenCalled();
    expect(session.state.tree.mainline().map((n) => n.move.san)).toEqual(['d4', 'd5', 'c4', 'e6']);
  });

  it('an imported decisive game can still be played on', () => {
    const session = makeSession();
    session.loadPgn('[Event "x"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0');
    session.state.toEnd();
    // The Result tag records someone else's outcome; it must not freeze this
    // tree so that no move can be played anywhere in it.
    expect(session.state.isFinished).toBe(false);
    expect(session.state.move('Bb5')).not.toBeNull();
  });

  it('reports whose turn it is and what the opening is', () => {
    const session = makeSession();
    for (const san of ['e4', 'c5', 'Nf3', 'd6']) session.state.move(san);
    const status = session.status();
    expect(status.turn).toBe('w');
    expect(status.opening?.name).toMatch(/Sicilian/);
    expect(status.result.over).toBe(false);
  });

  it('finds the king for the check highlight', () => {
    const session = makeSession();
    expect(session.kingSquare('w')).toBe('e1');
    expect(session.kingSquare('b')).toBe('e8');
  });

  it('adjudicates a resignation', () => {
    const session = makeSession();
    session.state.move('e4');
    const result = session.resign();
    expect(result).toMatchObject({ over: true, winner: 'b', reason: 'resignation' });
    expect(session.state.isFinished).toBe(true);
  });
});

/** A controllable stand-in for the opponent, so tests need no Worker. */
function stubOpponent(session, sanQueue) {
  let release;
  session.opponent = {
    async chooseMove({ signal }) {
      await new Promise((resolve) => {
        release = resolve;
      });
      if (signal?.aborted) {
        return { source: 'aborted', move: null, san: null, elapsedMs: 0 };
      }
      return {
        source: 'engine',
        san: sanQueue.shift(),
        move: null,
        evaluation: null,
        elapsedMs: 1,
      };
    },
  };
  return () => release?.();
}

describe('Session turn handling', () => {
  it('starts the clock for the first move of a timed game', async () => {
    const session = makeSession({ timeControl: 'blitz-3+0' });
    session.setTimeControl('blitz-3+0');
    await session.newGame({ color: 'w' });
    // Pressing only after a move made move one free.
    expect(session.clock.running).toBe('w');
  });

  it('asks the computer again after taking back its opening move', async () => {
    const session = makeSession({ playerColor: 'b' });
    session.playerColor = 'b';
    const release = stubOpponent(session, ['e4', 'd4']);

    const opening = session.maybePlayEngineMove();
    release();
    await opening;
    expect(session.state.ply).toBe(1);

    const undone = session.takeback();
    // takeback re-asks; without that the board is dead — the computer is on
    // move and nothing prompts it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await undone;

    expect(session.state.ply).toBe(1);
    expect(session.state.turn).toBe('b');
    expect(session.isPlayerTurn).toBe(true);
  });

  it('abandons a hint rather than queueing the move made during it', async () => {
    const session = makeSession();
    let releaseHint;
    session.engine = {
      search: () =>
        new Promise((resolve) => {
          releaseHint = () => resolve({ bestmove: 'e2e4', info: null });
        }),
      cancel: async () => {
        releaseHint?.();
      },
    };

    const hint = session.hint();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.thinking).toBe(true);

    // The player has decided; the move must be played now, not stored and
    // fired later as a second move in a row.
    await session.play({ from: 'd2', to: 'd4' });
    await hint;

    expect(session.premove).toBeNull();
    expect(session.state.tree.mainline().map((n) => n.move.san)).toEqual(['d4']);
  });

  it('drops a premove when the search it was queued against never lands', async () => {
    const session = makeSession();
    const release = stubOpponent(session, ['e5']);
    session.playerColor = 'w';
    session.state.move('e4');

    const thinking = session.maybePlayEngineMove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.play({ from: 'd2', to: 'd4' });
    expect(session.premove).toEqual({ from: 'd2', to: 'd4' });

    session.pendingSearch?.abort();
    release();
    await thinking;

    // Playing it now would be a move out of turn.
    expect(session.premove).toBeNull();
    expect(session.state.ply).toBe(1);
  });
});
