export type CompOp = "=" | "<" | ">" | "<=" | ">=";
export type RerollCondition = { op: CompOp; value: number };
export type CritCondition = { op: CompOp; value: number };
export type ExplodeMode = "normal" | "compound" | "penetrating";

export type MatchSpec = {
  /** "show": visual highlight only, total unchanged. "tally": total = number of matched groups (mt). */
  kind: "show" | "tally";
  /** Minimum number of dice with the same face value required to count as a match. Default 2. */
  minMatches: number;
  /** Optional condition the matched value must satisfy (e.g. mt3>4). */
  targetCondition?: { op: CompOp; value: number };
};

export type DiceTerm =
  | { type: "standard"; count: number; sides: number; computedCount?: DiceNode; computedSides?: DiceNode; keep?: { mode: "h" | "l"; count: number }; reroll?: { conditions: RerollCondition[]; once: boolean }; critSuccess?: CritCondition[]; critFail?: CritCondition[]; explode?: { mode: ExplodeMode; condition?: RerollCondition }; successThreshold?: { op: "<" | ">" | "<=" | ">="; value: number }; failureThreshold?: { op: CompOp; value: number }; sort?: "asc" | "desc"; matches?: MatchSpec }
  | { type: "fate"; count: number; computedCount?: DiceNode }
  | { type: "pool"; count: number; faces: number[] }
  | { type: "table"; count: number; entries: string[] }
  | { type: "constant"; value: number };

export type Operator = "+" | "-" | "*" | "/" | "%" | "**";
export type MathFn = "floor" | "round" | "ceil" | "abs";

export type DiceNode =
  | { type: "term"; term: DiceTerm; inlineLabel?: string }
  | { type: "binary"; op: Operator; left: DiceNode; right: DiceNode }
  | { type: "fn"; fn: MathFn; arg: DiceNode }
  | { type: "negate"; arg: DiceNode }
  | { type: "group"; members: DiceNode[]; keep?: { mode: "h" | "l"; count: number }; drop?: { mode: "h" | "l"; count: number }; successThreshold?: { op: "<" | ">" | "<=" | ">="; value: number }; failureThreshold?: { op: CompOp; value: number } };

export interface DiceExpression {
  root: DiceNode;
  /** Expression-level success threshold: compare the total to this value (>= for ">", <= for "<"). */
  successThreshold?: { op: "<" | ">" | "<=" | ">="; value: number };
}

export interface TermResult {
  rolls: (number | string)[];
  kept: (number | string)[];
  total: number;
  label: string;
  inlineLabel?: string;
  /** Lowest possible face value; null for constants/tables (no highlighting). */
  minFace: number | null;
  /** Highest possible face value; null for constants/tables (no highlighting). */
  maxFace: number | null;
  /** For rerolled dice, the original value before rerolling, parallel to rolls[]. */
  rerolledFrom?: (number | undefined)[];
  /** Per-roll crit status parallel to rolls[]. Defined only when cs/cf conditions exist. */
  critStatus?: ("success" | "fail" | null)[];
  /** True if any kept die satisfied a critSuccess condition. */
  anyCritSuccess?: boolean;
  /** True if any kept die satisfied a critFail condition. */
  anyCritFail?: boolean;
  /** Operator connecting this term to the previous one in the expression (e.g. "/" for a divisor). */
  operatorPrefix?: Operator;
  /**
   * For exploding dice: the roll chain for each die in rolls[], parallel to rolls[].
   * Each entry is an array of individual rolls that were summed to produce rolls[i],
   * or undefined if that die did not explode. Present only when term.explode is set.
   */
  explosionChains?: (number[] | undefined)[];
  /** When set, total is the count of kept dice meeting the threshold (>= for ">", <= for "<"). */
  successThreshold?: { op: "<" | ">" | "<=" | ">="; value: number };
  /** Which kept dice met the success threshold. Parallel to kept[]. */
  successMet?: boolean[];
  /** Raw count of successes before subtracting failures. Only set when failureThreshold is also present. */
  successCount?: number;
  /** Failure threshold (subtracts matching dice from successThreshold count). */
  failureThreshold?: { op: CompOp; value: number };
  /** Which rolls met the failure threshold. Parallel to rolls[]. */
  failureMet?: boolean[];
  /** Count of kept dice meeting the failure threshold. */
  failureCount?: number;
  /** Match spec copied from the term (when m/mt was used). */
  matches?: MatchSpec;
  /** Distinct kept face values that satisfied the match spec, sorted ascending. */
  matchedValues?: number[];
  /** Number of matched groups (== matchedValues.length). For mt this is also the term total. */
  matchCount?: number;
}

export interface GroupMember {
  terms: TermResult[];
  total: number;
  kept: boolean;
}

export interface GroupResult {
  /**
   * "individual": no-comma syntax - keep picks from individual dice values across one expression.
   * "sum": comma syntax - keep picks from per-member sums.
   */
  keepMode: "individual" | "sum";
  keep?: { mode: "h" | "l"; count: number };
  drop?: { mode: "h" | "l"; count: number };
  /** When set, total is the count of dice/members meeting this threshold rather than a sum. */
  successThreshold?: { op: "<" | ">" | "<=" | ">="; value: number };
  successCount?: number;
  /** Failure threshold (subtracts matching dice/members from successCount). */
  failureThreshold?: { op: CompOp; value: number };
  failureCount?: number;
  members: GroupMember[];
  /** individual mode only: the actual selected dice values after keeping */
  keptValues?: number[];
  total: number;
}

export interface RollResult {
  terms: TermResult[];
  groups?: GroupResult[];
  total: number;
  /** Maximum possible total for this expression; null for table-only rolls or complex expressions. */
  maxTotal: number | null;
  /** Minimum possible total for this expression; null for table-only rolls or complex expressions. */
  minTotal: number | null;
  expression: string;
  /** Overall roll label, e.g. "Roll for Initiative". */
  label?: string;
  /** Rounding annotations from floor/ceil/round in the expression (e.g. "rounded down: 4.5 → 4"). */
  annotations?: string[];
  /** Expression-level success threshold (e.g. from "1d20+13>21"). total is the raw sum; successCount is 0 or 1. */
  successThreshold?: { op: "<" | ">" | "<=" | ">="; value: number };
  successCount?: number;
}

// --- Tokenizer ---

type Token =
  | { kind: "atom"; value: string }
  | { kind: "op"; value: Operator }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "lbrace" }
  | { kind: "rbrace" }
  | { kind: "comma" }
  | { kind: "cmp"; value: "<" | ">" | "<=" | ">=" };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === "(") { tokens.push({ kind: "lparen" }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen" }); i++; continue; }
    if (ch === "{") { tokens.push({ kind: "lbrace" }); i++; continue; }
    if (ch === "}") { tokens.push({ kind: "rbrace" }); i++; continue; }
    if (ch === ",") { tokens.push({ kind: "comma" }); i++; continue; }
    if (ch === "+") { tokens.push({ kind: "op", value: "+" }); i++; continue; }
    if (ch === "-") { tokens.push({ kind: "op", value: "-" }); i++; continue; }
    if (ch === "%") { tokens.push({ kind: "op", value: "%" }); i++; continue; }
    if (ch === "/") { tokens.push({ kind: "op", value: "/" }); i++; continue; }
    if (ch === "*") {
      if (input[i + 1] === "*") { tokens.push({ kind: "op", value: "**" }); i += 2; }
      else { tokens.push({ kind: "op", value: "*" }); i++; }
      continue;
    }
    // < and > are only part of an atom when the atom already contains a 'd' (dice notation).
    // Standalone < and > (and <= >= ≤ ≥) become cmp tokens for expression-level / group success thresholds.
    if (ch === "<" || ch === ">" || ch === "≤" || ch === "≥") {
      if (ch === "≤") { tokens.push({ kind: "cmp", value: "<=" }); i++; }
      else if (ch === "≥") { tokens.push({ kind: "cmp", value: ">=" }); i++; }
      else if (i + 1 < input.length && input[i + 1] === "=") { tokens.push({ kind: "cmp", value: (ch + "=") as "<=" | ">=" }); i += 2; }
      else { tokens.push({ kind: "cmp", value: ch as "<" | ">" }); i++; }
      continue;
    }
    if (/[a-zA-Z0-9.!]/.test(ch)) {
      let atom = "";
      while (i < input.length) {
        const c = input[i];
        if (/[a-zA-Z0-9.!]/.test(c)) { atom += c; i++; }
        // Allow < > <= >= ≤ ≥ within the atom only after a 'd' has appeared (e.g. r>3, cs<=5, !>=4)
        else if ((c === "<" || c === ">" || c === "≤" || c === "≥") && /d/i.test(atom)) {
          if (c === "≤") { atom += "<="; i++; }
          else if (c === "≥") { atom += ">="; i++; }
          else { atom += c; i++; if (i < input.length && input[i] === "=") { atom += "="; i++; } }
        }
        // Absorb a balanced (...) group into the atom when it directly follows the
        // 'd' of a dice prefix - this is computed-sides notation, e.g. 2d(3+3).
        // Restricted to atoms matching `\d*d$` so function names like `round` (also
        // ending in d) and other letter-prefixed atoms are not affected.
        else if (c === "(" && /^\d*d$/i.test(atom)) {
          let depth = 0;
          while (i < input.length) {
            if (input[i] === "(") depth++;
            else if (input[i] === ")") depth--;
            atom += input[i++];
            if (depth === 0) break;
          }
        }
        else break;
      }
      // Consume bracket groups: pool/table dice (1d[fire,ice]) and inline labels (2d6[Fire])
      while (i < input.length && input[i] === "[") {
        let depth = 0;
        while (i < input.length) {
          if (input[i] === "[") depth++;
          else if (input[i] === "]") depth--;
          atom += input[i++];
          if (depth === 0) break;
        }
      }
      tokens.push({ kind: "atom", value: atom });
      continue;
    }
    throw new Error(`Unexpected character "${ch}" in dice expression`);
  }
  return tokens;
}

// --- Parser ---

/**
 * Split notation into formula and optional overall label.
 *
 * Explicit separator: `1d20+5 \ +5 for initiative`
 * Implicit:          `1d20+5 Roll for Initiative`
 *   - first top-level space where the following text doesn't look like a
 *     formula continuation (operator, digit, parenthesis, or function name).
 */
export function splitFormulaLabel(notation: string): { formula: string; label?: string } {
  const bsIdx = notation.indexOf("\\");
  if (bsIdx !== -1) {
    return {
      formula: notation.slice(0, bsIdx).trim(),
      label: notation.slice(bsIdx + 1).trim() || undefined,
    };
  }

  let bracketDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < notation.length; i++) {
    const ch = notation[i];
    if (ch === "[") { bracketDepth++; continue; }
    if (ch === "]") { bracketDepth--; continue; }
    if (ch === "{") { braceDepth++; continue; }
    if (ch === "}") { braceDepth--; continue; }
    if (bracketDepth > 0 || braceDepth > 0 || ch !== " ") continue;

    const after = notation.slice(i).trimStart();
    if (!after) break;
    if (/^[+\-*\/%(\d{]/.test(after)) continue;
    if (/^d(\d|[fF]|\[)/i.test(after)) continue;
    if (/^(floor|round|ceil|abs)\s*\(/i.test(after)) continue;

    return { formula: notation.slice(0, i).trim(), label: after };
  }

  return { formula: notation.trim() };
}

/**
 * Extract a trailing `[inline label]` from a token, but only when the
 * character before `[` is NOT `d`/`D` (which would make it a pool/table).
 *
 * `2d10[Fire Damage]`  → termStr="2d10",        inlineLabel="Fire Damage"
 * `1d[fire,ice]`       → termStr="1d[fire,ice]", inlineLabel=undefined
 * `4d6kh3[Stat Roll]`  → termStr="4d6kh3",       inlineLabel="Stat Roll"
 */
function extractInlineLabel(s: string): { termStr: string; inlineLabel?: string } {
  const m = /^(.*[^dD])\[([^\]]+)\]$/.exec(s);
  if (m) return { termStr: m[1], inlineLabel: m[2].trim() || undefined };
  return { termStr: s };
}

const FATE_RE = /^(\d*)d[Ff]$/;
const BRACKET_RE = /^(\d*)d\[([^\]]+)\]$/i;
const CONST_RE = /^-?\d+(\.\d+)?$/;

function parseDiceTerm(s: string): DiceTerm {
  let m: RegExpMatchArray | null;

  if ((m = FATE_RE.exec(s))) {
    const count = m[1] ? parseInt(m[1], 10) : 1;
    return { type: "fate", count };
  }

  if ((m = BRACKET_RE.exec(s))) {
    const count = m[1] ? parseInt(m[1], 10) : 1;
    const raw = m[2].split(",").map((e) => e.trim()).filter((e) => e.length > 0);
    if (raw.length === 0) throw new Error(`Empty bracket expression in: "${s}"`);
    const numeric = raw.map((e) => parseFloat(e));
    if (numeric.every((n) => !isNaN(n))) {
      return { type: "pool", count, faces: numeric.map(Number) };
    }
    return { type: "table", count, entries: raw };
  }

  if ((m = /^(\d*)d/i.exec(s))) {
    const count = m[1] ? parseInt(m[1], 10) : 1;
    let pos = m[0].length;

    // Sides may be (a) a balanced (...) group already absorbed into the atom by
    // the tokenizer (computed sides, e.g. 2d(3+3)), or (b) the usual digit run.
    let sides = 0;
    let computedSides: DiceNode | undefined;
    if (s[pos] === "(") {
      let depth = 0;
      const start = pos;
      while (pos < s.length) {
        if (s[pos] === "(") depth++;
        else if (s[pos] === ")") depth--;
        pos++;
        if (depth === 0) break;
      }
      if (depth !== 0) throw new Error(`Unbalanced parens in: "${s}"`);
      computedSides = parseDice(s.slice(start + 1, pos - 1)).root;
    } else {
      const sidesMatch = /^(\d+)/.exec(s.slice(pos));
      if (!sidesMatch) throw new Error(`Cannot parse dice term: "${s}"`);
      sides = parseInt(sidesMatch[1], 10);
      pos += sidesMatch[0].length;
    }

    let rest = s.slice(pos);
    let keep: { mode: "h" | "l"; count: number } | undefined;
    const rerollConditions: RerollCondition[] = [];
    let rerollOnce = false;
    const critSuccessConditions: CritCondition[] = [];
    const critFailConditions: CritCondition[] = [];
    let explode: { mode: ExplodeMode; condition?: RerollCondition } | undefined;
    let successThreshold: { op: "<" | ">" | "<=" | ">="; value: number } | undefined;
    let failureThreshold: { op: CompOp; value: number } | undefined;
    let sort: "asc" | "desc" | undefined;
    let matches: MatchSpec | undefined;
    let mod: RegExpMatchArray | null;
    while (rest.length > 0) {
      if ((mod = /^k([hl])(\d+)/i.exec(rest))) {
        keep = { mode: mod[1].toLowerCase() as "h" | "l", count: parseInt(mod[2], 10) };
        rest = rest.slice(mod[0].length);
      } else if ((mod = /^d([hl]?)(\d+)/i.exec(rest))) {
        // drop lowest (dl/d) = keep highest; drop highest (dh) = keep lowest
        const dropDir = mod[1].toLowerCase();
        const dropCount = parseInt(mod[2], 10);
        keep = { mode: dropDir === "h" ? "l" : "h", count: count - dropCount };
        rest = rest.slice(mod[0].length);
      } else if ((mod = /^ro([<>]=?)?(\d+)/i.exec(rest))) {
        rerollOnce = true;
        rerollConditions.push({ op: (mod[1] || "=") as CompOp, value: parseInt(mod[2], 10) });
        rest = rest.slice(mod[0].length);
      } else if ((mod = /^r([<>]=?)?(\d+)/i.exec(rest))) {
        rerollConditions.push({ op: (mod[1] || "=") as CompOp, value: parseInt(mod[2], 10) });
        rest = rest.slice(mod[0].length);
      } else if ((mod = /^cs([<>]=?)?(\d+)/i.exec(rest))) {
        critSuccessConditions.push({ op: (mod[1] || "=") as CompOp, value: parseInt(mod[2], 10) });
        rest = rest.slice(mod[0].length);
      } else if ((mod = /^cf([<>]=?)?(\d+)/i.exec(rest))) {
        critFailConditions.push({ op: (mod[1] || "=") as CompOp, value: parseInt(mod[2], 10) });
        rest = rest.slice(mod[0].length);
      } else if ((mod = /^!!([<>]=?)?(\d*)/.exec(rest))) {
        const condition = mod[2] ? { op: (mod[1] || "=") as CompOp, value: parseInt(mod[2], 10) } : undefined;
        explode = { mode: "compound", ...(condition ? { condition } : {}) };
        rest = rest.slice(mod[0].length);
      } else if ((mod = /^!p([<>]=?)?(\d*)/.exec(rest))) {
        const condition = mod[2] ? { op: (mod[1] || "=") as CompOp, value: parseInt(mod[2], 10) } : undefined;
        explode = { mode: "penetrating", ...(condition ? { condition } : {}) };
        rest = rest.slice(mod[0].length);
      } else if ((mod = /^!([<>]=?)?(\d*)/.exec(rest))) {
        const condition = mod[2] ? { op: (mod[1] || "=") as CompOp, value: parseInt(mod[2], 10) } : undefined;
        explode = { mode: "normal", ...(condition ? { condition } : {}) };
        rest = rest.slice(mod[0].length);
      } else if (/^sd/i.test(rest)) {
        sort = "desc";
        rest = rest.slice(2);
      } else if (/^s/i.test(rest)) {
        sort = "asc";
        rest = rest.slice(1);
      } else if ((mod = /^mt(\d+)?(?:([<>]=?)(\d+))?/i.exec(rest))) {
        // mt = match tally: total becomes count of matched groups.
        // Optional minMatches digit, optional comparator+value target.
        // Must be tested before plain `m` and before the success-threshold branch
        // so `mt3>4` consumes the full modifier rather than splitting on `>4`.
        const minMatches = mod[1] ? parseInt(mod[1], 10) : 2;
        const targetCondition = mod[3] !== undefined ? { op: (mod[2] || "=") as CompOp, value: parseInt(mod[3], 10) } : undefined;
        matches = { kind: "tally", minMatches, ...(targetCondition ? { targetCondition } : {}) };
        rest = rest.slice(mod[0].length);
      } else if ((mod = /^m(\d+)?(?:([<>]=?)(\d+))?/i.exec(rest))) {
        const minMatches = mod[1] ? parseInt(mod[1], 10) : 2;
        const targetCondition = mod[3] !== undefined ? { op: (mod[2] || "=") as CompOp, value: parseInt(mod[3], 10) } : undefined;
        matches = { kind: "show", minMatches, ...(targetCondition ? { targetCondition } : {}) };
        rest = rest.slice(mod[0].length);
      } else if ((mod = /^([<>]=?)(\d+)/.exec(rest))) {
        successThreshold = { op: mod[1] as "<" | ">", value: parseInt(mod[2], 10) };
        rest = rest.slice(mod[0].length);
      } else if ((mod = /^f([<>]=?)?(\d+)/i.exec(rest))) {
        failureThreshold = { op: (mod[1] || "=") as CompOp, value: parseInt(mod[2], 10) };
        rest = rest.slice(mod[0].length);
      } else {
        throw new Error(`Cannot parse dice term: "${s}"`);
      }
    }
    return {
      type: "standard",
      count,
      sides,
      ...(computedSides ? { computedSides } : {}),
      ...(keep ? { keep } : {}),
      ...(rerollConditions.length > 0 ? { reroll: { conditions: rerollConditions, once: rerollOnce } } : {}),
      ...(critSuccessConditions.length > 0 ? { critSuccess: critSuccessConditions } : {}),
      ...(critFailConditions.length > 0 ? { critFail: critFailConditions } : {}),
      ...(explode ? { explode } : {}),
      ...(successThreshold ? { successThreshold } : {}),
      ...(failureThreshold ? { failureThreshold } : {}),
      ...(sort ? { sort } : {}),
      ...(matches ? { matches } : {}),
    };
  }

  if (CONST_RE.test(s)) {
    return { type: "constant", value: parseFloat(s) };
  }

  throw new Error(`Cannot parse dice term: "${s}"`);
}

const MATH_FN_NAMES: readonly string[] = ["floor", "round", "ceil", "abs"];
const KEEP_RE = /^k([hl])(\d+)$/i;
const DROP_RE = /^d([hl]?)(\d+)$/i;

class DiceParser {
  private pos = 0;
  successThreshold?: { op: "<" | ">" | "<=" | ">="; value: number };
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }
  private expectRparen(): void {
    const t = this.advance();
    if (!t || t.kind !== "rparen") throw new Error("Expected ')'");
  }
  private expectRbrace(): void {
    const t = this.advance();
    if (!t || t.kind !== "rbrace") throw new Error("Expected '}'");
  }

  parse(): DiceNode {
    const node = this.parseExpr();
    // Check for expression-level success threshold (e.g. "1d20+13>21")
    if (this.peek()?.kind === "cmp") {
      const cmpTok = this.advance() as { kind: "cmp"; value: "<" | ">" | "<=" | ">=" };
      const numTok = this.peek();
      if (!numTok || numTok.kind !== "atom" || !/^\d+$/.test(numTok.value)) {
        throw new Error(`Expected number after "${cmpTok.value}" in success threshold`);
      }
      this.advance();
      this.successThreshold = { op: cmpTok.value, value: parseInt(numTok.value, 10) };
    }
    if (this.pos < this.tokens.length) throw new Error("Unexpected token after expression");
    return node;
  }

  // Addition and subtraction (lowest precedence)
  private parseExpr(): DiceNode {
    let left = this.parseProduct();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== "op" || (t.value !== "+" && t.value !== "-")) break;
      this.advance();
      left = { type: "binary", op: t.value, left, right: this.parseProduct() };
    }
    return left;
  }

  // Multiplication, division, modulus
  private parseProduct(): DiceNode {
    let left = this.parseExponent();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== "op" || !["*", "/", "%"].includes(t.value)) break;
      this.advance();
      left = { type: "binary", op: t.value as Operator, left, right: this.parseExponent() };
    }
    return left;
  }

  // Exponentiation (right-associative)
  private parseExponent(): DiceNode {
    const base = this.parseUnary();
    const t = this.peek();
    if (t && t.kind === "op" && t.value === "**") {
      this.advance();
      return { type: "binary", op: "**", left: base, right: this.parseExponent() };
    }
    return base;
  }

  // Unary minus
  private parseUnary(): DiceNode {
    const t = this.peek();
    if (t && t.kind === "op" && t.value === "-") {
      this.advance();
      return { type: "negate", arg: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  // Parentheses, function calls, groups, atoms
  private parsePrimary(): DiceNode {
    const t = this.peek();
    if (!t) throw new Error("Unexpected end of expression");

    if (t.kind === "lbrace") {
      this.advance();
      const members: DiceNode[] = [this.parseExpr()];
      while (this.peek()?.kind === "comma") {
        this.advance();
        members.push(this.parseExpr());
      }
      this.expectRbrace();

      // Optional keep / drop / success-threshold modifier immediately after }
      let keep: { mode: "h" | "l"; count: number } | undefined;
      let drop: { mode: "h" | "l"; count: number } | undefined;
      let successThreshold: { op: "<" | ">" | "<=" | ">="; value: number } | undefined;
      let groupFailureThreshold: { op: CompOp; value: number } | undefined;
      const next = this.peek();
      if (next?.kind === "atom") {
        const km = KEEP_RE.exec(next.value);
        if (km) {
          this.advance();
          keep = { mode: km[1].toLowerCase() as "h" | "l", count: parseInt(km[2], 10) };
        } else {
          const dm = DROP_RE.exec(next.value);
          if (dm) {
            this.advance();
            // dl/d → drop lowest; dh → drop highest
            const dropDir = (dm[1] || "l").toLowerCase() as "h" | "l";
            drop = { mode: dropDir, count: parseInt(dm[2], 10) };
          }
        }
      } else if (next?.kind === "cmp") {
        // e.g. {5d6!!}>8 or {3d20+5}>21f<10
        const numTok = this.tokens[this.pos + 1];
        if (numTok?.kind === "atom") {
          // Number token may carry embedded failure: "21f1", "21f", or plain "21"
          const fullFail = /^(\d+)f([<>]=?)?(\d+)$/.exec(numTok.value);
          const partialFail = /^(\d+)f$/.exec(numTok.value);
          const simple = /^(\d+)$/.exec(numTok.value);
          if (fullFail) {
            this.advance(); // consume cmp
            this.advance(); // consume number atom
            successThreshold = { op: next.value, value: parseInt(fullFail[1], 10) };
            groupFailureThreshold = { op: (fullFail[2] || "=") as CompOp, value: parseInt(fullFail[3], 10) };
          } else if (partialFail) {
            this.advance(); // consume cmp
            this.advance(); // consume number+f atom
            successThreshold = { op: next.value, value: parseInt(partialFail[1], 10) };
            // Failure condition is in the next tokens: optional cmp + number
            const failNext = this.peek();
            if (failNext?.kind === "cmp") {
              const failNum = this.tokens[this.pos + 1];
              if (failNum?.kind === "atom" && /^\d+$/.test(failNum.value)) {
                this.advance(); // consume fail cmp
                this.advance(); // consume fail number
                groupFailureThreshold = { op: failNext.value, value: parseInt(failNum.value, 10) };
              }
            } else if (failNext?.kind === "atom" && /^\d+$/.test(failNext.value)) {
              this.advance();
              groupFailureThreshold = { op: "=", value: parseInt(failNext.value, 10) };
            }
          } else if (simple) {
            this.advance(); // consume cmp
            this.advance(); // consume number
            successThreshold = { op: next.value, value: parseInt(simple[1], 10) };
          }
        }
      }
      return {
        type: "group",
        members,
        keep,
        ...(drop ? { drop } : {}),
        ...(successThreshold ? { successThreshold } : {}),
        ...(groupFailureThreshold ? { failureThreshold: groupFailureThreshold } : {}),
      };
    }

    if (t.kind === "lparen") {
      this.advance();
      const inner = this.parseExpr();
      this.expectRparen();

      // Computed-count dice: (expr)dX or (expr)d(...) or (expr)dF.
      // The `(expr)` becomes the count, evaluated and rounded at roll time.
      const next = this.peek();
      if (next?.kind === "atom" && /^d(\d|[fF]|\()/.test(next.value)) {
        this.advance();
        const { termStr, inlineLabel } = extractInlineLabel(next.value);
        const term = parseDiceTerm("1" + termStr);
        if (term.type !== "standard" && term.type !== "fate") {
          throw new Error(`Computed dice count requires standard or fate dice: "(...)d${termStr.slice(1)}"`);
        }
        return { type: "term", term: { ...term, computedCount: inner }, ...(inlineLabel ? { inlineLabel } : {}) };
      }

      return inner;
    }

    if (t.kind === "atom") {
      const lower = t.value.toLowerCase();
      if (MATH_FN_NAMES.includes(lower) && this.tokens[this.pos + 1]?.kind === "lparen") {
        this.advance(); // fn name
        this.advance(); // (
        const arg = this.parseExpr();
        this.expectRparen();
        return { type: "fn", fn: lower as MathFn, arg };
      }
      this.advance();
      const { termStr, inlineLabel } = extractInlineLabel(t.value);
      return { type: "term", term: parseDiceTerm(termStr), inlineLabel };
    }

    throw new Error(`Unexpected token: ${t.kind}`);
  }
}

export function parseDice(formula: string): DiceExpression {
  const tokens = tokenize(formula);
  if (tokens.length === 0) throw new Error("Empty dice expression");
  const parser = new DiceParser(tokens);
  const root = parser.parse();
  return { root, ...(parser.successThreshold ? { successThreshold: parser.successThreshold } : {}) };
}

// --- Roller ---

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function cmpMatch(op: CompOp, v: number, threshold: number): boolean {
  switch (op) {
    case "=":  return v === threshold;
    case "<":  return v <   threshold;
    case ">":  return v >   threshold;
    case "<=": return v <=  threshold;
    case ">=": return v >=  threshold;
  }
}

function rollDiceTerm(term: DiceTerm): Omit<TermResult, "inlineLabel"> {
  switch (term.type) {
    case "standard": {
      // Resolve computed count/sides at roll time. Roll20 spec: round to nearest whole number.
      const count = term.computedCount ? Math.round(evalNode(term.computedCount).total) : term.count;
      const sides = term.computedSides ? Math.round(evalNode(term.computedSides).total) : term.sides;

      const matchesReroll = (v: number): boolean =>
        (term.reroll?.conditions ?? []).some((c) => cmpMatch(c.op, v, c.value));

      const matchesExplode = (v: number): boolean => {
        if (!term.explode) return false;
        const cond = term.explode.condition;
        if (!cond) return v === sides;
        return cmpMatch(cond.op, v, cond.value);
      };

      const rolls: number[] = [];
      const rerolledFrom: (number | undefined)[] = [];
      const explosionChainsArr: (number[] | undefined)[] = [];

      for (let i = 0; i < count; i++) {
        let v = randInt(1, sides);
        let original: number | undefined;
        if (term.reroll && matchesReroll(v)) {
          original = v;
          if (term.reroll.once) {
            v = randInt(1, sides);
          } else {
            let guard = 0;
            while (matchesReroll(v) && guard++ < 1000) v = randInt(1, sides);
          }
        }

        if (term.explode) {
          const { mode } = term.explode;
          // chain[0] is the base roll; subsequent entries are explosion rolls (adjusted for penetrating)
          const chain: number[] = [v];
          let lastRaw = v; // raw value used to check explosion condition
          let guard = 0;
          while (matchesExplode(lastRaw) && guard++ < 100) {
            lastRaw = randInt(1, sides);
            chain.push(mode === "penetrating" ? lastRaw - 1 : lastRaw);
          }
          const dieTotal = chain.reduce((s, x) => s + x, 0);
          rolls.push(dieTotal);
          rerolledFrom.push(original);
          explosionChainsArr.push(chain.length > 1 ? chain : undefined);
        } else {
          rolls.push(v);
          rerolledFrom.push(original);
          explosionChainsArr.push(undefined);
        }
      }

      const hasRerolls = rerolledFrom.some((v) => v !== undefined);
      const hasExplosions = explosionChainsArr.some((c) => c !== undefined);
      let kept: number[];
      if (term.keep) {
        const sorted = [...rolls].sort((a, b) => a - b);
        kept =
          term.keep.mode === "h"
            ? sorted.slice(-term.keep.count)
            : sorted.slice(0, term.keep.count);
      } else {
        kept = rolls;
      }
      const keepSuffix = term.keep ? `k${term.keep.mode}${term.keep.count}` : "";
      const rerollSuffix = term.reroll
        ? term.reroll.conditions
            .map((c) => `r${term.reroll!.once ? "o" : ""}${c.op === "=" ? "" : c.op}${c.value}`)
            .join("")
        : "";
      const explodeSuffix = term.explode
        ? (term.explode.mode === "compound" ? "!!" : term.explode.mode === "penetrating" ? "!p" : "!") +
          (term.explode.condition
            ? (term.explode.condition.op === "=" ? "" : term.explode.condition.op) + term.explode.condition.value
            : "")
        : "";

      const csConditions = term.critSuccess ?? [];
      const cfConditions = term.critFail ?? [];
      const hasCritConds = csConditions.length > 0 || cfConditions.length > 0;
      const matchCrit = (v: number, conds: CritCondition[]) =>
        conds.some((c) => cmpMatch(c.op, v, c.value));
      const critStatus: ("success" | "fail" | null)[] | undefined = hasCritConds
        ? rolls.map((v) => {
            if (matchCrit(v, csConditions)) return "success";
            if (matchCrit(v, cfConditions)) return "fail";
            return null;
          })
        : undefined;
      const anyCritSuccess = hasCritConds ? kept.some((v) => matchCrit(v, csConditions)) : undefined;
      const anyCritFail = hasCritConds ? kept.some((v) => matchCrit(v, cfConditions)) : undefined;
      const csSuffix = csConditions.map((c) => `cs${c.op === "=" ? "" : c.op}${c.value}`).join("");
      const cfSuffix = cfConditions.map((c) => `cf${c.op === "=" ? "" : c.op}${c.value}`).join("");

      const st = term.successThreshold;
      const ft = term.failureThreshold;
      const matchST = st ? (v: number) => cmpMatch(st.op, v, st.value) : null;
      const matchFT = ft ? (v: number) => cmpMatch(ft.op, v, ft.value) : null;
      // successMet and failureMet are parallel to rolls[] (for per-die display colouring)
      const successMet = matchST ? rolls.map((v) => typeof v === "number" && matchST(v)) : undefined;
      const failureMet = matchFT ? rolls.map((v) => typeof v === "number" && matchFT(v)) : undefined;
      const rawSuccessCount = matchST
        ? kept.filter((v) => typeof v === "number" && matchST(v as number)).length
        : undefined;
      const rawFailureCount = matchFT
        ? kept.filter((v) => typeof v === "number" && matchFT(v as number)).length
        : undefined;
      // Matching: scan kept dice for face values appearing minMatches+ times,
      // optionally satisfying targetCondition. With kind="tally" (mt), the
      // term total becomes the count of matched groups; with "show" (m) the
      // total is unchanged but matchedValues is exposed for visual highlighting.
      let matchedValues: number[] | undefined;
      let matchCount: number | undefined;
      if (term.matches) {
        const counts = new Map<number, number>();
        for (const v of kept) {
          if (typeof v !== "number") continue;
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        const cond = term.matches.targetCondition;
        const matched: number[] = [];
        for (const [val, cnt] of counts) {
          if (cnt < term.matches.minMatches) continue;
          if (cond && !cmpMatch(cond.op, val, cond.value)) continue;
          matched.push(val);
        }
        matched.sort((a, b) => a - b);
        matchedValues = matched;
        matchCount = matched.length;
      }

      const total = term.matches?.kind === "tally"
        ? matchCount ?? 0
        : matchST
          ? rawSuccessCount! - (rawFailureCount ?? 0)
          : kept.reduce((s, v) => s + (v as number), 0);
      const stSuffix = st ? `${st.op}${st.value}` : "";
      const ftSuffix = ft ? `f${ft.op === "=" ? "" : ft.op}${ft.value}` : "";
      const sortSuffix = term.sort === "asc" ? "s" : term.sort === "desc" ? "sd" : "";
      const matchSuffix = term.matches
        ? `${term.matches.kind === "tally" ? "mt" : "m"}` +
          `${term.matches.minMatches !== 2 ? term.matches.minMatches : ""}` +
          `${term.matches.targetCondition
              ? `${term.matches.targetCondition.op === "=" ? "" : term.matches.targetCondition.op}${term.matches.targetCondition.value}`
              : ""}`
        : "";

      let outRolls: number[] = rolls;
      let outRerolledFrom: (number | undefined)[] = rerolledFrom;
      let outExplosionChains: (number[] | undefined)[] = explosionChainsArr;
      let outCritStatus = critStatus;
      let outSuccessMet = successMet;
      let outFailureMet = failureMet;
      let outKept = kept;
      if (term.sort) {
        const dir = term.sort === "asc" ? 1 : -1;
        const idx = rolls.map((_, i) => i).sort((a, b) => dir * (rolls[a] - rolls[b]));
        outRolls = idx.map((i) => rolls[i]);
        outRerolledFrom = idx.map((i) => rerolledFrom[i]);
        outExplosionChains = idx.map((i) => explosionChainsArr[i]);
        if (critStatus) outCritStatus = idx.map((i) => critStatus[i]);
        if (successMet) outSuccessMet = idx.map((i) => successMet[i]);
        if (failureMet) outFailureMet = idx.map((i) => failureMet[i]);
        outKept = [...kept].sort((a, b) => dir * ((a as number) - (b as number)));
      }

      const outHasRerolls = outRerolledFrom.some((v) => v !== undefined);
      const outHasExplosions = outExplosionChains.some((c) => c !== undefined);

      return {
        rolls: outRolls,
        kept: outKept,
        total,
        label: `${count}d${sides}${explodeSuffix}${keepSuffix}${rerollSuffix}${csSuffix}${cfSuffix}${stSuffix}${ftSuffix}${sortSuffix}${matchSuffix}`,
        minFace: 1,
        maxFace: sides,
        ...(outHasRerolls ? { rerolledFrom: outRerolledFrom } : {}),
        ...(outHasExplosions || term.explode ? { explosionChains: outExplosionChains } : {}),
        ...(outCritStatus ? { critStatus: outCritStatus } : {}),
        ...(anyCritSuccess !== undefined ? { anyCritSuccess } : {}),
        ...(anyCritFail !== undefined ? { anyCritFail } : {}),
        ...(st ? { successThreshold: st } : {}),
        ...(outSuccessMet ? { successMet: outSuccessMet } : {}),
        ...(ft ? { failureThreshold: ft } : {}),
        ...(outFailureMet ? { failureMet: outFailureMet } : {}),
        ...(rawFailureCount !== undefined ? { failureCount: rawFailureCount, successCount: rawSuccessCount } : {}),
        ...(term.matches ? { matches: term.matches, matchedValues, matchCount } : {}),
      };
    }

    case "fate": {
      const count = term.computedCount ? Math.round(evalNode(term.computedCount).total) : term.count;
      const rolls = Array.from({ length: count }, () => randInt(-1, 1));
      return {
        rolls,
        kept: rolls,
        total: rolls.reduce((s, v) => s + v, 0),
        label: `${count}dF`,
        minFace: -1,
        maxFace: 1,
      };
    }

    case "pool": {
      const rolls = Array.from(
        { length: term.count },
        () => term.faces[randInt(0, term.faces.length - 1)],
      );
      return {
        rolls,
        kept: rolls,
        total: rolls.reduce((s, v) => s + v, 0),
        label: `${term.count}d[${term.faces.join(",")}]`,
        minFace: Math.min(...term.faces),
        maxFace: Math.max(...term.faces),
      };
    }

    case "table": {
      const rolls = Array.from(
        { length: term.count },
        () => term.entries[randInt(0, term.entries.length - 1)],
      );
      return {
        rolls,
        kept: rolls,
        total: 0,
        label: `${term.count}d[${term.entries.join(",")}]`,
        minFace: null,
        maxFace: null,
      };
    }

    case "constant": {
      return {
        rolls: [term.value],
        kept: [term.value],
        total: term.value,
        label: String(term.value),
        minFace: null,
        maxFace: null,
      };
    }
  }
}

type EvalResult = { total: number; terms: TermResult[]; groups: GroupResult[]; annotations: string[] };

const FN_ANNOTATION: Partial<Record<MathFn, (raw: number, result: number) => string>> = {
  floor: (raw, res) => `rounded down: ${raw} → ${res}`,
  ceil:  (raw, res) => `rounded up: ${raw} → ${res}`,
  round: (raw, res) => `rounded: ${raw} → ${res}`,
};

function evalNode(node: DiceNode): EvalResult {
  switch (node.type) {
    case "term": {
      const r = rollDiceTerm(node.term);
      return { total: r.total, terms: [{ ...r, inlineLabel: node.inlineLabel }], groups: [], annotations: [] };
    }
    case "negate": {
      const { total, terms, groups, annotations } = evalNode(node.arg);
      return { total: -total, terms, groups, annotations };
    }
    case "fn": {
      const inner = evalNode(node.arg);
      const total = Math[node.fn](inner.total);
      const annotations = [...inner.annotations];
      const annotate = FN_ANNOTATION[node.fn];
      if (annotate && total !== inner.total) annotations.push(annotate(inner.total, total));
      return { total, terms: inner.terms, groups: inner.groups, annotations };
    }
    case "binary": {
      const l = evalNode(node.left);
      const r = evalNode(node.right);
      const rTerms = r.terms.length > 0
        ? [{ ...r.terms[0], operatorPrefix: node.op }, ...r.terms.slice(1)]
        : r.terms;
      let total: number;
      switch (node.op) {
        case "+": total = l.total + r.total; break;
        case "-": total = l.total - r.total; break;
        case "*": total = l.total * r.total; break;
        case "/": total = l.total / r.total; break;
        case "%": total = l.total % r.total; break;
        case "**": total = l.total ** r.total; break;
        default: { const _: never = node.op; throw new Error(`Unknown op: ${_}`); }
      }
      return { total, terms: [...l.terms, ...rTerms], groups: [...l.groups, ...r.groups], annotations: [...l.annotations, ...r.annotations] };
    }
    case "group": {
      const memberResults = node.members.map((m) => evalNode(m));

      // Resolve drop modifier into an equivalent keep based on member/dice count.
      // - Single member (individual mode): drop applies across all dice.
      // - Multi-member (sum mode):         drop applies across member sums.
      let effectiveKeep = node.keep;
      if (node.drop && !effectiveKeep) {
        const totalCount = node.members.length === 1
          ? memberResults[0].terms.flatMap((t) =>
              t.kept.filter((v): v is number => typeof v === "number"),
            ).length
          : node.members.length;
        const keepMode = node.drop.mode === "l" ? "h" : "l";
        effectiveKeep = { mode: keepMode, count: Math.max(0, totalCount - node.drop.count) };
      }

      if (!effectiveKeep && !node.successThreshold) {
        return {
          total: memberResults.reduce((s, r) => s + r.total, 0),
          terms: memberResults.flatMap((r) => r.terms),
          groups: memberResults.flatMap((r) => r.groups),
          annotations: memberResults.flatMap((r) => r.annotations),
        };
      }

      if (node.successThreshold) {
        const { op, value } = node.successThreshold;
        const matchST = (v: number) => cmpMatch(op, v, value);
        const ft = node.failureThreshold;
        const matchFT = ft ? (v: number) => cmpMatch(ft.op, v, ft.value) : null;

        if (node.members.length === 1) {
          // Individual dice: check each kept die value against threshold
          const allTerms = memberResults[0].terms;
          const allValues = allTerms.flatMap((t) => t.kept.filter((v): v is number => typeof v === "number"));
          const successCount = allValues.filter(matchST).length;
          const failureCount = matchFT ? allValues.filter(matchFT).length : undefined;
          const total = successCount - (failureCount ?? 0);
          const groupResult: GroupResult = {
            keepMode: "individual",
            successThreshold: node.successThreshold,
            successCount,
            ...(ft ? { failureThreshold: ft, failureCount } : {}),
            members: [{ terms: allTerms, total: memberResults[0].total, kept: true }],
            total,
          };
          return {
            total,
            terms: [],
            groups: [...memberResults[0].groups, groupResult],
            annotations: memberResults[0].annotations,
          };
        }

        // Sum mode: count members whose total meets the threshold
        const members: GroupMember[] = memberResults.map((r) => ({ terms: r.terms, total: r.total, kept: true }));
        const successCount = members.filter((m) => matchST(m.total)).length;
        const failureCount = matchFT ? members.filter((m) => matchFT(m.total)).length : undefined;
        const total = successCount - (failureCount ?? 0);
        const groupResult: GroupResult = {
          keepMode: "sum",
          successThreshold: node.successThreshold,
          successCount,
          ...(ft ? { failureThreshold: ft, failureCount } : {}),
          members,
          total,
        };
        return {
          total,
          terms: [],
          groups: [...memberResults.flatMap((r) => r.groups), groupResult],
          annotations: memberResults.flatMap((r) => r.annotations),
        };
      }

      const { mode, count } = effectiveKeep!;

      if (node.members.length === 1) {
        // Individual dice mode: collect all kept dice values, then keep top/bottom N
        const allTerms = memberResults[0].terms;
        const allValues = allTerms.flatMap((t) =>
          t.kept.filter((v): v is number => typeof v === "number"),
        );
        const sorted = [...allValues].sort((a, b) => a - b);
        const keptValues = mode === "h" ? sorted.slice(-count) : sorted.slice(0, count);
        const total = keptValues.reduce((s, v) => s + v, 0);

        const groupResult: GroupResult = {
          keepMode: "individual",
          ...(node.keep ? { keep: node.keep } : {}),
          ...(node.drop ? { drop: node.drop } : {}),
          members: [{ terms: allTerms, total: memberResults[0].total, kept: true }],
          keptValues,
          total,
        };

        return {
          total,
          terms: [],
          groups: [...memberResults[0].groups, groupResult],
          annotations: memberResults[0].annotations,
        };
      }

      // Group sum mode: keep highest/lowest member sums
      const indexed = memberResults.map((r, i) => ({ total: r.total, i })).sort((a, b) => a.total - b.total);
      const keptIndices = new Set(
        (mode === "h" ? indexed.slice(-count) : indexed.slice(0, count)).map((x) => x.i),
      );

      const members: GroupMember[] = memberResults.map((r, i) => ({
        terms: r.terms,
        total: r.total,
        kept: keptIndices.has(i),
      }));

      const total = members.filter((m) => m.kept).reduce((s, m) => s + m.total, 0);

      const groupResult: GroupResult = {
        keepMode: "sum",
        ...(node.keep ? { keep: node.keep } : {}),
        ...(node.drop ? { drop: node.drop } : {}),
        members,
        total,
      };

      return {
        total,
        terms: [],
        groups: [...memberResults.flatMap((r) => r.groups), groupResult],
        annotations: memberResults.flatMap((r) => r.annotations),
      };
    }
  }
}

function termMaxTotal(term: DiceTerm): number | null {
  switch (term.type) {
    case "standard":
      if (term.explode || term.successThreshold || term.computedCount || term.computedSides || term.matches?.kind === "tally") return null;
      return (term.keep ? term.keep.count : term.count) * term.sides;
    case "fate":
      if (term.computedCount) return null;
      return term.count;
    case "pool": return term.count * Math.max(...term.faces);
    case "table": return null;
    case "constant": return term.value;
  }
}

function termMinTotal(term: DiceTerm): number | null {
  switch (term.type) {
    case "standard":
      if (term.explode || term.successThreshold || term.computedCount || term.computedSides || term.matches?.kind === "tally") return null;
      return (term.keep ? term.keep.count : term.count) * 1;
    case "fate":
      if (term.computedCount) return null;
      return -term.count;
    case "pool": return term.count * Math.min(...term.faces);
    case "table": return null;
    case "constant": return term.value;
  }
}

function maxNode(node: DiceNode): number | null {
  switch (node.type) {
    case "term": return termMaxTotal(node.term);
    case "negate": {
      const m = minNode(node.arg);
      return m === null ? null : -m;
    }
    case "fn": {
      if (node.fn === "abs") {
        const mx = maxNode(node.arg), mn = minNode(node.arg);
        if (mx === null || mn === null) return null;
        return Math.max(Math.abs(mx), Math.abs(mn));
      }
      const m = maxNode(node.arg);
      return m === null ? null : Math[node.fn](m);
    }
    case "binary": {
      switch (node.op) {
        case "+": { const l = maxNode(node.left), r = maxNode(node.right); return l === null || r === null ? null : l + r; }
        case "-": { const l = maxNode(node.left), r = minNode(node.right); return l === null || r === null ? null : l - r; }
        case "*": { const l = maxNode(node.left), r = maxNode(node.right); return l === null || r === null ? null : l * r; }
        case "/": { const l = maxNode(node.left), r = minNode(node.right); return l === null || r === null || r === 0 ? null : l / r; }
        case "%": return null;
        case "**": return null;
        default: { const _: never = node.op; throw new Error(`Unknown op: ${_}`); }
      }
    }
    case "group": {
      if (node.keep || node.drop || node.successThreshold) return null;
      const maxes = node.members.map((m) => maxNode(m));
      if (maxes.some((m) => m === null)) return null;
      return maxes.reduce((s, m) => s! + m!, 0);
    }
  }
}

function minNode(node: DiceNode): number | null {
  switch (node.type) {
    case "term": return termMinTotal(node.term);
    case "negate": {
      const m = maxNode(node.arg);
      return m === null ? null : -m;
    }
    case "fn": {
      if (node.fn === "abs") {
        const mx = maxNode(node.arg), mn = minNode(node.arg);
        if (mx === null || mn === null) return null;
        if (mn <= 0 && mx >= 0) return 0;
        return Math.min(Math.abs(mx), Math.abs(mn));
      }
      const m = minNode(node.arg);
      return m === null ? null : Math[node.fn](m);
    }
    case "binary": {
      switch (node.op) {
        case "+": { const l = minNode(node.left), r = minNode(node.right); return l === null || r === null ? null : l + r; }
        case "-": { const l = minNode(node.left), r = maxNode(node.right); return l === null || r === null ? null : l - r; }
        case "*": { const l = minNode(node.left), r = minNode(node.right); return l === null || r === null ? null : l * r; }
        case "/": { const l = minNode(node.left), r = maxNode(node.right); return l === null || r === null || r === 0 ? null : l / r; }
        case "%": return null;
        case "**": return null;
        default: { const _: never = node.op; throw new Error(`Unknown op: ${_}`); }
      }
    }
    case "group": {
      if (node.keep || node.drop || node.successThreshold) return null;
      const mins = node.members.map((m) => minNode(m));
      if (mins.some((m) => m === null)) return null;
      return mins.reduce((s, m) => s! + m!, 0);
    }
  }
}

export function rollExpression(expr: DiceExpression): RollResult {
  const { total, terms, groups, annotations } = evalNode(expr.root);
  const st = expr.successThreshold;
  const successCount = st ? (cmpMatch(st.op, total, st.value) ? 1 : 0) : undefined;
  return {
    terms,
    ...(groups.length > 0 ? { groups } : {}),
    total,
    maxTotal: maxNode(expr.root),
    minTotal: minNode(expr.root),
    expression: terms.map((t) => t.label).join(""),
    ...(annotations.length > 0 ? { annotations } : {}),
    ...(st ? { successThreshold: st, successCount } : {}),
  };
}

export function roll(notation: string): RollResult {
  const { formula, label } = splitFormulaLabel(notation.trim());
  return { ...rollExpression(parseDice(formula)), label };
}
