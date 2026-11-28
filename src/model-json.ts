/**
 * Bounded syntax-only recovery of a single model response.
 * No guessing missing values, closing truncated containers, or selecting
 * one of several objects. Duplicate keys are rejected even in valid JSON.
 */
export function parseModelJSON(raw: string): { value: unknown; repairs: string[] } {
  const fail = (): never => { throw new SyntaxError("Invalid or ambiguous model JSON"); };
  if (raw.length > 128_000) fail();
  const repairs = new Set<string>();
  let text = raw.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(text);
  if (fenced) { text = fenced[1]; repairs.add("code-fence"); }
  // Tokenize with an anchored matcher. JSON strings are decoded by JSON.parse,
  // never edited by a regex; a comma or brace in a string stays literal.
  const token = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[{}\[\]:,]/y;
  const space = /[ \t\r\n]*/y;
  let pos = 0;
  let look: string | undefined;
  function next(): string {
    space.lastIndex = pos;
    space.exec(text);
    pos = space.lastIndex;
    if (pos === text.length) return "";
    token.lastIndex = pos;
    const m = token.exec(text);
    if (!m) return fail();
    pos = token.lastIndex;
    return m[0];
  }
  function peek(): string { return look ?? (look = next()); }
  function take(): string { const t = peek(); look = undefined; return t; }
  function expect(t: string) { if (take() !== t) fail(); }
  function value(depth: number): unknown {
    if (depth > 64) fail();
    const t = take();
    if (t === "{") {
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      if (peek() === "}") { take(); return result; }
      for (;;) {
        const k = take();
        const key: string = k.startsWith('"') ? JSON.parse(k)
          : /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? (repairs.add("unquoted-key"), k) : fail();
        if (keys.has(key)) fail();
        keys.add(key);
        expect(":");
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        const delimiter = take();
        if (delimiter === "}") return result;
        if (delimiter !== ",") fail();
        if (peek() === "}") { take(); repairs.add("trailing-comma"); return result; }
      }
    }
    if (t === "[") {
      const result: unknown[] = [];
      if (peek() === "]") { take(); return result; }
      for (;;) {
        result.push(value(depth + 1));
        const delimiter = take();
        if (delimiter === "]") return result;
        if (delimiter !== ",") fail();
        if (peek() === "]") { take(); repairs.add("trailing-comma"); return result; }
      }
    }
    if (t.startsWith('"') || t === "true" || t === "false" || t === "null") return JSON.parse(t);
    if (/^-?\d/.test(t)) {
      const n = JSON.parse(t);
      if (!Number.isFinite(n)) fail();
      return n;
    }
    return fail();
  }
  const parsed = value(0);
  if (peek() !== "" || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail();
  return { value: repairs.size ? parsed : JSON.parse(raw), repairs: [...repairs] };
}
