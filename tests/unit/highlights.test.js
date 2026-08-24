import { describe, expect, it } from 'vitest';
import { Session } from '../../src/app/session.js';
import { highlightState } from '../../src/app/highlights.js';

/**
 * The board's highlight state is the contract between the app and both
 * renderers. It lived inside the bootstrap closure, so asserting on it meant
 * booting a browser, a WebGL context and two engine workers; extracting it
 * makes the decisions testable in milliseconds.
 */
const make = (settings = {}) =>
  new Session({
    settings: {
      playerColor: 'w',
      timeControl: 'unlimited',
      difficulty: 5,
      showLegalMoves: true,
      coachHints: false,
      ...settings,
    },
  });

describe('highlight state', () => {
  it('marks nothing on a fresh board', () => {
    const session = make();
    const state = highlightState({ session, settings: session.settings });
    expect(state.lastMove).toBeNull();
    expect(state.check).toBeNull();
    expect(state.selected).toBeNull();
    expect(state.legal).toEqual([]);
    expect(state.threatened).toEqual([]);
  });

  it('marks the move just played', () => {
    const session = make();
    session.state.move('e4');
    const state = highlightState({ session, settings: session.settings });
    expect(state.lastMove).toEqual({ from: 'e2', to: 'e4' });
  });

  it('finds the king when it is in check, not the square that gave check', () => {
    const session = make();
    for (const san of ['f3', 'e5', 'g4', 'Qh4#']) session.state.move(san);
    const state = highlightState({ session, settings: session.settings });
    expect(state.check).toBe('e1');
  });

  it('lists the legal moves for a selected piece, flagging captures', () => {
    const session = make();
    for (const san of ['e4', 'd5']) session.state.move(san);
    const state = highlightState({
      session,
      settings: session.settings,
      selected: 'e4',
    });
    const capture = state.legal.find((move) => move.to === 'd5');
    expect(capture).toEqual({ to: 'd5', capture: true });
    expect(state.legal.find((move) => move.to === 'e5')).toEqual({
      to: 'e5',
      capture: false,
    });
  });

  it('offers no legal moves when the player has turned them off', () => {
    const session = make({ showLegalMoves: false });
    const state = highlightState({
      session,
      settings: session.settings,
      selected: 'e2',
    });
    // Still selected — only the legal-move overlay is suppressed.
    expect(state.selected).toBe('e2');
    expect(state.legal).toEqual([]);
  });

  it('carries the keyboard cursor separately from the selection', () => {
    const session = make();
    const state = highlightState({
      session,
      settings: session.settings,
      selected: 'e2',
      cursorSquare: 'd4',
    });
    expect(state.selected).toBe('e2');
    expect(state.hover).toBe('d4');
  });

  it('passes the hint through as a move, not a square', () => {
    const session = make();
    const state = highlightState({
      session,
      settings: session.settings,
      hintMove: { from: 'g1', to: 'f3', promotion: undefined },
    });
    expect(state.hint).toEqual({ from: 'g1', to: 'f3' });
  });
});

describe('the coach overlay', () => {
  // 1. e4 d5 2. exd5 Qxd5 3. Nc3 — the queen is attacked and undefended.
  const QUEEN_EN_PRISE = ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3'];

  it('stays dark unless the player asked for it', () => {
    const session = make({ coachHints: false });
    for (const san of QUEEN_EN_PRISE) session.state.move(san);
    expect(highlightState({ session, settings: session.settings }).threatened).toEqual([]);
  });

  it('marks a piece that is simply hanging', () => {
    const session = make({ coachHints: true });
    for (const san of QUEEN_EN_PRISE) session.state.move(san);
    const { threatened } = highlightState({ session, settings: session.settings });
    expect(threatened).toContain('d5');
    // Never a heat map: the overlay stops being read if it lights up the board.
    expect(threatened.length).toBeLessThanOrEqual(3);
  });

  it('ignores a piece that is defended, however loudly it is attacked', () => {
    const session = make({ coachHints: true });
    // The Fried Liver setup: f7 is attacked twice but the king defends it, so
    // taking it loses a knight for a pawn. That is not "hanging".
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5']) session.state.move(san);
    expect(highlightState({ session, settings: session.settings }).threatened).toEqual([]);
  });

  it('goes quiet once the game is over', () => {
    const session = make({ coachHints: true });
    for (const san of ['f3', 'e5', 'g4', 'Qh4#']) session.state.move(san);
    expect(highlightState({ session, settings: session.settings }).threatened).toEqual([]);
  });
});
