/**
 * Share links and clipboard export.
 *
 * A position or a whole game encodes into the URL hash, so a link is enough to
 * hand someone a position — no server, no account, nothing stored anywhere.
 *
 * The hash is read once at boot and is never treated as a router: a chess game
 * with browser-history semantics fights the back button, so the URL is a
 * transport for state, not a description of where you are.
 */
import { START_FEN } from '../core/constants.js';

/** base64url, so a game survives being pasted into a chat window. */
function encodeBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * @param {{ fen?: string, pgn?: string }} what
 * @param {string} [href] the page to hang the fragment off; defaults to this one
 * @returns {string} an absolute URL
 *
 * The base is an argument with a default, matching `readShareTarget` below —
 * the seam is what lets the link format be tested without a browser.
 */
export function buildShareUrl({ fen, pgn }, href = window.location.href) {
  const url = new URL(href);
  url.hash = '';
  if (pgn) return `${url.href}#game=${encodeBase64Url(pgn)}`;
  if (fen && fen !== START_FEN) return `${url.href}#fen=${encodeURIComponent(fen)}`;
  return url.href;
}

/**
 * Reads a shared position or game out of the current URL.
 * @returns {{ kind: 'fen', fen: string } | { kind: 'pgn', pgn: string } | null}
 */
export function readShareTarget(hash = window.location.hash) {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);

  const fen = params.get('fen');
  if (fen) return { kind: 'fen', fen: decodeURIComponent(fen) };

  const game = params.get('game');
  if (game) {
    try {
      return { kind: 'pgn', pgn: decodeBase64Url(game) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Removes the share fragment without adding a history entry. */
export function clearShareTarget() {
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

/**
 * Copies text, falling back to a hidden textarea where the async clipboard API
 * is unavailable (it needs a secure context, which a plain-HTTP dev server is not).
 * @returns {Promise<boolean>} whether it worked
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(field);
    field.select();
    const ok = document.execCommand('copy');
    field.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Offers a file for download. Used for PGN export. */
export function downloadText(filename, text, type = 'application/x-chess-pgn') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** `boxwood-2026-08-21-sicilian.pgn` */
export function suggestFilename(opening, date = new Date()) {
  const stamp = date.toISOString().slice(0, 10);
  const slug = opening
    ? `-${opening
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')}`
    : '';
  return `boxwood-${stamp}${slug}.pgn`;
}
