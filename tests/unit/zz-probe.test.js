import { describe, expect, it } from 'vitest';
import { Session } from '../../src/app/session.js';

const mk = (settings = {}) =>
  new Session({ settings: { playerColor: 'w', timeControl: 'unlimited', difficulty: 5, ...settings } });

/** An opponent whose search we can release by hand. */
function gatedOpponent(session, sans) {
  let release;
  session.opponent = {
    async chooseMove({ signal }) {
      await new Promise((r) => (release = r));
      if (signal?.aborted) return { source: 'aborted', move: null, san: null, elapsedMs: 0 };
      return { source: 'engine', san: sans.shift(), move: null, evaluation: null, elapsedMs: 1 };
    },
  };
  return () => release();
}

describe('PROBE navigating while the engine thinks', () => {
  it('drops the engine reply into the position being reviewed', async () => {
    const s = mk();
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']) s.state.move(san);
    s.state.toEnd();
    expect(s.state.ply).toBe(5);

    const go = gatedOpponent(s, ['a6']);
    // Black (the engine) to move at the tip; start its search.
    s.playerColor = 'w';
    const search = s.maybePlayEngineMove();
    expect(s.thinking).toBe(true);

    // The player steps back through the game while it thinks — Left arrow, or
    // a click in the move list.
    s.back();
    s.back();
    expect(s.state.isReviewing).toBe(true);
    const reviewedNode = s.state.node.id;

    go();
    await search;

    const line = s.state.tree.currentLine().map((n) => n.move.san);
    console.log('line after the engine answered:', line.join(' '), 'ply=', s.state.ply);
    console.log('mainline is still:', s.state.tree.mainline().map((n) => n.move.san).join(' '));
    console.log('reviewed node had id', reviewedNode, '-> now at', s.state.node.id);
    // The reply belonged 2 plies later; it was played here instead.
    expect(line.join(' ')).not.toBe('e4 e5 Nf3 Nc6 Bb5 a6');
  });
});

describe('PROBE restoring a game where the engine is on move', () => {
  it('never asks the engine, so the board is dead', async () => {
    const live = mk();
    gatedOpponent(live, []);
    live.state.move('e4'); // player white has moved; engine has not replied yet
    const blob = live.toJSON();

    const fresh = mk();
    gatedOpponent(fresh, ['e5']);
    fresh.loadState(blob.state, { mode: blob.mode, playerColor: blob.playerColor });
    await new Promise((r) => setTimeout(r, 50));
    console.log('restored: ply=', fresh.state.ply, 'turn=', fresh.state.turn,
      'isPlayerTurn=', fresh.isPlayerTurn, 'thinking=', fresh.thinking);
    expect(fresh.state.turn).toBe('b');
    expect(fresh.isPlayerTurn).toBe(false);
    expect(fresh.thinking).toBe(false); // nobody asked
    const played = await fresh.play({ from: 'd2', to: 'd4' });
    expect(played).toBeNull(); // and the human cannot move either
    expect(fresh.state.ply).toBe(1);
  });
});

describe('PROBE the saved clock is never restored', () => {
  it('resumes a timed game with the full initial time', () => {
    const live = mk({ timeControl: 'blitz-3+0' });
    live.startClock();
    const base = live.clock.now();
    live.clock.now = () => base + 100_000;
    live.state.move('e4');
    const blob = live.toJSON();
    const fresh = mk({ timeControl: 'blitz-3+0' });
    fresh.loadState(blob.state, { mode: blob.mode, playerColor: blob.playerColor });
    console.log('saved:', JSON.stringify(blob.clock.remaining),
      ' restored:', JSON.stringify({ w: fresh.clock.timeLeft('w'), b: fresh.clock.timeLeft('b') }));
    expect(fresh.clock.timeLeft('w')).toBe(180_000);
  });
});

describe('PROBE typed move during a hint', () => {
  it('applies after an await, so the keyboard layer calls it illegal', async () => {
    const s = mk();
    let releaseHint;
    s.engine = { search: () => new Promise((r) => (releaseHint = () => r({ bestmove: 'e2e4', info: null }))) };
    const hint = s.hint();
    s.engine.cancel = async () => { releaseHint(); return null; };

    const before = s.state.ply;
    const promise = s.play('e4'); // exactly what main.js onTyped does
    const plySeenByOnTyped = s.state.ply;
    const accepted = plySeenByOnTyped !== before;
    console.log('onTyped saw ply', plySeenByOnTyped, '-> accepted =', accepted);
    await promise;
    await hint;
    console.log('but the move did land: ply=', s.state.ply,
      'line=', s.state.tree.currentLine().map((n) => n.move.san).join(' '));
    expect(accepted).toBe(false);   // announced "e4 is not a legal move"
    expect(s.state.ply).toBe(1);    // yet it was played
  });
});
