/**
 * The evaluation graph for a finished game.
 *
 * Plotted in expected score rather than centipawns, for the same reason the
 * eval bar is: on a centipawn axis the whole game is a flat line until someone
 * hangs a queen, and then it is a cliff. Expected score spends its resolution
 * where the game was actually decided.
 *
 * Inline SVG, so it scales, prints, and inherits the theme's colours.
 */
import { el } from './dom.js';
import { QUALITY_META, expectedScore } from '../core/evaluation.js';

const NS = 'http://www.w3.org/2000/svg';

const svg = (name, attributes = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  return node;
};

/**
 * @param {Array<import('../core/gameTree.js').GameNode>} nodes mainline in order
 * @param {{ width?: number, height?: number, onSelect?: (node) => void }} [options]
 */
export function buildEvalGraph(nodes, { width = 320, height = 72, onSelect } = {}) {
  const scored = nodes.filter((node) => node.evaluation);
  if (scored.length < 2) {
    return el('p', {
      text: 'Not enough analysis to graph.',
      style: { color: 'var(--text-3)', fontSize: 'var(--text-xs)', margin: '0' },
    });
  }

  const chart = svg('svg', {
    class: 'evalgraph',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': 'Evaluation over the course of the game',
  });

  const x = (index) => (index / (nodes.length - 1 || 1)) * width;
  // Expected score is 0..1 with 1 = white winning, and SVG y grows downwards.
  const y = (node) => (1 - expectedScore(node.evaluation)) * height;

  // The black half of the field, so "who is winning" reads without a legend.
  chart.append(svg('rect', { x: 0, y: 0, width, height, fill: 'var(--eval-black)' }));

  let area = `M 0 ${height}`;
  let line = '';
  for (const [index, node] of nodes.entries()) {
    if (!node.evaluation) continue;
    const px = x(index);
    const py = y(node);
    area += ` L ${px.toFixed(1)} ${py.toFixed(1)}`;
    line += `${line ? ' L' : 'M'} ${px.toFixed(1)} ${py.toFixed(1)}`;
  }
  area += ` L ${width} ${height} Z`;

  chart.append(svg('path', { d: area, fill: 'var(--eval-white)', opacity: '0.92' }));
  chart.append(
    svg('line', {
      x1: 0,
      x2: width,
      y1: height / 2,
      y2: height / 2,
      stroke: 'var(--accent)',
      'stroke-width': 0.5,
      opacity: 0.5,
    }),
  );
  chart.append(
    svg('path', {
      d: line,
      fill: 'none',
      stroke: 'var(--text-1)',
      'stroke-width': 1,
      opacity: 0.35,
    }),
  );

  // Mark the moments the game turned.
  for (const [index, node] of nodes.entries()) {
    if (!['blunder', 'mistake'].includes(node.quality)) continue;
    const marker = svg('circle', {
      cx: x(index),
      cy: y(node),
      r: node.quality === 'blunder' ? 3 : 2.2,
      fill: `var(--quality-${node.quality})`,
      stroke: 'var(--surface-1)',
      'stroke-width': 1,
    });
    const title = svg('title');
    title.textContent =
      `${node.moveNumber}${node.color === 'w' ? '.' : '…'} ${node.move.san}` +
      ` — ${QUALITY_META[node.quality].label}`;
    marker.append(title);

    if (onSelect) {
      marker.setAttribute('role', 'button');
      marker.setAttribute('tabindex', '0');
      marker.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(node);
        }
      });
      marker.style.cursor = 'pointer';
      marker.addEventListener('click', () => onSelect(node));
    }
    chart.append(marker);
  }

  return chart;
}
