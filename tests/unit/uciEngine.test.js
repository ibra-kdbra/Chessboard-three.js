import { describe, expect, it, vi } from 'vitest';
import { parseBestMove, parseInfo, parseUciMove, UciEngine } from '../../src/engine/uciEngine.js';
import { budgetFor, ENGINE_PROFILES, getEngineProfile } from '../../src/engine/engineProfiles.js';

describe('UCI parsing', () => {
  it('reads a full info line', () => {
    expect(
      parseInfo(
        'info depth 12 seldepth 18 multipv 1 score cp -37 nodes 123456 nps 900000 time 137 pv e2e4 e7e5',
      ),
    ).toEqual({
      depth: 12,
      seldepth: 18,
      multipv: 1,
      score: { type: 'cp', value: -37 },
      nodes: 123456,
      nps: 900000,
      time: 137,
      pv: ['e2e4', 'e7e5'],
    });
  });

  it('reads mate scores and bounds', () => {
    expect(parseInfo('info depth 5 score mate -3 pv d1h5').score).toEqual({
      type: 'mate',
      value: -3,
    });
    expect(parseInfo('info depth 5 score cp 20 lowerbound').score.bound).toBe('lowerbound');
  });

  it('keeps an info string intact', () => {
    expect(parseInfo('info string Lozza build 3 is alive')).toEqual({
      string: 'Lozza build 3 is alive',
    });
  });

  it('ignores anything that is not an info line', () => {
    expect(parseInfo('bestmove e2e4')).toBeNull();
    expect(parseInfo('uciok')).toBeNull();
  });

  it('reads bestmove, ponder and the no-move case', () => {
    expect(parseBestMove('bestmove e7e8q ponder a1a2')).toEqual({
      bestmove: 'e7e8q',
      ponder: 'a1a2',
    });
    expect(parseBestMove('bestmove (none)')).toEqual({ bestmove: null, ponder: null });
    expect(parseBestMove('info depth 1')).toBeNull();
  });

  it('splits a coordinate move, promotion included', () => {
    expect(parseUciMove('e7e8q')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
    expect(parseUciMove('e2e4')).toEqual({ from: 'e2', to: 'e4', promotion: undefined });
    expect(parseUciMove('bad')).toBeNull();
  });
});

describe('engine profiles', () => {
  it('sends p4wn a ply budget, since it discards every other limit', () => {
    expect(budgetFor(ENGINE_PROFILES.p4wn, { movetime: 1000 })).toEqual({ depth: 6 });
    expect(budgetFor(ENGINE_PROFILES.p4wn, { movetime: 200 }).depth).toBeLessThanOrEqual(6);
  });

  it('never asks any engine to search with no limit at all', () => {
    for (const profile of Object.values(ENGINE_PROFILES)) {
      const budget = budgetFor(profile, {});
      expect(Object.keys(budget).length).toBeGreaterThan(0);
    }
  });

  it('caps depth at what each engine can stand', () => {
    expect(budgetFor(ENGINE_PROFILES.p4wn, { depth: 40 }).depth).toBe(
      ENGINE_PROFILES.p4wn.maxDepth,
    );
    expect(budgetFor(ENGINE_PROFILES.lozza, { movetime: 500, depth: 99 }).depth).toBe(
      ENGINE_PROFILES.lozza.maxDepth,
    );
  });

  it('falls back to a real profile for an unknown id', () => {
    expect(getEngineProfile('nope').id).toBe('lozza');
  });
});

/** A stand-in Worker that replays a scripted transcript. */
function scriptedWorker(script) {
  return class {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      this.sent = [];
    }
    postMessage(command) {
      this.sent.push(command);
      const replies = script[command.split(' ')[0]] ?? script[command] ?? [];
      queueMicrotask(() => {
        for (const line of replies) this.onmessage?.({ data: line });
      });
    }
    terminate() {
      this.terminated = true;
    }
  };
}

describe('UciEngine', () => {
  it('normalises the quirks each profile declares', async () => {
    const Worker = scriptedWorker({
      uci: ['id name Fake', 'option name MultiPV type spin default 1 min 1 max 500', 'uciok'],
      isready: ['readyok'],
      ucinewgame: [],
      position: [],
      // Lozza's dialect: SAN pv, mate-in-1 reported as `mate 0`, stray '#'.
      go: ['info depth 4 score mate 0 pv Qh5 #', 'bestmove d1h5'],
    });
    const engine = new UciEngine({ profile: 'lozza', workerFactory: () => new Worker() });
    await engine.start();
    const result = await engine.search('8/8/8/8/8/8/8/K6k w - - 0 1', { movetime: 100 });

    expect(result.bestmove).toBe('d1h5');
    expect(result.info.score).toEqual({ type: 'mate', value: 1 });
    expect(result.lines[0].pv).toEqual(['Qh5']);
    expect(result.lines[0].pvFormat).toBe('san');
  });

  it('keeps an evaluation that arrives after bestmove', async () => {
    const Worker = scriptedWorker({
      uci: ['uciok'],
      isready: ['readyok'],
      ucinewgame: [],
      position: [],
      // p4wn's order, and its 20-per-pawn scale.
      go: ['bestmove e2e4', 'info depth 4 score cp 20'],
    });
    const engine = new UciEngine({ profile: 'p4wn', workerFactory: () => new Worker() });
    await engine.start();
    const result = await engine.search('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
      depth: 4,
    });

    expect(result.bestmove).toBe('e2e4');
    expect(result.info?.score).toEqual({ type: 'cp', value: 100 });
  });

  it('sends ucinewgame before the first position where the profile demands it', async () => {
    const workers = [];
    const Worker = scriptedWorker({
      uci: ['uciok'],
      isready: ['readyok'],
      ucinewgame: [],
      position: [],
      go: ['bestmove e2e4'],
    });
    const engine = new UciEngine({
      profile: 'p4wn',
      workerFactory: () => {
        const worker = new Worker();
        workers.push(worker);
        return worker;
      },
    });
    await engine.start();

    const sent = workers[0].sent;
    expect(sent.indexOf('ucinewgame')).toBeGreaterThan(-1);
    expect(sent.indexOf('ucinewgame')).toBeLessThan(
      sent.findIndex((command) => command.startsWith('position')) === -1
        ? Infinity
        : sent.findIndex((command) => command.startsWith('position')),
    );
  });

  it('ignores a malformed option line rather than recording a garbage entry', async () => {
    const Worker = scriptedWorker({
      // Lozza replies with the bare word `option`.
      uci: ['id name Lozza', 'option', 'uciok'],
      isready: ['readyok'],
    });
    const engine = new UciEngine({ profile: 'lozza', workerFactory: () => new Worker() });
    await engine.start();

    expect([...engine.options.keys()]).toEqual([]);
    expect(engine.capabilities.multiPv).toBe(false);
  });

  it('reports that no bundled engine can be interrupted', async () => {
    const Worker = scriptedWorker({ uci: ['uciok'], isready: ['readyok'] });
    const engine = new UciEngine({ profile: 'stockfish', workerFactory: () => new Worker() });
    await engine.start();

    expect(engine.capabilities.stop).toBe(false);
    expect(engine.capabilities.cancelByTerminate).toBe(true);
  });

  it('cancels by discarding the worker, then starts a fresh one', async () => {
    const workers = [];
    const Worker = scriptedWorker({ uci: ['uciok'], isready: ['readyok'], position: [], go: [] });
    const engine = new UciEngine({
      profile: 'lozza',
      workerFactory: () => {
        const worker = new Worker();
        workers.push(worker);
        return worker;
      },
    });
    await engine.start();

    const pending = engine.search('8/8/8/8/8/8/8/K6k w - - 0 1', { movetime: 5000 });
    const outcome = pending.then(() => 'resolved').catch((error) => error.message);
    await engine.cancel();

    expect(await outcome).toContain('cancelled');
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
  });

  it('gives up on an engine that never answers', async () => {
    vi.useFakeTimers();
    try {
      const Worker = scriptedWorker({ uci: ['uciok'], isready: ['readyok'], position: [], go: [] });
      const engine = new UciEngine({ profile: 'lozza', workerFactory: () => new Worker() });
      const started = engine.start();
      await vi.advanceTimersByTimeAsync(1);
      await started;

      const search = engine.search('8/8/8/8/8/8/8/K6k w - - 0 1', { movetime: 100 });
      const outcome = search.then(() => 'resolved').catch((error) => error.message);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await outcome).toMatch(/did not answer/);
    } finally {
      vi.useRealTimers();
    }
  });
});
