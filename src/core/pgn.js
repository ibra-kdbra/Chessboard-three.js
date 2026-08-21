/**
 * PGN import/export for the move tree.
 *
 * chess.js can read and write PGN, but only a flat mainline — it has no concept
 * of variations, so round-tripping an analysis through it silently throws the
 * analysis away. This writes and parses the real thing: nested variations,
 * comments, NAGs and `[%eval]`/`[%clk]` command annotations.
 */
import { Chess } from 'chess.js';
import { GameTree } from './gameTree.js';
import { START_FEN } from './constants.js';

/** The subset of NAGs worth showing; anything else round-trips as `$n`. */
export const NAG_SYMBOLS = Object.freeze({
  1: '!',
  2: '?',
  3: '!!',
  4: '??',
  5: '!?',
  6: '?!',
  10: '=',
  13: '∞',
  14: '⩲',
  15: '⩱',
  16: '±',
  17: '∓',
  18: '+−',
  19: '−+',
});

export const SEVEN_TAG_ROSTER = Object.freeze([
  'Event',
  'Site',
  'Date',
  'Round',
  'White',
  'Black',
  'Result',
]);

function formatEval(evaluation) {
  if (!evaluation) return null;
  return evaluation.type === 'mate'
    ? `#${evaluation.value}`
    : (evaluation.value / 100).toFixed(2);
}

function formatClock(ms) {
  if (ms === null || ms === undefined) return null;
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Serialises a tree to PGN.
 * @param {GameTree} tree
 * @param {{ headers?: Record<string,string>, result?: string, includeVariations?: boolean,
 *           includeAnnotations?: boolean, maxWidth?: number }} [options]
 */
export function writePgn(tree, options = {}) {
  const {
    headers = {},
    result = '*',
    includeVariations = true,
    includeAnnotations = true,
    maxWidth = 80,
  } = options;

  const tags = { ...tree.headers, ...headers, Result: result };
  for (const tag of SEVEN_TAG_ROSTER) {
    if (tags[tag] === undefined) tags[tag] = tag === 'Date' ? '????.??.??' : tag === 'Result' ? '*' : '?';
  }
  if (tree.startFen !== START_FEN) {
    tags.SetUp = '1';
    tags.FEN = tree.startFen;
  }

  const ordered = [
    ...SEVEN_TAG_ROSTER.filter((tag) => tags[tag] !== undefined),
    ...Object.keys(tags).filter((tag) => !SEVEN_TAG_ROSTER.includes(tag)).sort(),
  ];
  const header = ordered
    .map((tag) => `[${tag} "${String(tags[tag]).replace(/["\\]/g, '\\$&')}"]`)
    .join('\n');

  const tokens = [];

  const emitNode = (node, forceNumber) => {
    const white = node.color === 'w';
    if (white) tokens.push(`${node.moveNumber}.`);
    else if (forceNumber) tokens.push(`${node.moveNumber}...`);
    tokens.push(node.move.san);

    if (includeAnnotations) {
      for (const nag of node.nags) tokens.push(`$${nag}`);
      const commands = [];
      const evaluation = formatEval(node.evaluation);
      if (evaluation) commands.push(`[%eval ${evaluation}]`);
      const clock = formatClock(node.clock);
      if (clock) commands.push(`[%clk ${clock}]`);
      const text = [commands.join(' '), node.comment].filter(Boolean).join(' ').trim();
      if (text) tokens.push(`{${text.replace(/[{}]/g, '')}}`);
    }
  };

  /** Walks one line, spilling siblings into parenthesised variations. */
  const emitLine = (start, forceNumberFirst) => {
    let node = start;
    let forceNumber = forceNumberFirst;
    while (node) {
      emitNode(node, forceNumber);
      forceNumber = false;
      if (includeVariations && node.parent.children.length > 1 && node === node.parent.children[0]) {
        for (const sibling of node.parent.children.slice(1)) {
          tokens.push('(');
          emitLine(sibling, sibling.color === 'b');
          tokens.push(')');
          forceNumber = true; // the mainline must restate the move number after a branch
        }
      }
      node = node.children[0];
    }
  };

  if (tree.root.children.length) emitLine(tree.root.children[0], tree.root.children[0].color === 'b');
  tokens.push(result);

  // Wrap without ever splitting a brace comment across the fold.
  let body = '';
  let line = '';
  for (const token of tokens) {
    const glue = line && !line.endsWith('(') && token !== ')' ? ' ' : '';
    if (maxWidth && line.length + glue.length + token.length > maxWidth) {
      body += `${line}\n`;
      line = token;
    } else {
      line += glue + token;
    }
  }
  body += line;

  return `${header}\n\n${body}\n`;
}

// Order matters: a brace comment may contain `[%eval ...]`, so comments are
// matched before tag pairs, and the game result before a bare SAN-ish token.
const TOKEN_RE =
  /(\{[^}]*\})|(\[[^\]]*\])|(\()|(\))|(\$\d+)|(\d+\.(?:\.\.)?)|(1-0|0-1|1\/2-1\/2|\*)|([OoA-Za-z][A-Za-z0-9=+#!?-]*)/g;

function parseHeaders(text) {
  const headers = {};
  const re = /\[\s*(\w+)\s*"((?:[^"\\]|\\.)*)"\s*\]/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    headers[match[1]] = match[2].replace(/\\(["\\])/g, '$1');
  }
  return headers;
}

function parseCommandsFromComment(comment) {
  const result = { text: comment, evaluation: null, clock: null };
  result.text = comment
    .replace(/\[%eval\s+([^\]]+)\]/g, (_, raw) => {
      const value = raw.trim();
      result.evaluation = value.startsWith('#')
        ? { type: 'mate', value: Number(value.slice(1)), depth: null }
        : { type: 'cp', value: Math.round(Number(value) * 100), depth: null };
      return '';
    })
    .replace(/\[%clk\s+([^\]]+)\]/g, (_, raw) => {
      const [h = '0', m = '0', s = '0'] = raw.trim().split(':');
      result.clock = (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000;
      return '';
    })
    .replace(/\[%[a-zA-Z]+\s+[^\]]*\]/g, '')
    .trim();
  return result;
}

/**
 * Parses PGN — including nested variations — into a tree.
 * @param {string} text
 * @returns {{ tree: GameTree, headers: Record<string,string>, result: string }}
 * @throws {Error} when a move token is not legal in the position it appears in.
 */
export function parsePgn(text) {
  const headers = parseHeaders(text);
  const startFen = headers.FEN && headers.SetUp !== '0' ? headers.FEN : START_FEN;

  // Movetext starts at the first line that is not a tag pair.
  const headerBlock = text.match(/^(?:\s*\[\s*\w+\s*"(?:[^"\\]|\\.)*"\s*\]\s*)*/);
  const movetext = text.slice(headerBlock ? headerBlock[0].length : 0);

  const tree = new GameTree(startFen, headers);
  const chess = new Chess(startFen);

  /** Parenthesis stack: each entry restores the node a variation branches from. */
  const stack = [];
  let node = tree.root;
  let result = headers.Result ?? '*';

  const positionAt = (target) => {
    chess.load(tree.startFen);
    for (const step of target.path().slice(1)) chess.move(step.move.san);
  };

  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(movetext)) !== null) {
    const [token, comment, tag, open, close, nag, , gameResult, san] = match;

    if (tag) continue;
    if (gameResult) {
      result = gameResult;
      continue;
    }
    if (/^\d+\.(\.\.)?$/.test(token)) continue;

    if (comment) {
      const parsed = parseCommandsFromComment(comment.slice(1, -1));
      if (!node.isRoot) {
        node.comment = [node.comment, parsed.text].filter(Boolean).join(' ');
        if (parsed.evaluation) node.evaluation = parsed.evaluation;
        if (parsed.clock !== null) node.clock = parsed.clock;
      }
      continue;
    }
    if (nag) {
      if (!node.isRoot) node.nags.push(Number(nag.slice(1)));
      continue;
    }
    if (open) {
      // A variation branches from the position *before* the move just read.
      stack.push(node);
      node = node.parent ?? tree.root;
      positionAt(node);
      continue;
    }
    if (close) {
      node = stack.pop() ?? tree.root;
      positionAt(node);
      continue;
    }
    if (!san) continue;

    const cleaned = san.replace(/[!?]+$/, '').replace(/^0-0-0$/i, 'O-O-O').replace(/^0-0$/i, 'O-O');
    if (/^(1-0|0-1)$/.test(cleaned)) continue;
    let played;
    try {
      played = chess.move(cleaned);
    } catch {
      played = null;
    }
    if (!played) throw new Error(`illegal move in PGN: "${san}" at ply ${node.ply + 1}`);
    node = tree.addMove(
      {
        color: played.color,
        from: played.from,
        to: played.to,
        piece: played.piece,
        captured: played.captured,
        promotion: played.promotion,
        flags: played.flags,
        san: played.san,
        lan: played.lan,
        before: played.before,
        after: played.after,
      },
      played.after,
      node,
    );
  }

  tree.current = tree.root;
  return { tree, headers, result };
}
