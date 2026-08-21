/**
 * Playing without a mouse.
 *
 * Two independent things: global shortcuts for navigation, and a board cursor
 * that lets a keyboard or screen-reader user actually move pieces. The old
 * build had neither — the board was a canvas with no keyboard path into it at
 * all, which made the game unplayable for anyone who could not use a pointer.
 *
 * Typed algebraic entry is the third path, and the fastest one for a strong
 * player: type `Nf3`, press Enter.
 */
import { FILES, RANKS } from '../core/constants.js';

/** Navigation keys. Never ambiguous, so they work whatever is being typed. */
const NAVIGATION = new Map([
  ['ArrowLeft', 'back'],
  ['ArrowRight', 'forward'],
  ['Home', 'start'],
  ['End', 'end'],
]);

/**
 * Letter shortcuts, deliberately upper case.
 *
 * `f`, `h` and `t` in lower case are file letters: bound as shortcuts, typing
 * `Nf3` flipped the board instead of entering the move. No SAN move begins with
 * F, H or T, so the shifted forms cannot collide with anything a player types.
 */
const LETTERS = new Map([
  ['F', 'flip'],
  ['H', 'hint'],
  ['T', 'takeback'],
  ['?', 'help'],
]);

export class KeyboardControl {
  /**
   * @param {{ target: HTMLElement, boardElement: HTMLElement,
   *           onAction: (action: string) => void,
   *           onSquare: (square: string) => void,
   *           onCursor: (square: string|null) => void,
   *           onTyped: (text: string) => boolean }} options
   */
  constructor(options) {
    this.options = options;
    this.cursor = 'e1';
    this.typed = '';
    this.enabled = true;
    this.orientation = 'white';
    this.#bind();
  }

  #handlers = [];
  #typedTimer = null;

  #bind() {
    const onKeyDown = (event) => this.#onKeyDown(event);
    document.addEventListener('keydown', onKeyDown);
    this.#handlers.push(['keydown', onKeyDown, document]);

    const board = this.options.boardElement;
    board.tabIndex = 0;
    board.setAttribute('role', 'application');
    board.setAttribute(
      'aria-label',
      'Chess board. Use arrow keys to move the cursor, Enter to select.',
    );
    const onFocus = () => this.options.onCursor?.(this.cursor);
    const onBlur = () => this.options.onCursor?.(null);
    board.addEventListener('focus', onFocus);
    board.addEventListener('blur', onBlur);
    this.#handlers.push(['focus', onFocus, board], ['blur', onBlur, board]);
  }

  #isEditing(event) {
    const node = event.target;
    return (
      node instanceof HTMLInputElement ||
      node instanceof HTMLTextAreaElement ||
      node instanceof HTMLSelectElement ||
      node?.isContentEditable
    );
  }

  /**
   * True while a modal is up.
   *
   * The dialog owns the keyboard then. Without this, arrows navigated the game
   * and `F` flipped the board behind an open dialog, which is both confusing
   * and a trap for anyone driving the dialog from the keyboard.
   */
  #modalOpen() {
    return document.querySelector('dialog[open]') !== null;
  }

  #onKeyDown(event) {
    if (!this.enabled || this.#isEditing(event) || this.#modalOpen()) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const boardFocused = document.activeElement === this.options.boardElement;

    // Board cursor movement takes precedence over history navigation, but only
    // while the board itself has focus — otherwise Left/Right would stop
    // stepping through the game, which is what they do everywhere else.
    if (boardFocused && this.#moveCursor(event.key)) {
      event.preventDefault();
      return;
    }
    // Enter means "submit the move I just typed" whenever there is one, and
    // "activate the square under the cursor" otherwise. Checking the cursor
    // first made typed algebraic entry unreachable while the board had focus,
    // which is exactly when someone would be typing.
    if (boardFocused && (event.key === 'Enter' || event.key === ' ') && !this.typed) {
      event.preventDefault();
      this.options.onSquare?.(this.cursor);
      return;
    }

    const navigation = NAVIGATION.get(event.key);
    if (navigation) {
      event.preventDefault();
      this.options.onAction?.(navigation);
      return;
    }

    const letter = LETTERS.get(event.key);
    if (letter) {
      event.preventDefault();
      this.options.onAction?.(letter);
      return;
    }

    // Algebraic entry: accumulate SAN-ish characters, submit on Enter.
    if (/^[a-hKQRBNOx0-8=+#-]$/.test(event.key)) {
      this.typed += event.key;
      this.#resetTypedTimer();
      return;
    }
    if (event.key === 'Backspace' && this.typed) {
      event.preventDefault();
      this.typed = this.typed.slice(0, -1);
      this.#resetTypedTimer();
      return;
    }
    if (event.key === 'Enter' && this.typed) {
      event.preventDefault();
      const typed = this.typed.trim();
      // onTyped is async: playing a move can have to cancel a hint first. Read
      // the verdict after it settles, or a move that WAS played is announced as
      // illegal and left in the buffer.
      Promise.resolve(this.options.onTyped?.(typed)).then((accepted) => {
        if (accepted && this.typed === typed) this.typed = '';
        this.#resetTypedTimer();
      });
      return;
    }
    if (event.key === 'Escape') {
      this.typed = '';
      this.options.onAction?.('escape');
    }
  }

  /** Clears a half-typed move if the player wanders off. */
  #resetTypedTimer() {
    clearTimeout(this.#typedTimer);
    this.options.onAction?.('typing');
    this.#typedTimer = setTimeout(() => {
      this.typed = '';
      this.options.onAction?.('typing');
    }, 2500);
  }

  #moveCursor(keyName) {
    const deltas = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
    };
    const delta = deltas[keyName];
    if (!delta) return false;

    // Arrows are relative to what the player sees. With the board flipped,
    // "up" is towards rank 1, and a cursor that ignored that moved backwards.
    const sign = this.orientation === 'black' ? -1 : 1;
    let file = FILES.indexOf(this.cursor[0]) + delta[0] * sign;
    let rank = RANKS.indexOf(this.cursor[1]) + delta[1] * sign;
    file = Math.max(0, Math.min(7, file));
    rank = Math.max(0, Math.min(7, rank));
    this.cursor = `${FILES[file]}${RANKS[rank]}`;
    this.options.onCursor?.(this.cursor);
    return true;
  }

  setCursor(square) {
    this.cursor = square;
    this.options.onCursor?.(square);
  }

  /** Flips cursor movement so Up always means "forwards" for the viewer. */
  setOrientation(orientation) {
    this.orientation = orientation;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  dispose() {
    for (const [type, handler, target] of this.#handlers) {
      target.removeEventListener(type, handler);
    }
    this.#handlers = [];
    clearTimeout(this.#typedTimer);
  }
}

export const SHORTCUTS = Object.freeze([
  ['←  →', 'Step back and forward through the game'],
  ['Home / End', 'Jump to the start or the latest move'],
  ['Type e4, Nf3…', 'Enter a move in algebraic notation, then Enter'],
  ['Tab then arrows', 'Move the board cursor; Enter selects'],
  ['Shift + F', 'Flip the board'],
  ['Shift + H', 'Ask for a hint'],
  ['Shift + T', 'Take back a move'],
  ['Shift + ?', 'Show this list'],
  ['Esc', 'Cancel a selection or a half-typed move'],
]);
