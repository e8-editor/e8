// The syntax tree of an Org document, after org-element-ast.el: what
// org-element-parse-buffer returns and Org's exporter walks.
//
// A node is an element or an object, with its type, its properties and
// its contents. Plain text is a JavaScript string in its parent's contents
// (Org's plain-text type), so it carries no parent of its own: the walking
// functions here pass a string's parent beside it.

/** An element, an object, or plain text. */
export type Datum = Node | string;

export interface Node {
  /** The node's type, as Org names it: "headline", "paragraph", "bold", "link", ..., and "org-data" for the document. */
  type: string;
  /**
   * The node's properties, named as Org names them without the colon:
   * "begin", "end", "contents-begin", "contents-end", "post-blank" and
   * "post-affiliated" for every node that has them, positions counted as
   * e8 counts them (characters from 0); then the type's own, as a
   * headline's "raw-value", "level", "todo-keyword" and "tags", its node
   * properties by their upper-case names ("CUSTOM_ID"), and an element's
   * affiliated keywords ("name", "caption", "attr_html"). A secondary
   * string, as a headline's "title", is an array of data whose parent is
   * the node. Absent properties are undefined, as nil in Org.
   */
  p: { [name: string]: any };
  /** The node's contents: elements, objects and strings, in order. */
  contents: Datum[];
  /** The node that contains it, or whose secondary string it is in. */
  parent?: Node;
}

/** The types of elements, as org-element-all-elements. */
export const ALL_ELEMENTS = [
  "babel-call", "center-block", "clock", "comment", "comment-block", "diary-sexp", "drawer",
  "dynamic-block", "example-block", "export-block", "fixed-width", "footnote-definition",
  "headline", "horizontal-rule", "inlinetask", "item", "keyword", "latex-environment",
  "node-property", "paragraph", "plain-list", "planning", "property-drawer", "quote-block",
  "section", "special-block", "src-block", "table", "table-row", "verse-block",
];

/** The elements that contain elements, as org-element-greater-elements. */
export const GREATER_ELEMENTS = [
  "center-block", "drawer", "dynamic-block", "footnote-definition", "headline", "inlinetask",
  "item", "plain-list", "property-drawer", "quote-block", "section", "special-block", "table",
  "org-data",
];

/** The types of objects, as org-element-all-objects. */
export const ALL_OBJECTS = [
  "bold", "citation", "citation-reference", "code", "entity", "export-snippet",
  "footnote-reference", "inline-babel-call", "inline-src-block", "italic", "line-break",
  "latex-fragment", "link", "macro", "radio-target", "statistics-cookie", "strike-through",
  "subscript", "superscript", "table-cell", "target", "timestamp", "underline", "verbatim",
];

/** The objects that contain objects, as org-element-recursive-objects. */
export const RECURSIVE_OBJECTS = [
  "bold", "citation", "footnote-reference", "italic", "link", "subscript", "radio-target",
  "strike-through", "superscript", "table-cell", "underline",
];

/** The types whose contents are objects, as org-element-object-containers. */
export const OBJECT_CONTAINERS = [...RECURSIVE_OBJECTS, "paragraph", "table-row", "verse-block"];

/** Each type's secondary strings, as org-element-secondary-value-alist. */
export const SECONDARY_VALUES: { [type: string]: string[] } = {
  citation: ["prefix", "suffix"],
  headline: ["title"],
  inlinetask: ["title"],
  item: ["tag"],
  "citation-reference": ["prefix", "suffix"],
};

/** The affiliated keywords whose value is parsed, as org-element-parsed-keywords, by property. */
export const PARSED_KEYWORD_PROPERTIES = ["caption"];

/** A datum's type, as org-element-type: "plain-text" for a string. */
export function typeOf(d: Datum | undefined): string | undefined {
  if (d === undefined) return undefined;
  return typeof d === "string" ? "plain-text" : d.type;
}

/** Whether a datum is an object rather than an element, as org-element-class: plain text is an object. */
export function isObject(d: Datum, parent?: Node): boolean {
  if (typeof d === "string") return true;
  if (d.type === "org-data") return false;
  if (ALL_OBJECTS.includes(d.type)) return true;
  if (ALL_ELEMENTS.includes(d.type)) return false;
  // A node of an unknown type, as one a backend makes, takes its parent's
  // class, as org-element-class reads it.
  const up = parent ?? d.parent;
  if (!up) return false;
  return OBJECT_CONTAINERS.includes(up.type) || isObject(up);
}

/** A property of a datum, as org-element-property: undefined for plain text, which has none here. */
export function property(name: string, d: Datum | undefined): any {
  return d === undefined || typeof d === "string" ? undefined : d.p[name];
}

/** Set a property, as org-element-put-property. */
export function putProperty(d: Node, name: string, value: any): Node {
  d.p[name] = value;
  return d;
}

export function begin(d: Datum | undefined): number | undefined {
  return property("begin", d);
}

export function end(d: Datum | undefined): number | undefined {
  return property("end", d);
}

export function contentsBegin(d: Datum | undefined): number | undefined {
  return property("contents-begin", d);
}

export function contentsEnd(d: Datum | undefined): number | undefined {
  return property("contents-end", d);
}

/** The blank lines or spaces after a datum, as org-element-post-blank: 0 when it has none. */
export function postBlank(d: Datum | undefined): number {
  return property("post-blank", d) ?? 0;
}

export function postAffiliated(d: Datum | undefined): number | undefined {
  return property("post-affiliated", d);
}

/** A datum's contents, as org-element-contents: none for plain text. */
export function contents(d: Datum | undefined): Datum[] {
  return d === undefined || typeof d === "string" ? [] : d.contents;
}

/** Make a node, as org-element-create, its children adopted. */
export function create(type: string, p: { [name: string]: any } = {}, ...children: Datum[]): Node {
  const node: Node = { type, p, contents: [] };
  adoptElements(node, ...children);
  return node;
}

/** Append children to a node's contents, as org-element-adopt: each node among them takes it as parent. */
export function adoptElements(parent: Node, ...children: Datum[]): Node {
  for (const c of children) {
    if (typeof c !== "string") c.parent = parent;
    parent.contents.push(c);
  }
  return parent;
}

/** Set a node's contents, as org-element-set-contents. */
export function setContents(parent: Node, ...children: Datum[]): Node {
  parent.contents = [];
  return adoptElements(parent, ...children);
}

/**
 * Take a datum out of its parent, as org-element-extract: out of its
 * contents, or out of the secondary string it is in. A string needs its
 * parent given.
 */
export function extract(d: Datum, parent?: Node): Datum {
  const up = parent ?? (typeof d === "string" ? undefined : d.parent);
  if (!up) return d;
  const i = up.contents.indexOf(d);
  if (i >= 0) up.contents.splice(i, 1);
  else
    for (const name of SECONDARY_VALUES[up.type] ?? []) {
      const s = up.p[name];
      const j = Array.isArray(s) ? s.indexOf(d) : -1;
      if (j >= 0) {
        s.splice(j, 1);
        break;
      }
    }
  if (typeof d !== "string") d.parent = undefined;
  return d;
}

/** Put a datum before another in its parent, as org-element-insert-before. */
export function insertBefore(d: Datum, location: Datum, parent?: Node): Datum {
  const up = parent ?? (typeof location === "string" ? undefined : location.parent);
  if (!up) return d;
  let list = up.contents;
  let i = list.indexOf(location);
  if (i < 0)
    for (const name of SECONDARY_VALUES[up.type] ?? []) {
      const s = up.p[name];
      const j = Array.isArray(s) ? s.indexOf(location) : -1;
      if (j >= 0) {
        list = s;
        i = j;
        break;
      }
    }
  list.splice(Math.max(i, 0), 0, d);
  if (typeof d !== "string") d.parent = up;
  return d;
}

/** Put a datum in another's place, as org-element-set: it takes the place in its parent's contents or secondary string. */
export function replace(old: Datum, d: Datum, parent?: Node): Datum {
  const up = parent ?? (typeof old === "string" ? undefined : old.parent);
  if (!up) return d;
  let list = up.contents;
  let i = list.indexOf(old);
  if (i < 0)
    for (const name of SECONDARY_VALUES[up.type] ?? []) {
      const s = up.p[name];
      const j = Array.isArray(s) ? s.indexOf(old) : -1;
      if (j >= 0) {
        list = s;
        i = j;
        break;
      }
    }
  if (i >= 0) list[i] = d;
  if (typeof d !== "string") d.parent = up;
  if (typeof old !== "string") old.parent = undefined;
  return d;
}

/**
 * A datum's ancestors, closest first, as org-element-lineage, its own self
 * first with `withSelf`; with `types`, only the first of them of one of
 * those types.
 */
export function lineage(d: Datum | undefined, types?: string[], withSelf?: false, parent?: Node): Node[];
export function lineage(d: Datum | undefined, types: string[] | undefined, withSelf: true, parent?: Node): Datum[];
export function lineage(d: Datum | undefined, types?: string[], withSelf = false, parent?: Node): Datum[] {
  const out: Datum[] = [];
  if (d === undefined) return out;
  if (withSelf) out.push(d);
  let up = parent ?? (typeof d === "string" ? undefined : d.parent);
  while (up) {
    out.push(up);
    up = up.parent;
  }
  return types ? out.filter((x) => types.includes(typeOf(x)!)) : out;
}

/** The first ancestor of one of `types`, as org-element-lineage with TYPES, or undefined. */
export function ancestor(d: Datum | undefined, types: string[], withSelf = false, parent?: Node): Datum | undefined {
  return lineage(d, types, withSelf as true, parent)[0];
}

/** The datum's parent, as org-element-parent; a string's must be known by the caller. */
export function parentOf(d: Datum | undefined): Node | undefined {
  return d === undefined || typeof d === "string" ? undefined : d.parent;
}

/** Thrown by a map function, as Org's `:org-element-skip`, not to walk into the datum. */
export const SKIP = Symbol("org-element-skip");

export interface MapOptions {
  /** Data to skip with their contents, as an export's :ignore-list. */
  ignore?: Set<Datum> | Datum[];
  /** Stop at the first datum the function returns a value for, and return that value. */
  firstMatch?: boolean;
  /** Types not to walk into, though the function still applies to them. */
  noRecursion?: string[];
  /** Walk into parsed affiliated keywords, as a caption, too. */
  withAffiliated?: boolean;
}

/**
 * Call `fun` on each datum of `types` in `data`, in order, as
 * org-element-map: types "t" (any type) or a list; `fun` takes the datum
 * and, for a string, its parent, and what it returns other than undefined
 * (and false and null) is collected. When the types are all elements, it
 * does not walk into objects.
 */
export function map<T>(
  data: Datum | Datum[] | undefined,
  types: string | string[] | true,
  fun: (d: Datum, parent: Node | undefined) => T | undefined | false | null,
  opts: MapOptions = {},
): T[] {
  const result: T[] = [];
  if (data === undefined) return result;
  const typeList = types === true ? true : Array.isArray(types) ? types : [types];
  const objects = typeList === true || typeList.some((t) => t === "plain-text" || ALL_OBJECTS.includes(t));
  const noRecursion = new Set<string>(opts.noRecursion ?? []);
  if (!objects) {
    for (const t of ALL_OBJECTS) noRecursion.add(t);
    for (const t of ALL_ELEMENTS) if (!GREATER_ELEMENTS.includes(t)) noRecursion.add(t);
  }
  const ignore = opts.ignore instanceof Set ? opts.ignore : opts.ignore ? new Set(opts.ignore) : undefined;
  let done = false;
  const walk = (d: any, parent: Node | undefined): void => {
    if (done || d === undefined || d === null || d === false) return;
    if (Array.isArray(d)) {
      for (const x of d) walk(x, parent);
      return;
    }
    if (typeof d === "object" && !("type" in d) && "value" in d) {
      // A dual keyword's entry: its value, then its secondary value.
      walk(d.value, parent);
      walk(d.secondary, parent);
      return;
    }
    if (typeof d !== "string" && (typeof d !== "object" || !("type" in d))) return;
    if (ignore?.has(d)) return;
    const type = typeOf(d)!;
    let recurse = true;
    if (typeList === true || typeList.includes(type)) {
      let value;
      try {
        value = fun(d, parent);
      } catch (e) {
        if (e !== SKIP) throw e;
        recurse = false;
      }
      if (value !== undefined && value !== false && value !== null) {
        result.push(value as T);
        if (opts.firstMatch) {
          done = true;
          return;
        }
      }
    }
    if (!recurse || typeof d === "string" || noRecursion.has(type)) return;
    if (opts.withAffiliated && objects) for (const name of PARSED_KEYWORD_PROPERTIES) walk(d.p[name], d);
    if (objects) for (const name of SECONDARY_VALUES[type] ?? []) walk(d.p[name], d);
    for (const c of d.contents) walk(c, d);
  };
  walk(data, typeof data === "string" || Array.isArray(data) ? undefined : (data as Node).parent);
  return result;
}

/** The first value `fun` returns for a datum of `types`, as org-element-map with FIRST-MATCH. */
export function mapFirst<T>(
  data: Datum | Datum[] | undefined,
  types: string | string[] | true,
  fun: (d: Datum, parent: Node | undefined) => T | undefined | false | null,
  opts: MapOptions = {},
): T | undefined {
  return map(data, types, fun, { ...opts, firstMatch: true })[0];
}

/** A deep copy of a datum, as org-element-copy with no parent, its children's parents the copies. */
export function copy<T extends Datum>(d: T, deep = true): T {
  if (typeof d === "string") return d;
  const node = d as Node;
  const out: Node = { type: node.type, p: { ...node.p }, contents: [] };
  if (deep) {
    for (const name of SECONDARY_VALUES[node.type] ?? []) {
      const s = node.p[name];
      if (Array.isArray(s)) out.p[name] = s.map((x) => withParent(copy(x), out));
    }
    out.contents = node.contents.map((c) => withParent(copy(c), out));
  }
  return out as T;
}

function withParent(d: Datum, parent: Node): Datum {
  if (typeof d !== "string") d.parent = parent;
  return d;
}
