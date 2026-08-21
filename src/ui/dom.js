/**
 * A very small DOM helper.
 *
 * The old code used jQuery for element creation and event binding and nothing
 * else, which is a 84KB dependency for two conveniences. This is those two
 * conveniences.
 */

/**
 * @param {string} spec tag, classes and id in any order:
 *   `'button.btn.btn--x#go'`, `'div#board.stage'`, `'#root'`
 * @param {object} [props] attributes; `class`, `text`, `html`, `dataset`,
 *   `style` and `on` (an event map) are handled specially
 * @param {Array<Node|string|null|undefined>} [children]
 */
export function el(spec, props = {}, children = []) {
  // The id may follow the tag or trail the last class, so pull it out first
  // rather than assuming it is attached to the tag.
  let id = null;
  const withoutId = spec.replace(/#([\w-]+)/, (_, found) => {
    id = found;
    return '';
  });
  const [tag, ...classes] = withoutId.split('.');
  const node = document.createElement(tag || 'div');

  if (id) node.id = id;
  const classList = classes.filter(Boolean);
  if (props.class) classList.push(...String(props.class).split(/\s+/).filter(Boolean));
  if (classList.length) node.className = classList.join(' ');

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || key === 'class') continue;
    switch (key) {
      case 'text':
        node.textContent = String(value);
        break;
      case 'html':
        node.innerHTML = value;
        break;
      case 'dataset':
        Object.assign(node.dataset, value);
        break;
      case 'style':
        Object.assign(node.style, value);
        break;
      case 'on':
        for (const [type, handler] of Object.entries(value)) node.addEventListener(type, handler);
        break;
      default:
        if (key in node && typeof node[key] !== 'object') node[key] = value;
        else node.setAttribute(key, value);
    }
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/** Replaces a node's children in one go. */
export function replaceChildren(node, ...children) {
  node.replaceChildren(...children.flat().filter(Boolean));
  return node;
}

/** `<option>`s for a `<select>`, from `[value, label]` pairs. */
export function options(entries, selected) {
  return entries.map(([value, label]) =>
    el('option', { value, text: label, selected: value === selected }),
  );
}

/**
 * Announces a message to screen readers without moving focus.
 * One shared live region — several would compete and get truncated.
 */
let liveRegion = null;
export function announce(message, { assertive = false } = {}) {
  if (!liveRegion) {
    liveRegion = el('div.visually-hidden', { 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.append(liveRegion);
  }
  liveRegion.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
  // Clearing first forces a re-announcement of an identical message.
  liveRegion.textContent = '';
  requestAnimationFrame(() => {
    liveRegion.textContent = message;
  });
}
