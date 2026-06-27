import { describe, it, expect, afterEach, vi } from "vitest";
import { roll, parseDice, splitFormulaLabel, cmpMatch } from "./dice";

// ── RNG helpers ────────────────────────────────────────────────────────────
// randInt(min, max) = Math.floor(Math.random() * (max - min + 1)) + min
// To make randInt produce `value`, supply Math.random() = (value - min + 0.5) / (max - min + 1).
function rng(min: number, max: number, value: number): number {
  return (value - min + 0.5) / (max - min + 1);
}
function d(sides: number, value: number): number {
  return rng(1, sides, value);
}
function fate(value: -1 | 0 | 1): number {
  return rng(-1, 1, value);
}
function poolIdx(length: number, index: number): number {
  return rng(0, length - 1, index);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── splitFormulaLabel ──────────────────────────────────────────────────────
describe("splitFormulaLabel", () => {
  it("returns formula unchanged when no label present", () => {
    expect(splitFormulaLabel("2d6")).toEqual({ formula: "2d6" });
  });

  it("splits on first word that looks like a label", () => {
    expect(splitFormulaLabel("2d6 Roll for Initiative")).toEqual({
      formula: "2d6",
      label: "Roll for Initiative",
    });
  });

  it("uses backslash as explicit separator", () => {
    expect(splitFormulaLabel("2d6 \\ +5 for initiative")).toEqual({
      formula: "2d6",
      label: "+5 for initiative",
    });
  });

  it("does not split on operators after a space", () => {
    const r = splitFormulaLabel("2d6 + 1d4 + 3");
    expect(r.formula).toBe("2d6 + 1d4 + 3");
    expect(r.label).toBeUndefined();
  });

  it("does not split inside bracket content", () => {
    expect(splitFormulaLabel("1d[fire,ice] Table Roll")).toEqual({
      formula: "1d[fire,ice]",
      label: "Table Roll",
    });
  });

  it("does not split inside brace groups", () => {
    const r = splitFormulaLabel("{4d6,3d8}kh1 Stat Block");
    expect(r.formula).toBe("{4d6,3d8}kh1");
    expect(r.label).toBe("Stat Block");
  });
});

// ── cmpMatch ──────────────────────────────────────────────────────────────
describe("cmpMatch", () => {
  it("= matches only equal values", () => {
    expect(cmpMatch("=", 5, 5)).toBe(true);
    expect(cmpMatch("=", 4, 5)).toBe(false);
    expect(cmpMatch("=", 6, 5)).toBe(false);
  });
  it("< matches strictly less", () => {
    expect(cmpMatch("<", 4, 5)).toBe(true);
    expect(cmpMatch("<", 5, 5)).toBe(false);
    expect(cmpMatch("<", 6, 5)).toBe(false);
  });
  it("> matches strictly greater", () => {
    expect(cmpMatch(">", 6, 5)).toBe(true);
    expect(cmpMatch(">", 5, 5)).toBe(false);
    expect(cmpMatch(">", 4, 5)).toBe(false);
  });
  it("<= matches less or equal", () => {
    expect(cmpMatch("<=", 4, 5)).toBe(true);
    expect(cmpMatch("<=", 5, 5)).toBe(true);
    expect(cmpMatch("<=", 6, 5)).toBe(false);
  });
  it(">= matches greater or equal", () => {
    expect(cmpMatch(">=", 6, 5)).toBe(true);
    expect(cmpMatch(">=", 5, 5)).toBe(true);
    expect(cmpMatch(">=", 4, 5)).toBe(false);
  });
});

// ── parseDice - structural / AST ──────────────────────────────────────────
describe("parseDice", () => {
  it("parses a basic NdS term", () => {
    const expr = parseDice("2d6");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.count).toBe(2);
    expect(t.sides).toBe(6);
  });

  it("parses 1dN when count is omitted", () => {
    const expr = parseDice("d20");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.count).toBe(1);
    expect(t.sides).toBe(20);
  });

  it("parses keep-high modifier (kh)", () => {
    const expr = parseDice("4d6kh3");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.keep).toEqual({ mode: "h", count: 3 });
  });

  it("parses keep-low modifier (kl)", () => {
    const expr = parseDice("4d6kl2");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.keep).toEqual({ mode: "l", count: 2 });
  });

  it("parses drop-lowest (dl1) as keep-highest (kh)", () => {
    const expr = parseDice("4d6dl1");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.keep).toEqual({ mode: "h", count: 3 });
  });

  it("parses bare drop (d1) the same as dl1", () => {
    const expr = parseDice("4d6d1");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.keep).toEqual({ mode: "h", count: 3 });
  });

  it("parses drop-highest (dh1) as keep-lowest", () => {
    const expr = parseDice("4d6dh1");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.keep).toEqual({ mode: "l", count: 3 });
  });

  it("parses reroll condition r<N", () => {
    const expr = parseDice("2d8r<2");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.reroll?.conditions).toEqual([{ op: "<", value: 2 }]);
    expect(t.reroll?.once).toBe(false);
  });

  it("parses bare reroll rN as exact match (op=equals)", () => {
    const expr = parseDice("2d8r1");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.reroll?.conditions).toEqual([{ op: "=", value: 1 }]);
  });

  it("parses multiple chained reroll conditions", () => {
    const expr = parseDice("2d8r1r3r5");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.reroll?.conditions).toHaveLength(3);
  });

  it("parses reroll-once (ro) as once=true", () => {
    const expr = parseDice("2d10ro<2");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.reroll?.once).toBe(true);
    expect(t.reroll?.conditions).toEqual([{ op: "<", value: 2 }]);
  });

  it("parses fate dice (dF)", () => {
    const expr = parseDice("4dF");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("fate");
    if (t.type !== "fate") return;
    expect(t.count).toBe(4);
  });

  it("parses table dice (string entries)", () => {
    const expr = parseDice("1d[fire,ice,lightning]");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("table");
    if (t.type !== "table") return;
    expect(t.entries).toEqual(["fire", "ice", "lightning"]);
  });

  it("parses pool dice (numeric entries)", () => {
    const expr = parseDice("1d[2,4,6,8]");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("pool");
    if (t.type !== "pool") return;
    expect(t.faces).toEqual([2, 4, 6, 8]);
  });

  it("parses crit success condition (cs>N)", () => {
    const expr = parseDice("1d20cs>10");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.critSuccess).toEqual([{ op: ">", value: 10 }]);
  });

  it("parses crit failure condition (cf<N)", () => {
    const expr = parseDice("1d20cf<3");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.critFail).toEqual([{ op: "<", value: 3 }]);
  });

  it("parses multiple exact crit conditions", () => {
    const expr = parseDice("1d20cs20cs10");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.critSuccess).toHaveLength(2);
  });

  it("parses normal explode (!)", () => {
    const expr = parseDice("3d6!");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.explode?.mode).toBe("normal");
    expect(t.explode?.condition).toBeUndefined();
  });

  it("parses conditional explode (!>N)", () => {
    const expr = parseDice("3d6!>4");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.explode?.mode).toBe("normal");
    expect(t.explode?.condition).toEqual({ op: ">", value: 4 });
  });

  it("parses compound explode (!!)", () => {
    const expr = parseDice("5d6!!");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.explode?.mode).toBe("compound");
  });

  it("parses penetrating explode (!p)", () => {
    const expr = parseDice("5d6!p");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.explode?.mode).toBe("penetrating");
  });

  it("parses success threshold (>N on dice)", () => {
    const expr = parseDice("3d6>3");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.successThreshold).toEqual({ op: ">", value: 3 });
  });

  it("parses failure threshold (f)", () => {
    const expr = parseDice("3d6>3f1");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.successThreshold).toEqual({ op: ">", value: 3 });
    expect(t.failureThreshold).toEqual({ op: "=", value: 1 });
  });

  it("parses expression-level success threshold", () => {
    const expr = parseDice("1d20+13>21");
    expect(expr.successThreshold).toEqual({ op: ">", value: 21 });
  });

  it("parses binary addition", () => {
    const expr = parseDice("2d6+3");
    expect(expr.root.type).toBe("binary");
    if (expr.root.type !== "binary") return;
    expect(expr.root.op).toBe("+");
    expect(expr.root.left.type).toBe("term");
    expect(expr.root.right.type).toBe("term");
  });

  it("parses parenthesised grouping", () => {
    const expr = parseDice("(2d6+1d4)*2");
    expect(expr.root.type).toBe("binary");
    if (expr.root.type !== "binary") return;
    expect(expr.root.op).toBe("*");
    expect(expr.root.left.type).toBe("binary");
  });

  it("parses math functions", () => {
    const expr = parseDice("floor(2d6/3)");
    expect(expr.root.type).toBe("fn");
    if (expr.root.type !== "fn") return;
    expect(expr.root.fn).toBe("floor");
  });

  it("parses group keep syntax ({...}kh)", () => {
    const expr = parseDice("{4d6,3d8}kh1");
    expect(expr.root.type).toBe("group");
    if (expr.root.type !== "group") return;
    expect(expr.root.members).toHaveLength(2);
    expect(expr.root.keep).toEqual({ mode: "h", count: 1 });
  });

  it("parses group success threshold ({...}>N)", () => {
    const expr = parseDice("{5d6!!}>8");
    expect(expr.root.type).toBe("group");
    if (expr.root.type !== "group") return;
    expect(expr.root.successThreshold).toEqual({ op: ">", value: 8 });
  });

  it("parses inline labels on dice terms", () => {
    const expr = parseDice("2d6[Fire]");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    expect(expr.root.inlineLabel).toBe("Fire");
  });

  it("throws on empty expression", () => {
    expect(() => parseDice("")).toThrow();
  });

  it("throws on unparseable input", () => {
    expect(() => parseDice("xyz")).toThrow();
  });
});

// ── roll - deterministic results via mocked Math.random ───────────────────
describe("roll - basic dice", () => {
  it("rolls a constant", () => {
    const r = roll("7");
    expect(r.total).toBe(7);
    expect(r.terms[0].rolls).toEqual([7]);
  });

  it("rolls 2d6 with mocked values", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 5));
    const r = roll("2d6");
    expect(r.terms[0].rolls).toEqual([3, 5]);
    expect(r.total).toBe(8);
  });

  it("sets minTotal and maxTotal for a standard roll", () => {
    vi.spyOn(Math, "random").mockReturnValue(d(6, 3));
    const r = roll("2d6");
    expect(r.minTotal).toBe(2);
    expect(r.maxTotal).toBe(12);
  });

  it("tracks the expression string", () => {
    vi.spyOn(Math, "random").mockReturnValue(d(6, 3));
    const r = roll("2d6");
    expect(r.expression).toBe("2d6");
  });

  it("attaches overall label from notation", () => {
    vi.spyOn(Math, "random").mockReturnValue(d(6, 3));
    const r = roll("2d6 Roll for Initiative");
    expect(r.label).toBe("Roll for Initiative");
  });
});

describe("roll - keep / drop", () => {
  it("4d6kh3 keeps the three highest values", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 5))
      .mockReturnValueOnce(d(6, 4))
      .mockReturnValueOnce(d(6, 3));
    const r = roll("4d6kh3");
    expect(r.terms[0].kept.sort()).toEqual([3, 4, 5]);
    expect(r.total).toBe(12);
  });

  it("4d6kl3 keeps the three lowest values", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 5))
      .mockReturnValueOnce(d(6, 4))
      .mockReturnValueOnce(d(6, 3));
    const r = roll("4d6kl3");
    expect(r.terms[0].kept.sort()).toEqual([1, 3, 4]);
    expect(r.total).toBe(8);
  });

  it("4d6dl1 (drop lowest) equals 4d6kh3", () => {
    const spy = vi.spyOn(Math, "random");
    const seq = [d(6, 1), d(6, 5), d(6, 4), d(6, 3)];
    spy.mockReturnValueOnce(seq[0]).mockReturnValueOnce(seq[1])
       .mockReturnValueOnce(seq[2]).mockReturnValueOnce(seq[3]);
    const kh = roll("4d6kh3");
    spy.mockReturnValueOnce(seq[0]).mockReturnValueOnce(seq[1])
       .mockReturnValueOnce(seq[2]).mockReturnValueOnce(seq[3]);
    const dl = roll("4d6dl1");
    expect(dl.total).toBe(kh.total);
  });

  it("4d6dh1 (drop highest) equals 4d6kl3", () => {
    const spy = vi.spyOn(Math, "random");
    const seq = [d(6, 1), d(6, 5), d(6, 4), d(6, 3)];
    spy.mockReturnValueOnce(seq[0]).mockReturnValueOnce(seq[1])
       .mockReturnValueOnce(seq[2]).mockReturnValueOnce(seq[3]);
    const kl = roll("4d6kl3");
    spy.mockReturnValueOnce(seq[0]).mockReturnValueOnce(seq[1])
       .mockReturnValueOnce(seq[2]).mockReturnValueOnce(seq[3]);
    const dh = roll("4d6dh1");
    expect(dh.total).toBe(kl.total);
  });
});

describe("roll - reroll", () => {
  it("rerolls on exact match and records original in rerolledFrom", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))  // die 1: rolls 1 → triggers reroll
      .mockReturnValueOnce(d(6, 4))  // die 1 reroll → 4
      .mockReturnValueOnce(d(6, 3)); // die 2: rolls 3
    const r = roll("2d6r1");
    expect(r.terms[0].rolls).toEqual([4, 3]);
    expect(r.terms[0].rerolledFrom?.[0]).toBe(1);
    expect(r.total).toBe(7);
  });

  it("rerolls on < condition", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(8, 1))  // die 1: 1 < 2 → reroll
      .mockReturnValueOnce(d(8, 5))  // reroll → 5
      .mockReturnValueOnce(d(8, 7)); // die 2: 7
    const r = roll("2d8r<2");
    expect(r.terms[0].rolls).toEqual([5, 7]);
    expect(r.total).toBe(12);
  });

  it("reroll-once (ro) only rerolls once even if still in range", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 2))  // rolls 2 (<3) → reroll once
      .mockReturnValueOnce(d(6, 1)); // reroll gives 1 (still <3, but once = stop)
    const r = roll("1d6ro<3");
    expect(r.terms[0].rolls).toEqual([1]);
    expect(r.total).toBe(1);
  });

  it("unlimited reroll keeps rerolling until condition is not met", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))  // rolls 1 → reroll
      .mockReturnValueOnce(d(6, 1))  // rolls 1 → reroll again
      .mockReturnValueOnce(d(6, 4)); // rolls 4 → keep
    const r = roll("1d6r1");
    expect(r.terms[0].rolls).toEqual([4]);
    expect(r.total).toBe(4);
  });

  it("reroll combined with keep: 4d6kh3r1", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))  // die 1: 1 → reroll
      .mockReturnValueOnce(d(6, 5))  // rerolled → 5
      .mockReturnValueOnce(d(6, 3))  // die 2
      .mockReturnValueOnce(d(6, 4))  // die 3
      .mockReturnValueOnce(d(6, 2)); // die 4
    const r = roll("4d6kh3r1");
    // rolled [5,3,4,2] after reroll; kh3 = [3,4,5] = 12
    expect(r.total).toBe(12);
  });
});

describe("roll - exploding dice", () => {
  it("normal explode: max face triggers an extra roll", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 6))  // die 1: max → explodes
      .mockReturnValueOnce(d(6, 3))  // explosion roll → 3 (no further explosion)
      .mockReturnValueOnce(d(6, 2)); // die 2: 2
    const r = roll("2d6!");
    expect(r.terms[0].rolls).toEqual([9, 2]); // 6+3=9 for die 1
    expect(r.terms[0].explosionChains?.[0]).toEqual([6, 3]);
    expect(r.total).toBe(11);
  });

  it("normal explode continues chaining while max is rolled", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 6))  // explodes
      .mockReturnValueOnce(d(6, 6))  // explodes again
      .mockReturnValueOnce(d(6, 2)); // stops
    const r = roll("1d6!");
    expect(r.total).toBe(14); // 6+6+2
    expect(r.terms[0].explosionChains?.[0]).toEqual([6, 6, 2]);
  });

  it("conditional explode: only explodes on matching face", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 5))  // 5 > 4 → explodes
      .mockReturnValueOnce(d(6, 3)); // 3 ≤ 4 → stops
    const r = roll("1d6!>4");
    expect(r.total).toBe(8);
  });

  it("exact explode: only explodes on exact value", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 3))  // 3 = 3 → explodes
      .mockReturnValueOnce(d(6, 4)); // 4 ≠ 3 → stops
    const r = roll("1d6!3");
    expect(r.total).toBe(7);
  });

  it("compound explode (!!): extra rolls accumulate into one die value", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 6))  // explodes
      .mockReturnValueOnce(d(6, 3)); // stops
    const r = roll("1d6!!");
    // compound and normal both sum the chain; result is the same arithmetic
    expect(r.total).toBe(9);
  });

  it("penetrating explode (!p): extra rolls have -1 applied", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 6))  // explodes
      .mockReturnValueOnce(d(6, 4)); // raw 4, applied as 4-1=3
    const r = roll("1d6!p");
    expect(r.total).toBe(9); // 6 + (4-1) = 9
  });

  it("maxTotal is null for exploding dice (unbounded)", () => {
    vi.spyOn(Math, "random").mockReturnValue(d(6, 2));
    const r = roll("3d6!");
    expect(r.maxTotal).toBeNull();
  });
});

describe("roll - fate dice", () => {
  it("fate dice produce values in {-1, 0, 1}", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(fate(-1))
      .mockReturnValueOnce(fate(0))
      .mockReturnValueOnce(fate(1))
      .mockReturnValueOnce(fate(-1));
    const r = roll("4dF");
    expect(r.terms[0].rolls).toEqual([-1, 0, 1, -1]);
    expect(r.total).toBe(-1);
  });

  it("fate minFace is -1 and maxFace is 1", () => {
    vi.spyOn(Math, "random").mockReturnValue(fate(0));
    const r = roll("4dF");
    expect(r.terms[0].minFace).toBe(-1);
    expect(r.terms[0].maxFace).toBe(1);
  });
});

describe("roll - pool and table dice", () => {
  it("pool dice select from custom numeric faces", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(poolIdx(4, 2)); // index 2 of [2,4,6,8] = 6
    const r = roll("1d[2,4,6,8]");
    expect(r.terms[0].rolls).toEqual([6]);
    expect(r.total).toBe(6);
  });

  it("table dice return string entries and total 0", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(poolIdx(3, 1)); // index 1 of ["fire","ice","lightning"]
    const r = roll("1d[fire,ice,lightning]");
    expect(r.terms[0].rolls).toEqual(["ice"]);
    expect(r.total).toBe(0);
    expect(r.minTotal).toBeNull();
  });
});

describe("roll - success counting", () => {
  it("3d6>3: counts dice strictly greater than 3", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))  // 1: no
      .mockReturnValueOnce(d(6, 4))  // 4: yes
      .mockReturnValueOnce(d(6, 5)); // 5: yes
    const r = roll("3d6>3");
    expect(r.total).toBe(2);
    expect(r.terms[0].successMet).toEqual([false, true, true]);
  });

  it("10d6<4: counts dice strictly less than 4", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 2))  // yes
      .mockReturnValueOnce(d(6, 5))  // no
      .mockReturnValueOnce(d(6, 3))  // yes
      .mockReturnValueOnce(d(6, 6))  // no
      .mockReturnValueOnce(d(6, 1))  // yes
      .mockReturnValueOnce(d(6, 4))  // no (4 is not < 4)
      .mockReturnValueOnce(d(6, 2))  // yes
      .mockReturnValueOnce(d(6, 5))  // no
      .mockReturnValueOnce(d(6, 3))  // yes
      .mockReturnValueOnce(d(6, 6)); // no
    const r = roll("10d6<4");
    expect(r.total).toBe(5);
  });

  it("3d6>3f1: subtracts failure count from success count", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))  // 1: failure (=1)
      .mockReturnValueOnce(d(6, 4))  // 4: success (>3)
      .mockReturnValueOnce(d(6, 5)); // 5: success (>3)
    const r = roll("3d6>3f1");
    // 2 successes - 1 failure = 1
    expect(r.terms[0].successCount).toBe(2);
    expect(r.terms[0].failureCount).toBe(1);
    expect(r.total).toBe(1);
  });
});

describe("roll - critical success / failure", () => {
  it("cs20: marks exact 20 as crit success", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(d(20, 20));
    const r = roll("1d20cs20");
    expect(r.terms[0].critStatus).toEqual(["success"]);
    expect(r.terms[0].anyCritSuccess).toBe(true);
  });

  it("cs20: non-20 roll is not a crit success", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(d(20, 15));
    const r = roll("1d20cs20");
    expect(r.terms[0].critStatus).toEqual([null]);
    expect(r.terms[0].anyCritSuccess).toBe(false);
  });

  it("cf<3: marks rolls less than 3 as crit fail", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(d(20, 2));
    const r = roll("1d20cf<3");
    expect(r.terms[0].critStatus).toEqual(["fail"]);
    expect(r.terms[0].anyCritFail).toBe(true);
  });

  it("combined cs and cf on same die", () => {
    const spy = vi.spyOn(Math, "random");

    spy.mockReturnValueOnce(d(20, 20));
    const crit = roll("1d20cs>18cf<3");
    expect(crit.terms[0].critStatus?.[0]).toBe("success");

    spy.mockReturnValueOnce(d(20, 1));
    const fumble = roll("1d20cs>18cf<3");
    expect(fumble.terms[0].critStatus?.[0]).toBe("fail");

    spy.mockReturnValueOnce(d(20, 10));
    const normal = roll("1d20cs>18cf<3");
    expect(normal.terms[0].critStatus?.[0]).toBeNull();
  });
});

describe("roll - expression-level success threshold", () => {
  it("1d20+13>21: success when total exceeds 21", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(d(20, 12)); // 12+13=25
    const r = roll("1d20+13>21");
    expect(r.total).toBe(25);
    expect(r.successCount).toBe(1);
  });

  it("1d20+13>21: failure when total does not exceed 21", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(d(20, 5)); // 5+13=18
    const r = roll("1d20+13>21");
    expect(r.total).toBe(18);
    expect(r.successCount).toBe(0);
  });
});

describe("roll - math expressions", () => {
  it("adds a constant modifier", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 4))
      .mockReturnValueOnce(d(6, 2));
    const r = roll("2d6+3");
    expect(r.total).toBe(9); // 4+2+3
  });

  it("compound expression: 2d6+1d4", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 5))
      .mockReturnValueOnce(d(4, 2));
    const r = roll("2d6+1d4");
    expect(r.total).toBe(10);
  });

  it("floor() truncates fractional division", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 2))
      .mockReturnValueOnce(d(6, 5));
    const r = roll("floor(2d6/3)");
    // (2+5)/3 = 7/3 = 2.333 → floor → 2
    expect(r.total).toBe(2);
    expect(r.annotations?.[0]).toMatch(/rounded down/);
  });

  it("ceil() rounds up", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 2))
      .mockReturnValueOnce(d(6, 5));
    const r = roll("ceil(2d6/3)");
    // 7/3 = 2.333 → ceil → 3
    expect(r.total).toBe(3);
  });

  it("exponentiation (**) squares the result", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 1));
    const r = roll("2d6**2");
    // (3+1)**2 = 16
    expect(r.total).toBe(16);
  });

  it("modulo (%)", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 3));
    const r = roll("2d6%4");
    // (3+3)%4 = 6%4 = 2
    expect(r.total).toBe(2);
  });

  it("parentheses change evaluation order", () => {
    // (2d6+1d4)*2: 2 rolls for 2d6, 1 for 1d4
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 3))  // die 1 of 2d6
      .mockReturnValueOnce(d(6, 4))  // die 2 of 2d6 → sum 7
      .mockReturnValueOnce(d(4, 2)); // 1d4 → 2; (7+2)*2 = 18
    const r = roll("(2d6+1d4)*2");
    expect(r.total).toBe(18);
  });
});

describe("roll - group rolls", () => {
  it("{4d6}kh3: keeps 3 highest dice from a single expression", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 5))
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 4));
    const r = roll("{4d6}kh3");
    // individual mode: all dice [1,5,3,4], keep 3 highest = [3,4,5] = 12
    expect(r.total).toBe(12);
    expect(r.groups?.[0].keptValues?.sort()).toEqual([3, 4, 5]);
  });

  it("{4d6,3d8}kh1: keeps group with highest sum", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 2)) // 4d6 group
      .mockReturnValueOnce(d(6, 2))
      .mockReturnValueOnce(d(6, 2))
      .mockReturnValueOnce(d(6, 2)) // sum=8
      .mockReturnValueOnce(d(8, 5)) // 3d8 group
      .mockReturnValueOnce(d(8, 5))
      .mockReturnValueOnce(d(8, 5)); // sum=15
    const r = roll("{4d6,3d8}kh1");
    expect(r.total).toBe(15); // 3d8 group wins
  });

  it("{3d6}>3: counts individual dice > 3 across the group", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 4))
      .mockReturnValueOnce(d(6, 5));
    const r = roll("{3d6}>3");
    expect(r.total).toBe(2); // 4 and 5 are > 3
  });
});

describe("roll - group drop", () => {
  it("parses {...}d1 as drop-lowest", () => {
    const expr = parseDice("{4d6,2d8,3d20}d1");
    expect(expr.root.type).toBe("group");
    if (expr.root.type !== "group") return;
    expect(expr.root.drop).toEqual({ mode: "l", count: 1 });
    expect(expr.root.keep).toBeUndefined();
  });

  it("parses {...}dl1 the same as {...}d1", () => {
    const expr = parseDice("{4d6,2d8,3d20}dl1");
    expect(expr.root.type).toBe("group");
    if (expr.root.type !== "group") return;
    expect(expr.root.drop).toEqual({ mode: "l", count: 1 });
  });

  it("parses {...}dh1 as drop-highest", () => {
    const expr = parseDice("{4d6,2d8,3d20}dh1");
    expect(expr.root.type).toBe("group");
    if (expr.root.type !== "group") return;
    expect(expr.root.drop).toEqual({ mode: "h", count: 1 });
  });

  it("{4d6+2d8, 3d20+3, 5d10+1}d1: drops sub-roll with lowest total", () => {
    vi.spyOn(Math, "random")
      // 4d6 → 1,1,1,1 = 4
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 1))
      // 2d8 → 1,1 = 2; member1 total = 4+2 = 6
      .mockReturnValueOnce(d(8, 1))
      .mockReturnValueOnce(d(8, 1))
      // 3d20 → 10,10,10 = 30; +3 = 33
      .mockReturnValueOnce(d(20, 10))
      .mockReturnValueOnce(d(20, 10))
      .mockReturnValueOnce(d(20, 10))
      // 5d10 → 5,5,5,5,5 = 25; +1 = 26
      .mockReturnValueOnce(d(10, 5))
      .mockReturnValueOnce(d(10, 5))
      .mockReturnValueOnce(d(10, 5))
      .mockReturnValueOnce(d(10, 5))
      .mockReturnValueOnce(d(10, 5));
    const r = roll("{4d6+2d8, 3d20+3, 5d10+1}d1");
    // Member totals: 6, 33, 26 → drop the 6 → 33 + 26 = 59
    expect(r.total).toBe(59);
    expect(r.groups?.[0].keepMode).toBe("sum");
    expect(r.groups?.[0].drop).toEqual({ mode: "l", count: 1 });
    expect(r.groups?.[0].members.map((m) => m.kept)).toEqual([false, true, true]);
  });

  it("{4d6,2d8,3d20}dh1: drops sub-roll with highest total", () => {
    vi.spyOn(Math, "random")
      // 4d6 → 1,1,1,1 = 4
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 1))
      // 2d8 → 5,5 = 10
      .mockReturnValueOnce(d(8, 5))
      .mockReturnValueOnce(d(8, 5))
      // 3d20 → 20,20,20 = 60
      .mockReturnValueOnce(d(20, 20))
      .mockReturnValueOnce(d(20, 20))
      .mockReturnValueOnce(d(20, 20));
    const r = roll("{4d6,2d8,3d20}dh1");
    // Drop the 60 → 4 + 10 = 14
    expect(r.total).toBe(14);
    expect(r.groups?.[0].members.map((m) => m.kept)).toEqual([true, true, false]);
  });

  it("{4d6+3d8}d2: drops 2 lowest dice across the single sub-roll", () => {
    vi.spyOn(Math, "random")
      // 4d6 → 1, 6, 2, 5
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 6))
      .mockReturnValueOnce(d(6, 2))
      .mockReturnValueOnce(d(6, 5))
      // 3d8 → 8, 3, 7
      .mockReturnValueOnce(d(8, 8))
      .mockReturnValueOnce(d(8, 3))
      .mockReturnValueOnce(d(8, 7));
    const r = roll("{4d6+3d8}d2");
    // 7 dice: [1,6,2,5,8,3,7] → sorted [1,2,3,5,6,7,8] → drop lowest 2 (1,2) → [3,5,6,7,8] = 29
    expect(r.total).toBe(29);
    expect(r.groups?.[0].keepMode).toBe("individual");
    expect(r.groups?.[0].drop).toEqual({ mode: "l", count: 2 });
    expect(r.groups?.[0].keptValues).toEqual([3, 5, 6, 7, 8]);
  });

  it("{4d6}d1 equals {4d6}kh3 in expected total", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 2))
      .mockReturnValueOnce(d(6, 5))
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 4));
    const r = roll("{4d6}d1");
    // dice [2,5,3,4] → drop lowest 1 (2) → keep [3,4,5] = 12
    expect(r.total).toBe(12);
    expect(r.groups?.[0].keptValues?.sort()).toEqual([3, 4, 5]);
  });
});

// ── Invariant tests (no mocking - properties that always hold) ────────────
describe("roll - invariants", () => {
  const REPS = 30;

  it("standard rolls always stay within [1, sides]", () => {
    for (let i = 0; i < REPS; i++) {
      const r = roll("4d6");
      const t = r.terms[0];
      for (const v of t.rolls as number[]) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(6);
      }
    }
  });

  it("rolls count matches dice count", () => {
    for (let i = 0; i < REPS; i++) {
      const r = roll("5d10");
      expect(r.terms[0].rolls).toHaveLength(5);
    }
  });

  it("kept count equals keep.count for kh", () => {
    for (let i = 0; i < REPS; i++) {
      const r = roll("4d6kh3");
      expect(r.terms[0].kept).toHaveLength(3);
    }
  });

  it("kept total equals roll total for no-keep expression", () => {
    for (let i = 0; i < REPS; i++) {
      const r = roll("3d8");
      const keptSum = (r.terms[0].kept as number[]).reduce((s, v) => s + v, 0);
      expect(keptSum).toBe(r.total);
    }
  });

  it("fate dice always produce values in {-1, 0, 1}", () => {
    for (let i = 0; i < REPS; i++) {
      const r = roll("4dF");
      for (const v of r.terms[0].rolls as number[]) {
        expect([-1, 0, 1]).toContain(v);
      }
    }
  });

  it("pool dice always return one of the defined faces", () => {
    const faces = [2, 4, 6, 8];
    for (let i = 0; i < REPS; i++) {
      const r = roll("3d[2,4,6,8]");
      for (const v of r.terms[0].rolls as number[]) {
        expect(faces).toContain(v);
      }
    }
  });

  it("table dice always return one of the defined entries", () => {
    const entries = ["fire", "ice", "lightning"];
    for (let i = 0; i < REPS; i++) {
      const r = roll("1d[fire,ice,lightning]");
      expect(entries).toContain(r.terms[0].rolls[0]);
    }
  });

  it("total is the sum of kept values for a plain expression", () => {
    for (let i = 0; i < REPS; i++) {
      const r = roll("2d6+1d4+3");
      const computedTotal = r.terms.reduce((s, t) => {
        const keptSum = (t.kept as number[]).reduce((ks, v) => ks + v, 0);
        if (t.operatorPrefix === "-") return s - keptSum;
        return s + keptSum;
      }, 0);
      expect(r.total).toBe(computedTotal);
    }
  });

  it("minTotal <= every roll total <= maxTotal", () => {
    for (let i = 0; i < REPS; i++) {
      const r = roll("2d8+1d6+2");
      if (r.minTotal !== null) expect(r.total).toBeGreaterThanOrEqual(r.minTotal);
      if (r.maxTotal !== null) expect(r.total).toBeLessThanOrEqual(r.maxTotal);
    }
  });
});

// ── Additional coverage ────────────────────────────────────────────────────

describe("roll - sort modifiers", () => {
  it("parseDice: 4d6s has sort=asc", () => {
    const expr = parseDice("4d6s");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.sort).toBe("asc");
  });

  it("parseDice: 4d6sd has sort=desc", () => {
    const expr = parseDice("4d6sd");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.sort).toBe("desc");
  });

  it("4d6s: rolls array is in ascending order", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 5))
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 4))
      .mockReturnValueOnce(d(6, 2));
    const r = roll("4d6s");
    expect(r.terms[0].rolls).toEqual([1, 2, 4, 5]);
    expect(r.total).toBe(12);
  });

  it("4d6sd: rolls array is in descending order", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 5))
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 4))
      .mockReturnValueOnce(d(6, 2));
    const r = roll("4d6sd");
    expect(r.terms[0].rolls).toEqual([5, 4, 2, 1]);
    expect(r.total).toBe(12);
  });
});

describe("roll - additional math functions", () => {
  it("round() rounds to nearest integer", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 2));
    // (3+2)/2 = 2.5 → round → 3
    const r = roll("round(2d6/2)");
    expect(r.total).toBe(3);
  });

  it("abs() returns absolute value", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 2))
      .mockReturnValueOnce(d(6, 5));
    // 2-5 = -3 → abs → 3
    const r = roll("abs(1d6-1d6)");
    expect(r.total).toBe(3);
  });
});

describe("roll - group failure count", () => {
  it("{3d6}>3f1: counts successes minus failures across group", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))  // 1: failure (=1)
      .mockReturnValueOnce(d(6, 5))  // 5: success (>3)
      .mockReturnValueOnce(d(6, 4)); // 4: success (>3)
    const r = roll("{3d6}>3f1");
    // 2 successes - 1 failure = 1
    expect(r.groups?.[0].successCount).toBe(2);
    expect(r.groups?.[0].failureCount).toBe(1);
    expect(r.total).toBe(1);
  });
});

describe("roll - expression-level success threshold operators", () => {
  it("1d20+5>=15: success when total is exactly the threshold", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(d(20, 10)); // 10+5=15
    const r = roll("1d20+5>=15");
    expect(r.total).toBe(15);
    expect(r.successCount).toBe(1);
  });

  it("1d20+5>=15: failure when total is below threshold", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(d(20, 9)); // 9+5=14
    const r = roll("1d20+5>=15");
    expect(r.total).toBe(14);
    expect(r.successCount).toBe(0);
  });

  it("1d6+2<5: expression-level success when total is strictly less than threshold", () => {
    // The < must follow a compound expression so the tokenizer emits it as a cmp token.
    vi.spyOn(Math, "random").mockReturnValueOnce(d(6, 2)); // 2+2=4 < 5 → success
    const r = roll("1d6+2<5");
    expect(r.total).toBe(4);
    expect(r.successCount).toBe(1);
  });

  it("1d6+2<5: failure when total equals the threshold (strict less-than)", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(d(6, 3)); // 3+2=5, not < 5
    const r = roll("1d6+2<5");
    expect(r.total).toBe(5);
    expect(r.successCount).toBe(0);
  });
});

// ── Computed dice count / sides - (N+Y)dX and Nd(X+Y) ─────────────────────
describe("parseDice - computed dice", () => {
  it("(2+3)d6 stores the count expression on the term", () => {
    const expr = parseDice("(2+3)d6");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.sides).toBe(6);
    expect(t.computedCount).toBeDefined();
    expect(t.computedSides).toBeUndefined();
  });

  it("2d(3+3) stores the sides expression on the term", () => {
    const expr = parseDice("2d(3+3)");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.count).toBe(2);
    expect(t.computedCount).toBeUndefined();
    expect(t.computedSides).toBeDefined();
  });

  it("(2+3)d(2*3) stores both count and sides expressions", () => {
    const expr = parseDice("(2+3)d(2*3)");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.computedCount).toBeDefined();
    expect(t.computedSides).toBeDefined();
  });

  it("(2+1)dF stores the count expression on a fate term", () => {
    const expr = parseDice("(2+1)dF");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("fate");
    if (t.type !== "fate") return;
    expect(t.computedCount).toBeDefined();
  });

  it("(2+2)d6kh3 attaches modifiers to the computed-count term", () => {
    const expr = parseDice("(2+2)d6kh3");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.keep).toEqual({ mode: "h", count: 3 });
    expect(t.computedCount).toBeDefined();
  });
});

describe("roll - computed dice", () => {
  it("(2+3)d6 rolls 5 d6 dice", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 4))
      .mockReturnValueOnce(d(6, 5))
      .mockReturnValueOnce(d(6, 6))
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 2));
    const r = roll("(2+3)d6");
    expect(r.terms[0].rolls).toEqual([4, 5, 6, 1, 2]);
    expect(r.total).toBe(18);
  });

  it("2d(3+3) rolls 2 dice with 6 sides each", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 5));
    const r = roll("2d(3+3)");
    expect(r.terms[0].rolls).toEqual([3, 5]);
    expect(r.terms[0].maxFace).toBe(6);
    expect(r.total).toBe(8);
  });

  it("(1+1)d(2*3) rolls 2 dice with 6 sides", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 6))
      .mockReturnValueOnce(d(6, 2));
    const r = roll("(1+1)d(2*3)");
    expect(r.terms[0].rolls).toEqual([6, 2]);
    expect(r.total).toBe(8);
  });

  it("(2.5+0.5)d6 rounds the count to the nearest integer (3)", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 2))
      .mockReturnValueOnce(d(6, 3));
    const r = roll("(2.5+0.5)d6");
    expect(r.terms[0].rolls).toHaveLength(3);
    expect(r.total).toBe(6);
  });

  it("(2+0.5)d6 rounds 2.5 up to 3 (Math.round behavior)", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 1));
    const r = roll("(2+0.5)d6");
    expect(r.terms[0].rolls).toHaveLength(3);
  });

  it("(2+2)d6kh3 keeps top 3 of 4 computed-count dice", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 5))
      .mockReturnValueOnce(d(6, 4))
      .mockReturnValueOnce(d(6, 3));
    const r = roll("(2+2)d6kh3");
    expect((r.terms[0].kept as number[]).sort()).toEqual([3, 4, 5]);
    expect(r.total).toBe(12);
  });

  it("(2+1)dF rolls 3 fate dice", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(fate(1))
      .mockReturnValueOnce(fate(0))
      .mockReturnValueOnce(fate(-1));
    const r = roll("(2+1)dF");
    expect(r.terms[0].rolls).toEqual([1, 0, -1]);
    expect(r.total).toBe(0);
  });

  it("min/max are null for computed dice (count not statically known)", () => {
    vi.spyOn(Math, "random").mockReturnValue(d(6, 3));
    const r = roll("(1+2)d6");
    expect(r.minTotal).toBeNull();
    expect(r.maxTotal).toBeNull();
  });

  it("computed term composes with arithmetic: (1+2)d6+5", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 4))
      .mockReturnValueOnce(d(6, 4))
      .mockReturnValueOnce(d(6, 4));
    const r = roll("(1+2)d6+5");
    // 4+4+4 = 12 + 5 = 17
    expect(r.total).toBe(17);
  });
});

// ── Dice matching - m / mt ────────────────────────────────────────────────
describe("parseDice - matching", () => {
  it("2d6m parses as show-mode match with default minMatches=2", () => {
    const expr = parseDice("2d6m");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.matches).toEqual({ kind: "show", minMatches: 2 });
  });

  it("2d6mt parses as tally-mode match", () => {
    const expr = parseDice("2d6mt");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.matches).toEqual({ kind: "tally", minMatches: 2 });
  });

  it("6d6mt3 sets minMatches=3", () => {
    const expr = parseDice("6d6mt3");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.matches).toEqual({ kind: "tally", minMatches: 3 });
  });

  it("5d6mt3>4 sets minMatches and target condition", () => {
    const expr = parseDice("5d6mt3>4");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.matches).toEqual({
      kind: "tally",
      minMatches: 3,
      targetCondition: { op: ">", value: 4 },
    });
  });

  it("4d6m>4 supports a target condition without minMatches override", () => {
    const expr = parseDice("4d6m>4");
    expect(expr.root.type).toBe("term");
    if (expr.root.type !== "term") return;
    const t = expr.root.term;
    expect(t.type).toBe("standard");
    if (t.type !== "standard") return;
    expect(t.matches).toEqual({
      kind: "show",
      minMatches: 2,
      targetCondition: { op: ">", value: 4 },
    });
  });
});

describe("roll - matching", () => {
  it("2d6m: matched pair does not change the total (sum mode)", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 4))
      .mockReturnValueOnce(d(6, 4));
    const r = roll("2d6m");
    expect(r.total).toBe(8); // sum unchanged
    expect(r.terms[0].matchedValues).toEqual([4]);
    expect(r.terms[0].matchCount).toBe(1);
  });

  it("2d6m: no pair leaves matchedValues empty", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 5));
    const r = roll("2d6m");
    expect(r.total).toBe(8);
    expect(r.terms[0].matchedValues).toEqual([]);
    expect(r.terms[0].matchCount).toBe(0);
  });

  it("2d6mt: matched pair → total = 1", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 4))
      .mockReturnValueOnce(d(6, 4));
    const r = roll("2d6mt");
    expect(r.total).toBe(1);
    expect(r.terms[0].matchCount).toBe(1);
  });

  it("2d6mt: no pair → total = 0", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 1))
      .mockReturnValueOnce(d(6, 6));
    const r = roll("2d6mt");
    expect(r.total).toBe(0);
    expect(r.terms[0].matchCount).toBe(0);
  });

  it("4d6mt: two distinct pairs → 2 match groups", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 5))
      .mockReturnValueOnce(d(6, 5));
    const r = roll("4d6mt");
    expect(r.terms[0].matchedValues).toEqual([3, 5]);
    expect(r.total).toBe(2);
  });

  it("6d6mt3: only counts groups of 3 or more", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 2))
      .mockReturnValueOnce(d(6, 2))  // pair of 2s - not enough
      .mockReturnValueOnce(d(6, 5))
      .mockReturnValueOnce(d(6, 5))
      .mockReturnValueOnce(d(6, 5))  // triple of 5s - counts
      .mockReturnValueOnce(d(6, 1));
    const r = roll("6d6mt3");
    expect(r.terms[0].matchedValues).toEqual([5]);
    expect(r.total).toBe(1);
  });

  it("5d6mt3>4: requires both 3+ matches AND value > 4", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 3))
      .mockReturnValueOnce(d(6, 3))  // triple of 3s - fails value > 4
      .mockReturnValueOnce(d(6, 6))
      .mockReturnValueOnce(d(6, 6));  // pair of 6s - fails count >= 3
    const r = roll("5d6mt3>4");
    expect(r.total).toBe(0);
  });

  it("5d6mt3>4: both conditions met", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 6))
      .mockReturnValueOnce(d(6, 6))
      .mockReturnValueOnce(d(6, 6))
      .mockReturnValueOnce(d(6, 6))
      .mockReturnValueOnce(d(6, 1));
    const r = roll("5d6mt3>4");
    expect(r.terms[0].matchedValues).toEqual([6]);
    expect(r.total).toBe(1);
  });

  it("matching considers exploded totals, not just base rolls", () => {
    // 2d6!m: each die explodes on max. Two dice both roll 6, then explode to 4 each → totals 10, 10.
    // Equal totals should match.
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(d(6, 6))  // die 1: 6 → explodes
      .mockReturnValueOnce(d(6, 4))  // explosion → 4 (no further)
      .mockReturnValueOnce(d(6, 6))  // die 2: 6 → explodes
      .mockReturnValueOnce(d(6, 4)); // explosion → 4 (no further)
    const r = roll("2d6!mt");
    expect(r.terms[0].rolls).toEqual([10, 10]);
    expect(r.terms[0].matchedValues).toEqual([10]);
    expect(r.total).toBe(1);
  });
});
