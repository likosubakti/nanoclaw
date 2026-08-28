/** Tiny element builder. Enough structure for this UI without a framework. */

type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  id?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  rows?: number;
  min?: string;
  max?: string;
  step?: string;
  href?: string;
  /** data-* and aria-* attributes. */
  attrs?: Record<string, string | number | boolean | undefined>;
  style?: Partial<CSSStyleDeclaration>;
  on?: Partial<{
    [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void;
  }>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;

  for (const key of ['type', 'value', 'placeholder', 'rows', 'min', 'max', 'step', 'href'] as const) {
    const value = props[key];
    if (value !== undefined) (el as any)[key] = value;
  }
  if (props.disabled !== undefined) (el as any).disabled = props.disabled;
  if (props.checked !== undefined) (el as any).checked = props.checked;

  if (props.attrs) {
    for (const [name, value] of Object.entries(props.attrs)) {
      if (value === undefined || value === false) continue;
      el.setAttribute(name, String(value));
    }
  }
  if (props.style) Object.assign(el.style, props.style);
  if (props.on) {
    for (const [event, handler] of Object.entries(props.on)) {
      el.addEventListener(event, handler as EventListener);
    }
  }

  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Inline SVG icons, drawn from a 24×24 grid. */
export function icon(name: keyof typeof PATHS, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  for (const d of PATHS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

const PATHS = {
  chat: ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z'],
  terminal: ['M4 5h16v14H4z', 'M8 10l2.5 2L8 14', 'M13 15h4'],
  key: ['M15 7a4 4 0 1 1-3.5 5.9L4 20l1.5 1.5', 'M8 17l2-2'],
  plus: ['M12 5v14', 'M5 12h14'],
  send: ['M4 12l16-8-6 8 6 8z'],
  stop: ['M6 6h12v12H6z'],
  trash: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  ],
  check: ['M20 6L9 17l-5-5'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z'],
  external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'],
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  download: ['M12 3v12', 'M7 11l5 5 5-5', 'M4 21h16'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  users: [
    'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20',
    'M10 11.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5z',
    'M20 20v-1.5a3.5 3.5 0 0 0-2.6-3.38',
    'M15.5 5.2a3.25 3.25 0 0 1 0 6.1',
  ],
} as const;

/**
 * A model <select> grouped by tier.
 *
 * Roundtable seats each pick their own model, so the grouping is the point:
 * it makes "flagship in the chair that decides, something cheap in the seats
 * that only need an opinion" a one-glance decision rather than a lookup.
 */
export function modelSelect(
  groups: Array<{ tier: string; models: Array<{ id: string; label: string; note?: string }> }>,
  selected: string,
  onChange: (id: string) => void,
  props: Props = {},
): HTMLSelectElement {
  const select = h('select', { ...props, on: { ...props.on } });

  // A model saved earlier, or typed by hand, must stay selectable even when it
  // is not in any group.
  const known = groups.some((g) => g.models.some((m) => m.id === selected));
  if (selected && !known) {
    const group = document.createElement('optgroup');
    group.label = 'Current';
    group.appendChild(h('option', { value: selected, text: selected, attrs: { selected: true } }));
    select.appendChild(group);
  }

  for (const { tier, models } of groups) {
    const group = document.createElement('optgroup');
    group.label = tier;
    for (const model of models) {
      group.appendChild(
        h('option', {
          value: model.id,
          text: model.label,
          attrs: { selected: model.id === selected, title: model.note ?? '' },
        }),
      );
    }
    select.appendChild(group);
  }

  select.addEventListener('change', () => onChange(select.value));
  return select;
}
