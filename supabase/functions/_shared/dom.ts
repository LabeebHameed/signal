// A deliberately tiny DOM facade for _shared/cards.ts.
//
// This is the codebase's only external runtime dependency, and it earns its
// place: card extraction is entirely a question of element structure (which
// anchors sit inside which repeated container), and the regex flattening used
// everywhere else in this codebase destroys exactly that. Everything below
// exists so the dependency stays behind one seam — cards.ts never imports
// deno_dom, so swapping in a hand-rolled tokenizer later touches only this
// file.
//
// The tree is re-materialized into plain objects rather than passing deno_dom
// Elements around, for three reasons: text content is computed once bottom-up
// (naive repeated textContent over a listing page is quadratic), `parent`
// links are needed to walk upward to a wrapping <a>, and the class attribute
// is normalized once into the form group signatures compare on.

import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

/** Elements whose text is never page content and must never reach a title. */
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "path", "iframe"]);

export interface DomElement {
  /** Lowercased tag name. */
  tag: string;
  /** Class tokens, sorted and space-joined — the canonical form sibling
   * grouping compares on, so attribute order never affects a signature. */
  classes: string;
  href: string | null;
  parent: DomElement | null;
  children: DomElement[];
  /** Whitespace-collapsed text of this element and all its descendants,
   * computed once during construction. */
  text: string;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Parse HTML into the facade tree. Returns null when the document has no
 * root element at all (an empty or wholly unparseable body) — callers treat
 * that the same as "no cards found".
 */
export function parseHtml(html: string): DomElement | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc?.documentElement;
  if (!root) return null;
  return build(root, null);
}

// deno_dom's Node type constants; referenced numerically so this file needs
// no type import beyond DOMParser itself.
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// deno_dom's Element, structurally typed to what's used here — avoids
// importing its class type and keeps the seam narrow.
interface RawNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  /** Iterable, not an array — deno_dom returns a NodeList here. */
  childNodes: Iterable<RawNode>;
  getAttribute?(name: string): string | null;
}

function build(node: RawNode, parent: DomElement | null): DomElement {
  const tag = node.nodeName.toLowerCase();
  const rawClass = node.getAttribute?.("class") ?? "";
  const el: DomElement = {
    tag,
    classes: rawClass.split(/\s+/).filter(Boolean).sort().join(" "),
    href: node.getAttribute?.("href") ?? null,
    parent,
    children: [],
    text: "",
  };

  // Text is accumulated as the children are built, so each node's content is
  // assembled exactly once on the way back up.
  const parts: string[] = [];
  for (const child of node.childNodes) {
    if (child.nodeType === TEXT_NODE) {
      if (child.nodeValue) parts.push(child.nodeValue);
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    if (SKIP_TAGS.has(child.nodeName.toLowerCase())) continue;
    const built = build(child, el);
    el.children.push(built);
    parts.push(built.text);
  }
  el.text = collapse(parts.join(" "));
  return el;
}

/** Depth-first walk over an element and all its descendants. */
export function* walk(el: DomElement): Generator<DomElement> {
  yield el;
  for (const child of el.children) yield* walk(child);
}

/** Walk upward from an element through its ancestors. */
export function* ancestors(el: DomElement): Generator<DomElement> {
  let p = el.parent;
  while (p !== null) {
    yield p;
    p = p.parent;
  }
}
