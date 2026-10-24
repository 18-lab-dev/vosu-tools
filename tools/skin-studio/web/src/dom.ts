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
