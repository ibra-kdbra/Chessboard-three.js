/**
 * Local storage.
 *
 * Every read is defensive: storage throws outright in some privacy modes, and
 * a saved game from an older version can be structurally wrong. A settings
 * panel that crashes the app because one key is stale is worse than no
 * persistence at all, so anything unreadable is discarded and replaced.
 */

const NAMESPACE = 'chessboard3';
const VERSION = 1;

function key(name) {
  return `${NAMESPACE}:v${VERSION}:${name}`;
}

function available() {
  try {
    const probe = `${NAMESPACE}:probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export const storageAvailable = available();

export function read(name, fallback = null) {
  if (!storageAvailable) return fallback;
  try {
    const raw = localStorage.getItem(key(name));
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function write(name, value) {
  if (!storageAvailable) return false;
  try {
    localStorage.setItem(key(name), JSON.stringify(value));
    return true;
  } catch {
    // Quota exhausted, most likely from the saved-games list.
    return false;
  }
}

export function remove(name) {
  if (!storageAvailable) return;
  try {
    localStorage.removeItem(key(name));
  } catch {
    /* nothing useful to do */
  }
}

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'tournament',
  pieceSet: 'classic',
  pieceSet2d: 'wikipedia',
  cameraMode: 'orbit',
  dimensions: 3,
  quality: null, // null means auto-detect
  uiTheme: 'dark',
  highContrast: false,
  reducedMotion: false,
  showLegalMoves: true,
  showCoordinates: true,
  showEvalBar: true,
  liveAnalysis: true,
  soundEnabled: true,
  soundVolume: 0.6,
  haptics: true,
  engine: 'lozza',
  difficulty: 5,
  timeControl: 'unlimited',
  playerColor: 'w',
  autoFlip: false,
  confirmMoves: false,
  coachHints: true,
});

export function loadSettings() {
  const stored = read('settings', {});
  // Merge rather than replace: a new setting added in a later version must not
  // be undefined for someone who has an older blob saved.
  return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
}

export function saveSettings(settings) {
  return write('settings', settings);
}

/** The single in-progress game, so a reload does not lose it. */
export function loadCurrentGame() {
  const saved = read('current-game');
  if (!saved || saved.version !== 1 || !saved.state?.tree) return null;
  return saved;
}

export function saveCurrentGame(payload) {
  return write('current-game', { version: 1, savedAt: Date.now(), ...payload });
}

export function clearCurrentGame() {
  remove('current-game');
}

const LIBRARY_LIMIT = 50;

/** Finished games, newest first. Capped so storage cannot fill up. */
export function loadLibrary() {
  const list = read('library', []);
  return Array.isArray(list) ? list : [];
}

export function addToLibrary(entry) {
  const list = loadLibrary();
  list.unshift({ id: `g${Date.now().toString(36)}`, savedAt: Date.now(), ...entry });
  return write('library', list.slice(0, LIBRARY_LIMIT));
}

export function removeFromLibrary(id) {
  return write(
    'library',
    loadLibrary().filter((entry) => entry.id !== id),
  );
}
