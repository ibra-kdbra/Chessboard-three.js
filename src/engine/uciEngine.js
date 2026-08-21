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

  /** Boots the worker and completes the UCI handshake. */
  async start() {
    if (this.#worker) return this;
    this.state = 'starting';
    this.#worker = this.#workerFactory(this.url);
    this.#worker.onmessage = (event) => this.#receive(String(event.data ?? ''));
    this.#worker.onerror = (event) => {
      this.state = 'error';
      this.emit('error', event);
      this.#rejectAll(new Error(`engine worker failed: ${event.message ?? this.url}`));
    };

    this.#send('uci');
    await this.#await('uciok', HANDSHAKE_TIMEOUT_MS);
    await this.isReady();
    // p4wn's internal state does not exist until ucinewgame has run; a
    // `position` before that throws inside the worker with no error reply.
    if (this.profile.newGameBeforePosition) {
      this.#send('ucinewgame');
      this.#newGameSent = true;
    }
    this.state = 'ready';
    this.emit('ready', this);
    return this;
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
        this.#search?.onInfo?.(info);
        if (info.pv || info.score) this.#search?.collect(info);
        this.emit('info', info);
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
      if (score.type === 'cp' && profile.cpParityFlips && info.depth % 2 === 1) {
        // The sign alternates with search-depth parity, so odd depths report
        // the score from the opponent's point of view.
        score.value = -score.value;
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
      info.pv = info.pv.filter((token) => token !== '#' && token !== '+');
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
      search.reject(error);
    }
  }

  async isReady() {
    this.#send('isready');
    await this.#await('readyok', HANDSHAKE_TIMEOUT_MS);
    return this;
  }

  /** Sets an option, silently skipping ones this engine never declared. */
  setOption(name, value) {
    if (!this.options.has(name)) return false;
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
  async search(fen, limits = {}) {
    if (this.#search) await this.cancel();
    if (!this.#worker) await this.start();

    if (limits.multiPv && this.capabilities.multiPv) {
      this.setOption('MultiPV', limits.multiPv);
    }
    if (this.profile.newGameBeforePosition && !this.#newGameSent) {
      this.#send('ucinewgame');
      this.#newGameSent = true;
    }

    this.#send(`position fen ${fen}`);

    // Every engine here honours exactly one budget and silently drops the rest,
    // and a `go` with no limit at all searches forever in two of the three.
    const budget = budgetFor(this.profile, limits);
    const parts = ['go'];
    for (const [key, value] of Object.entries(budget)) parts.push(key, String(value));
    // p4wn's regex only keeps `depth` when it is the final token, so nothing
    // may be appended after the budget.

    return new Promise((resolve, reject) => {
      /** Best line seen per multipv slot; engines only re-send what changed. */
      const lines = new Map();
      const search = {
        resolve,
        reject,
        onInfo: limits.onInfo,
        lastInfo: null,
        watchdog: null,
        collect(info) {
          if (info.score) this.lastInfo = { ...this.lastInfo, ...info };
          if (info.pv) lines.set(info.multipv ?? 1, { ...info });
        },
        lines,
      };
      this.#search = search;

      if (limits.signal) {
        if (limits.signal.aborted) {
          this.#search = null;
          reject(new Error('search aborted'));
          return;
        }
        limits.signal.addEventListener('abort', () => this.cancel(), { once: true });
      }

      // A search that never answers would hang the game, and no engine here can
      // be interrupted politely, so back the budget with a hard deadline.
      const ceiling = (budget.movetime ?? 4000) * 4 + 8000;
      search.watchdog = setTimeout(() => {
        if (this.#search === search) {
          this.emit('timeout', { fen, budget });
          this.cancel().then(() => reject(new Error(`${this.name} did not answer in time`)));
        }
      }, ceiling);

      this.#send(parts.join(' '));
    });
  }

  #finishSearch(best) {
    if (!this.#search) return;
    const search = this.#search;
    const settle = () => {
      if (this.#search !== search) return;
      this.#search = null;
      clearTimeout(search.watchdog);
      search.resolve({
        bestmove: best.bestmove,
        ponder: best.ponder,
        info: search.lastInfo,
        lines: [...search.lines.entries()]
          .sort(([a], [b]) => a - b)
          .map(([multipv, info]) => ({ ...info, multipv })),
      });
    };

    if (this.profile.infoAfterBestMove) {
      // p4wn posts `bestmove` first and its only `info` line straight after.
      // Settling immediately would throw away every evaluation it ever gives.
      setTimeout(settle, 0);
    } else {
      settle();
    }
  }

  /**
   * Abandons the running search.
   *
   * None of the bundled engines can receive a message while searching, so this
   * discards the worker and starts a new one. That is genuinely the only way to
   * interrupt them; sending `stop` would simply queue a message behind a search
   * that has already finished by the time it is read.
   */
  async cancel() {
    if (!this.#search) return null;
    const search = this.#search;
    this.#search = null;
    clearTimeout(search.watchdog);

    this.#worker?.terminate();
    this.#worker = null;
    this.#newGameSent = false;
    this.options.clear();
    search.reject(new Error('search cancelled'));

    this.emit('cancelled', {});
    await this.start();
    return null;
  }

  /** Kept for callers that expect the UCI verb; cancellation is the same thing. */
  stop() {
    return this.cancel();
  }

  dispose() {
    this.#rejectAll(new Error('engine disposed'));
    this.#worker?.terminate();
    this.#worker = null;
    this.state = 'disposed';
    this.removeAllListeners();
  }
}
