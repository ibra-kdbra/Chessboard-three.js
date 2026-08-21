/**
 * A promise-shaped wrapper around a UCI engine running in a Web Worker.
 *
 * The engines we ship differ in what they understand — Lozza declares no
 * options at all, Stockfish declares many — so the adapter probes at handshake
 * time and exposes what it found. Callers ask for a search and await a result;
 * they never poke at the worker protocol themselves.
 */
import { Emitter } from '../core/emitter.js';

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
   * @param {{ url: string, name?: string, workerFactory?: (url: string) => Worker }} options
   */
  constructor({ url, name = url, workerFactory }) {
    super();
    this.url = url;
    this.name = name;
    this.id = null;
    this.author = null;
    /** Declared UCI options, keyed by name. */
    this.options = new Map();
    this.state = 'idle';
    this.#workerFactory = workerFactory ?? ((source) => new Worker(source));
  }

  #workerFactory;
  #worker = null;
  /** Resolvers waiting on a specific token (`uciok`, `readyok`). */
  #waiters = [];
  /** In-flight search, if any. */
  #search = null;

  get isSearching() {
    return this.#search !== null;
  }

  /** What this particular engine can actually do — probed, not assumed. */
  get capabilities() {
    return {
      multiPv: this.options.has('MultiPV'),
      limitStrength: this.options.has('UCI_LimitStrength') || this.options.has('UCI_Elo'),
      skillLevel: this.options.has('Skill Level'),
      hash: this.options.has('Hash'),
      threads: this.options.has('Threads'),
      ponder: this.options.has('Ponder'),
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

      const info = parseInfo(trimmed);
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

  #recordOption(line) {
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
    if (this.#search) await this.stop();

    if (limits.multiPv && this.capabilities.multiPv) {
      this.setOption('MultiPV', limits.multiPv);
    }

    this.#send(`position fen ${fen}`);

    const parts = ['go'];
    for (const key of ['depth', 'nodes', 'movetime', 'wtime', 'btime', 'winc', 'binc', 'movestogo']) {
      if (limits[key] !== undefined && limits[key] !== null) parts.push(key, String(limits[key]));
    }
    if (parts.length === 1) parts.push('movetime', '1000');

    return new Promise((resolve, reject) => {
      /** Best line seen per multipv slot; engines only re-send what changed. */
      const lines = new Map();
      this.#search = {
        resolve,
        reject,
        onInfo: limits.onInfo,
        lastInfo: null,
        collect(info) {
          if (info.score) this.lastInfo = { ...this.lastInfo, ...info };
          if (info.pv) lines.set(info.multipv ?? 1, { ...info });
        },
        lines,
      };

      if (limits.signal) {
        if (limits.signal.aborted) {
          this.#search = null;
          reject(new DOMException('search aborted', 'AbortError'));
          return;
        }
        limits.signal.addEventListener('abort', () => this.stop(), { once: true });
      }

      this.#send(parts.join(' '));
    });
  }

  #finishSearch(best) {
    if (!this.#search) return;
    const search = this.#search;
    this.#search = null;
    search.resolve({
      bestmove: best.bestmove,
      ponder: best.ponder,
      info: search.lastInfo,
      lines: [...search.lines.entries()]
        .sort(([a], [b]) => a - b)
        .map(([multipv, info]) => ({ ...info, multipv })),
    });
  }

  /** Asks the engine to stop; resolves once the pending search has settled. */
  async stop() {
    if (!this.#search) return null;
    const pending = new Promise((resolve) => {
      const search = this.#search;
      const originalResolve = search.resolve;
      search.resolve = (value) => {
        originalResolve(value);
        resolve(value);
      };
    });
    this.#send('stop');
    // Some engines ignore `stop` mid-iteration; don't hang the UI on them.
    return Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve(null), 3_000)),
    ]);
  }

  dispose() {
    this.#rejectAll(new Error('engine disposed'));
    this.#worker?.terminate();
    this.#worker = null;
    this.state = 'disposed';
    this.removeAllListeners();
  }
}
