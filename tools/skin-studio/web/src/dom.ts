/** `document.querySelector` for elements the page is known to contain. */
export const $ = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

/** Creates an element with properties and children (falsy children are skipped). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) node.className = className;
  Object.assign(node, rest);
  node.append(...children.filter((c): c is Node | string => !!c));
  return node;
}

/**
 * A help hover: the focusable (i) that carries `tip` (shown on hover and
 * keyboard focus, read by assistive technology). `pos` keeps the tip inside
 * the screen near an edge.
 */
export function helpTip(tip: string, pos?: "left" | "right") {
  const el = h("span", { class: "v-help", tabIndex: 0, role: "img", ariaLabel: tip });
  el.dataset.tip = tip;
  if (pos) el.dataset.tipPos = pos;
  return el;
}
