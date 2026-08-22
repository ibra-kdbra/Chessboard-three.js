/**
 * A promise-shaped wrapper around a UCI engine running in a Web Worker.
 *
 * Two things shape this design, both measured rather than assumed:
 *
 * All three bundled engines run their search synchronously on the worker's own
 * event loop, so no message can reach them while they are thinking. `stop` is
 * therefore undeliverable and cancellation means terminating the worker. The
 * adapter does exactly that, and starts a fresh one, rather than pretending to
 * send a command that would sit unread in the queue.
 *
 * And each engine deviates from UCI in its own way — SAN principal variations,
 * off-by-one mate scores, `info` arriving after `bestmove`, centipawns on a
 * private scale. Those quirks are declared in engineProfiles.js and normalised
 * here, so callers see one consistent protocol.
 */
import { Chess } from 'chess.js';
import { Emitter } from '../core/emitter.js';
import { getEngineProfile, budgetFor } from './engineProfiles.js';

/** Parses one `info ...` line into a normalised object. */
export function parseInfo(line) {
  if (!line.startsWith('info')) return null;
  const tokens = line.split(/\s+/);
  const info = {};
  for (let i = 1; i < tokens.length; i++) {
    switch (tokens[i]) {
      case 'depth':
        info.depth = Number(tokens[++i]);
        break;
      case 'seldepth':
        info.seldepth = Number(tokens[++i]);
        break;
      case 'multipv':
        info.multipv = Number(tokens[++i]);
        break;
      case 'nodes':
        info.nodes = Number(tokens[++i]);
        break;
      case 'nps':
        info.nps = Number(tokens[++i]);
        break;
      case 'hashfull':
        info.hashfull = Number(tokens[++i]);
        break;
      case 'time':
        info.time = Number(tokens[++i]);
        break;
      case 'currmove':
        info.currmove = tokens[++i];
        break;
      case 'currmovenumber':
        info.currmovenumber = Number(tokens[++i]);
        break;
      case 'score': {
        const kind = tokens[++i];
        const value = Number(tokens[++i]);
        // UCI scores are from the side to move's point of view.
        info.score = { type: kind === 'mate' ? 'mate' : 'cp', value };
        if (tokens[i + 1] === 'lowerbound' || tokens[i + 1] === 'upperbound') {
          info.score.bound = tokens[++i];
        }
        break;
      }
      case 'pv':
        info.pv = tokens.slice(i + 1);
        i = tokens.length;
        break;
      case 'string':
        info.string = tokens.slice(i + 1).join(' ');
        i = tokens.length;
        break;
      default:
        break;
    }
  }
  return Object.keys(info).length ? info : null;
}

/** `bestmove e2e4 ponder e7e5` → `{ bestmove, ponder }`. */
export function parseBestMove(line) {
  const match = /^bestmove\s+(\S+)(?:\s+ponder\s+(\S+))?/.exec(line);
  if (!match) return null;
  const [, best, ponder] = match;
  return { bestmove: best === '(none)' ? null : best, ponder: ponder ?? null };
}

/** `e7e8q` → `{ from, to, promotion }`. */
export function parseUciMove(uci) {
  if (!uci || uci.length < 4) return null;
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4].toLowerCase() : undefined,
  };
}

const HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * How long to hold a finished search open for an engine that posts `info`
 * after `bestmove`. Only paid when such an engine sends no scored line at all;
 * the line itself settles the search the moment it arrives.
 */
const TRAILING_INFO_GRACE_MS = 250;

/** Releases both timers a search can be holding. */
function stopTimers(search) {
  clearTimeout(search.watchdog);
  clearTimeout(search.grace);
}

/**
 * Tidies an engine's SAN into the form a player reads.
 *
 * Lozza writes castling as `0-0` and disambiguates pawn captures with the full
 * origin square (`f2xe3`). Both are unambiguous but neither is what appears in
 * a book.
 */
function toStandardSan(token) {
  if (/^0-0-0$/i.test(token)) return 'O-O-O';
  if (/^0-0$/i.test(token)) return 'O-O';
  // A pawn capture only needs its origin FILE.
  return token.replace(/^([a-h])[1-8](x[a-h][1-8])/, '$1$2');
}

/** True when the position has no legal continuation. */
function isTerminal(fen) {
  try {
    return new Chess(fen).isGameOver();
  } catch {
    // An unparseable FEN is the caller's problem, not a reason to refuse.
    return false;
  }
}

/**
 * Events: `info` (normalised info line), `line` (raw), `ready`, `error`.
 */
export class UciEngine extends Emitter {
  /**
   * @param {{ profile?: string|object, url?: string, name?: string,
   *           workerFactory?: (url: string) => Worker }} options
   */
  constructor({ profile = 'lozza', url, name, workerFactory } = {}) {
    super();
    this.profile = typeof profile === 'string' ? getEngineProfile(profile) : profile;
    this.url = url ?? this.profile.url;
    this.name = name ?? this.profile.name;
    this.id = null;
    this.author = null;
    /** Declared UCI options, keyed by name. */
    this.options = new Map();
    this.state = 'idle';
    this.#workerFactory = workerFactory ?? ((source) => new Worker(source));
  }

  #workerFactory;
  #worker = null;
  #newGameSent = false;
  #disposed = false;
  /**
   * Options applied so far. Cancelling replaces the worker, and a fresh worker
   * knows nothing — without replaying these, a game set to a low Skill Level
   * silently jumped to full strength after the first takeback.
   */
  #appliedOptions = new Map();
  /** Serialises start/cancel so a search cannot slip in between them. */
  #gate = Promise.resolve();
  /** Resolvers waiting on a specific token (`uciok`, `readyok`). */
  #waiters = [];
  /** In-flight search, if any. */
  #search = null;

  get isSearching() {
    return this.#search !== null;
  }

  /**
   * What this engine can actually do. Declared options are probed at handshake,
   * but a declaration is not a promise — Stockfish 5 advertises `Threads` and
   * `Ponder` and can honour neither, so those are gated on what was measured.
   */
  get capabilities() {
    return {
      multiPv: this.options.has('MultiPV'),
      // UCI_Elo arrived in Stockfish 11; nothing bundled here has it.
      limitStrength: this.options.has('UCI_LimitStrength') && this.options.has('UCI_Elo'),
      skillLevel: this.options.has('Skill Level'),
      hash: this.options.has('Hash'),
      // The build has no pthreads; the option is inert, so never offer it.
      threads: false,
      // Pondering needs `stop`/`ponderhit` to reach a running search.
      ponder: false,
      // Cancellation is possible, but only by discarding the worker.
      stop: false,
      cancelByTerminate: true,
    };
  }

  /**
   * Boots the worker and completes the UCI handshake.
   *
   * Serialised through a gate: cancellation replaces the worker, and a search
   * arriving during that swap would otherwise talk to a worker that is about to
   * be terminated, and then wait forever for a reply that can never come.
   */
  async start() {
    this.#gate = this.#gate
      .then(() => this.#startOnce())
      .catch((error) => {
        // Keep the gate usable after a failure; the caller still sees the reject.
        throw error;
      });
    return this.#gate.then(() => this);
  }

  async #startOnce() {
    if (this.#disposed) throw new Error(`${this.name} has been disposed`);
    if (this.#worker) return;

    const worker = this.#workerFactory(this.url);
    worker.onmessage = (event) => this.#receive(String(event.data ?? ''));
    worker.onerror = (event) => {
      this.state = 'error';
      this.emit('error', event);
      this.#rejectAll(new Error(`engine worker failed: ${event.message ?? this.url}`));
    };

    this.state = 'starting';
    this.#worker = worker;
    try {
      this.#send('uci');
      await this.#await('uciok', HANDSHAKE_TIMEOUT_MS);
      await this.isReady();
    } catch (error) {
      // A half-booted worker must not be left in place: the next call would
      // find #worker set, skip the handshake, and report a readiness that
      // never happened.
      worker.terminate();
      if (this.#worker === worker) this.#worker = null;
      this.state = 'error';
      throw error;
    }

    // Replay whatever the caller had configured before the last swap.
    for (const [name, value] of this.#appliedOptions) {
      if (this.options.has(name)) this.#send(`setoption name ${name} value ${value}`);
    }
    // p4wn's internal state does not exist until ucinewgame has run; a
    // `position` before that throws inside the worker with no error reply.
    if (this.profile.newGameBeforePosition) {
      this.#send('ucinewgame');
      this.#newGameSent = true;
    }
    this.state = 'ready';
    this.emit('ready', this);
  }

  #send(command) {
    this.#worker?.postMessage(command);
  }

  #receive(text) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.emit('line', trimmed);

      if (trimmed.startsWith('id name')) this.id = trimmed.slice(8).trim();
      else if (trimmed.startsWith('id author')) this.author = trimmed.slice(10).trim();
      else if (trimmed.startsWith('option name')) this.#recordOption(trimmed);

      const info = this.#normaliseInfo(parseInfo(trimmed));
      if (info) {
        const search = this.#search;
        search?.onInfo?.(info);
        if (info.pv || info.score) search?.collect(info);
        this.emit('info', info);
        // The line this engine was being held open for has arrived.
        if (search?.pendingBest && search.lastInfo?.score) this.#settleSearch(search);
      }

      const best = parseBestMove(trimmed);
      if (best) this.#finishSearch(best);

      this.#resolveWaiters(trimmed);
    }
  }

  /**
   * Folds this engine's private conventions into standard UCI values, so
   * nothing downstream has to know which engine produced a line.
   */
  #normaliseInfo(info) {
    if (!info) return info;
    const profile = this.profile;

    if (info.score) {
      const score = { ...info.score };
      if (score.type === 'cp' && profile.cpScale !== 1) {
        score.value = Math.round(score.value * profile.cpScale);
      }
      // The sign alternates with search-depth parity, so odd depths report the
      // score from the opponent's point of view. Guarded explicitly: an info
      // line without a depth would otherwise compare NaN and silently skip the
      // correction, letting a wrong-signed score through unnoticed.
      if (score.type === 'cp' && profile.cpParityFlips) {
        if (typeof info.depth !== 'number') {
          // Nothing to key the parity off. Drop the score rather than publish
          // one whose sign is a coin flip.
          delete info.score;
          return info;
        }
        if (info.depth % 2 === 1) score.value = -score.value;
      }
      if (score.type === 'mate' && profile.mateOffset) {
        // Reports mate-in-1 as `mate 0`, which in real UCI means "already mated".
        score.value += Math.sign(score.value || 1) * profile.mateOffset;
      }
      info.score = score;
    }

    if (info.pv && profile.sanPv) {
      // Lozza emits SAN in a browser worker. Keep the tokens, but say so, so a
      // caller does not try to read them as coordinates.
      info.pvFormat = 'san';
      // A trailing '#' is emitted as its own bogus token.
      info.pv = info.pv.filter((token) => token !== '#' && token !== '+').map(toStandardSan);
    } else if (info.pv) {
      info.pvFormat = 'uci';
    }
    return info;
  }

  #recordOption(line) {
    // Lozza answers `uci` with the bare word `option` — no name, no type. A
    // loose parser records that as a garbage entry and every later
    // capability check becomes unreliable.
    const match = /^option name (.+?) type (\w+)(.*)$/.exec(line);
    if (!match) return;
    const [, name, type, rest] = match;
    const option = { name, type };
    const def = / default (\S+)/.exec(rest);
    const min = / min (-?\d+)/.exec(rest);
    const max = / max (-?\d+)/.exec(rest);
    if (def) option.default = def[1];
    if (min) option.min = Number(min[1]);
    if (max) option.max = Number(max[1]);
    this.options.set(name, option);
  }

  #await(token, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`timed out waiting for "${token}" from ${this.name}`));
      }, timeoutMs);
      this.#waiters.push({ token, resolve, reject, timer });
    });
  }

  #resolveWaiters(line) {
    this.#waiters = this.#waiters.filter((waiter) => {
      if (line.startsWith(waiter.token)) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
        return false;
      }
      return true;
    });
  }

  #rejectAll(error) {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters = [];
    if (this.#search) {
      const search = this.#search;
      this.#search = null;
      // The watchdog holds the fen, the budget and the adapter itself for up
      // to half a minute; a disposed engine should not stay alive on a timer.
      stopTimers(search);
      search.reject(error);
    }
  }

  async isReady() {
    this.#send('isready');
    await this.#await('readyok', HANDSHAKE_TIMEOUT_MS);
    return this;
  }

  /**
   * Sets an option, silently skipping ones this engine never declared.
   * Remembered, so it survives the worker swap that cancellation performs.
   */
  setOption(name, value) {
    if (!this.options.has(name)) return false;
    this.#appliedOptions.set(name, value);
    this.#send(`setoption name ${name} value ${value}`);
    return true;
  }

  async newGame() {
    this.#send('ucinewgame');
    this.#newGameSent = true;
    await this.isReady();
    return this;
  }

  /**
   * Searches a position.
   *
   * @param {string} fen
   * @param {{ movetime?: number, depth?: number, nodes?: number, multiPv?: number,
   *           wtime?: number, btime?: number, winc?: number, binc?: number,
   *           signal?: AbortSignal, onInfo?: (info: object) => void }} limits
   * @returns {Promise<{bestmove: string|null, ponder: string|null, info: object|null, lines: object[]}>}
   */
  search(fen, limits = {}) {
    if (this.#disposed) {
      return Promise.reject(new Error(`${this.name} has been disposed`));
    }
    // Lozza never returns a bestmove for a mated or stalemated position, and
    // floods the main thread with info lines while not returning it.
    if (this.profile.refusesGameOver && isTerminal(fen)) {
      return Promise.reject(new Error(`${this.name} cannot search a finished position`));
    }

    /** Best line seen per multipv slot; engines only re-send what changed. */
    const lines = new Map();
    let settle;
    let fail;
    const promise = new Promise((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    const search = {
      resolve: settle,
      reject: fail,
      onInfo: limits.onInfo,
      lastInfo: null,
      watchdog: null,
      /** Set only while waiting for an engine that posts `info` after `bestmove`. */
      pendingBest: null,
      grace: null,
      collect(info) {
        // Copy rather than alias: the same object is handed to the `info`
        // listeners and to onInfo, and a consumer that normalises a score in
        // place would otherwise rewrite the result being accumulated here.
        const snapshot = {
          ...info,
          score: info.score ? { ...info.score } : undefined,
          pv: info.pv ? [...info.pv] : undefined,
        };
        // Only the first line describes the position. Folding every MultiPV
        // line into one score reports the worst candidate as the evaluation.
        if (snapshot.score && (snapshot.multipv ?? 1) === 1) {
          this.lastInfo = { ...this.lastInfo, ...snapshot };
        }
        if (snapshot.pv) lines.set(snapshot.multipv ?? 1, snapshot);
      },
      lines,
    };

    // Claimed synchronously, before any await. Registering it after the worker
    // handshake left a window in which cancel() saw no search in flight and did
    // nothing — so a take-back during the engine's first moments was ignored
    // and the move it was computing got played anyway.
    const superseded = this.#search;
    this.#search = search;

    const run = async () => {
      if (superseded) {
        this.#search = search;
        superseded.reject(new Error('search superseded'));
        stopTimers(superseded);
        this.#worker?.terminate();
        this.#worker = null;
        this.#newGameSent = false;
        this.options.clear();
      }

      await this.start();
      // Cancelled or replaced while the worker was booting.
      if (this.#search !== search) return;

      if (limits.multiPv && this.capabilities.multiPv) {
        this.setOption('MultiPV', limits.multiPv);
      }
      if (this.profile.newGameBeforePosition && !this.#newGameSent) {
        this.#send('ucinewgame');
        this.#newGameSent = true;
      }
      this.#send(`position fen ${fen}`);

      // Every engine here honours exactly one budget and silently drops the
      // rest, and a `go` with no limit at all searches forever in two of three.
      const budget = budgetFor(this.profile, limits);
      const parts = ['go'];
      for (const [key, value] of Object.entries(budget)) parts.push(key, String(value));
      // p4wn's regex only keeps `depth` when it is the final token, so nothing
      // may be appended after the budget.

      if (limits.signal) {
        if (limits.signal.aborted) {
          if (this.#search === search) this.#search = null;
          fail(new Error('search aborted'));
          return;
        }
        // Fire-and-forget: cancel() rejects the very promise this listener is
        // attached to, and an uncaught rejection would surface as a page error.
        limits.signal.addEventListener('abort', () => this.cancel().catch(() => {}), {
          once: true,
        });
      }

      // A search that never answers would hang the game, and no engine here can
      // be interrupted politely, so back the budget with a hard deadline.
      const ceiling = (budget.movetime ?? 4000) * 4 + 8000;
      search.watchdog = setTimeout(() => {
        if (this.#search !== search) return;
        // A bestmove already in hand, only the trailing `info` outstanding:
        // take the answer rather than throwing away a completed search.
        if (search.pendingBest) {
          this.#settleSearch(search);
          return;
        }
        this.emit('timeout', { fen, budget });
        // Report it as a timeout, not a cancellation: "the engine hung" and
        // "the user changed their mind" need different responses.
        this.cancel({ reason: `${this.name} did not answer in time` }).catch(() => {});
      }, ceiling);

      this.#send(parts.join(' '));
    };

    run().catch((error) => {
      stopTimers(search);
      if (this.#search === search) this.#search = null;
      fail(error);
    });

    return promise;
  }

  #finishSearch(best) {
    if (!this.#search) return;
    const search = this.#search;

    if (this.profile.infoAfterBestMove && !search.lastInfo?.score) {
      // p4wn posts `bestmove` first and its only `info` line straight after.
      // Settling now would throw away every evaluation it ever gives.
      //
      // Deferring by a timer is not enough: the queued `info` message and the
      // timer callback sit on different task queues, so the browser is free to
      // run the timer first and the score is dropped perhaps one run in three.
      // Wait for the line itself instead, and treat the timer purely as the
      // floor for an engine that turns out to send nothing.
      search.pendingBest = best;
      search.grace = setTimeout(() => this.#settleSearch(search), TRAILING_INFO_GRACE_MS);
      return;
    }

    this.#settleSearch(search, best);
  }

  #settleSearch(search, best = search.pendingBest) {
    if (this.#search !== search || !best) return;
    this.#search = null;
    search.pendingBest = null;
    stopTimers(search);
    search.resolve({
      bestmove: best.bestmove,
      ponder: best.ponder,
      info: this.#resolveMateSign(search.lastInfo, best),
      lines: [...search.lines.entries()]
        .sort(([a], [b]) => a - b)
        .map(([multipv, info]) => ({ ...info, multipv })),
    });
  }

  /**
   * Abandons the running search.
   *
   * None of the bundled engines can receive a message while searching, so this
   * discards the worker and starts a new one. That is genuinely the only way to
   * interrupt them; sending `stop` would simply queue a message behind a search
   * that has already finished by the time it is read.
   */
  async cancel({ reason = 'search cancelled' } = {}) {
    if (!this.#search) return null;
    const search = this.#search;
    this.#search = null;
    stopTimers(search);

    this.#worker?.terminate();
    this.#worker = null;
    this.#newGameSent = false;
    this.options.clear();
    search.reject(new Error(reason));

    this.emit('cancelled', {});
    if (!this.#disposed) await this.start();
    return null;
  }

  /**
   * Fixes a mate score whose sign the engine could not express.
   *
   * Lozza computes its mate distance as `(MATE - |score|) / 2`, which throws
   * the sign away — a mate in one comes back as `mate 0` whether it is
   * delivering it or walking into it. Whether a bestmove came back settles it:
   * a side with no legal move is the mated one.
   */
  #resolveMateSign(info, best) {
    if (!info?.score || info.score.type !== 'mate') return info;
    if (!this.profile.mateSignFromBestMove) return info;
    const sign = best.bestmove ? 1 : -1;
    const magnitude = Math.max(1, Math.abs(info.score.value));
    return { ...info, score: { ...info.score, value: sign * magnitude } };
  }

  /** Kept for callers that expect the UCI verb; cancellation is the same thing. */
  stop() {
    return this.cancel();
  }

  /**
   * Shuts the engine down for good. Terminal: a straggler that still holds a
   * reference gets an error rather than silently rebooting the worker it just
   * disposed.
   */
  dispose() {
    this.#disposed = true;
    this.#rejectAll(new Error('engine disposed'));
    this.#worker?.terminate();
    this.#worker = null;
    this.#appliedOptions.clear();
    this.state = 'disposed';
    this.removeAllListeners();
  }
}
