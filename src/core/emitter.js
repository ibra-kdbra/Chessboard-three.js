/**
 * Minimal synchronous event emitter.
 *
 * EventTarget would do, except it only exists in the DOM and in newer node, and
 * forcing every payload through CustomEvent.detail reads badly. This is 30
 * lines and works identically in the browser, in a worker and under vitest.
 */
export class Emitter {
  #listeners = new Map();

  /** @returns {() => void} an unsubscribe function. */
  on(type, handler) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(handler);
    return () => this.off(type, handler);
  }

  once(type, handler) {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(type, handler) {
    this.#listeners.get(type)?.delete(handler);
  }

  emit(type, payload) {
    // Copy first: handlers commonly unsubscribe themselves.
    for (const handler of [...(this.#listeners.get(type) ?? [])]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`listener for "${type}" threw`, error);
      }
    }
  }

  removeAllListeners(type) {
    if (type) this.#listeners.delete(type);
    else this.#listeners.clear();
  }
}
