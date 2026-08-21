/**
 * Transient messages.
 *
 * The old code used SweetAlert modals for everything, including things as small
 * as "using the Lozza engine" — a modal for a status change interrupts the game
 * to tell you nothing important. These do not steal focus and time out.
 */
import { el, announce } from './dom.js';

const DEFAULT_MS = 3200;

export class Toaster {
  constructor(parent = document.body) {
    this.element = el('div.toasts', { role: 'status', 'aria-live': 'polite' });
    parent.append(this.element);
  }

  /** @param {{ tone?: 'info'|'success'|'error', duration?: number }} [options] */
  show(message, { tone = 'info', duration = DEFAULT_MS } = {}) {
    const toast = el('div.toast', { dataset: { tone }, text: message });
    this.element.append(toast);
    // Errors matter enough to interrupt a screen reader mid-sentence.
    announce(message, { assertive: tone === 'error' });

    const remove = () => {
      toast.style.opacity = '0';
      toast.style.translate = '0 6px';
      setTimeout(() => toast.remove(), 200);
    };
    const timer = setTimeout(remove, duration);
    toast.addEventListener('click', () => {
      clearTimeout(timer);
      remove();
    });
    return remove;
  }

  error(message) {
    return this.show(message, { tone: 'error', duration: 5000 });
  }

  success(message) {
    return this.show(message, { tone: 'success' });
  }
}
