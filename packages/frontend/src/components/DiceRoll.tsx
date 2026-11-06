import { useState, useCallback, useRef, useEffect } from "react";
import { Dices, Sparkles } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { roll, splitFormulaLabel, cmpMatch, type RollResult, type TermResult, type GroupResult } from "@/lib/dice";
import { useRendererCtx } from "@/components/wysiwyg/context/RendererContext";

const opSymbol = (op: string) => op === "<=" ? "≤" : op === ">=" ? "≥" : op;

interface DiceRollProps {
  notation: string;
}

function dieColor(value: number | string, t: TermResult, critSt?: "success" | "fail" | null): string {
  if (typeof value === "string" || t.minFace === null || t.maxFace === null || t.minFace === t.maxFace) return "";
  if (critSt === "success") return "text-green-400";
  if (critSt === "fail") return "text-red-400";
  if (value >= t.maxFace) return "text-green-400";
  if (value === t.minFace) return "text-red-400";
  return "";
}

function DieValue({ value, term, tooltip, critStatus }: { value: number | string; term: TermResult; tooltip?: string; critStatus?: "success" | "fail" | null }) {
  const color = dieColor(value, term, critStatus);
  const span = <span className={color || undefined}>{value}</span>;
  if (!tooltip) return span;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{span}</TooltipTrigger>
      <TooltipContent side="top" className="font-sans text-xs">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function DiceList({ values, term, rerolledFrom, inlineLabel, critStatus, explosionChains }: { values: (number | string)[]; term: TermResult; rerolledFrom?: (number | undefined)[]; inlineLabel?: string; critStatus?: ("success" | "fail" | null)[]; explosionChains?: (number[] | undefined)[] }) {
  return (
    <>
      {"["}
      {values.map((v, i) => {
        const orig = rerolledFrom?.[i];
        const chain = explosionChains?.[i];
        return (
          <span key={i}>
            {i > 0 && ", "}
            {orig !== undefined && (
              <span className="line-through text-zinc-600 mr-0.5">{orig}</span>
            )}
            {chain && chain.length > 1 ? (
              <>
                {chain.map((r, ci) => {
                  const isLast = ci === chain.length - 1;
                  const color = isLast ? (dieColor(r, term, critStatus?.[i]) || "") : "text-amber-400";
                  return (
                    <span key={ci}>
                      {ci > 0 && <span className="text-amber-600">+</span>}
                      <span className={color || undefined}>{r}</span>
                      {!isLast && <span className="text-amber-500 text-[0.7em] align-super">!</span>}
                    </span>
                  );
                })}
              </>
            ) : (
              <DieValue value={v} term={term} tooltip={inlineLabel} critStatus={critStatus?.[i]} />
            )}
          </span>
        );
      })}
      {"]"}
    </>
  );
}

function resolveLabels(terms: TermResult[]): TermResult[] {
  const out = [...terms];
  let carry: string | undefined;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].inlineLabel) carry = out[i].inlineLabel;
    else if (carry) out[i] = { ...out[i], inlineLabel: carry };
  }
  return out;
}

const OP_LABEL: Record<string, string> = {
  "+": "+", "-": "−", "*": "×", "/": "÷", "%": "mod", "**": "^",
};

function OpPrefix({ op }: { op?: string }) {
  if (!op) return null;
  return <span className="text-zinc-500 mr-1">{OP_LABEL[op] ?? op}</span>;
}

function TermLine({ t }: { t: TermResult }) {
  const isTable = t.kept.some((v) => typeof v === "string");
  const isConstant = t.minFace === null && !isTable;

  if (isConstant) {
    // For constants used as operands (e.g. the divisor in 2d8/2), just show the operator + value.
    if (t.operatorPrefix) {
      return (
        <div>
          <OpPrefix op={t.operatorPrefix} />
          <span className="text-zinc-300">{t.total}</span>
        </div>
      );
    }
    const val = <span className="text-zinc-300"> = {t.total}</span>;
    return (
      <div>
        <span className="text-zinc-400">{t.label}</span>
        {t.inlineLabel ? (
          <>
            <span className="text-zinc-500"> [{t.inlineLabel}]</span>
            <Tooltip>
              <TooltipTrigger asChild>{val}</TooltipTrigger>
              <TooltipContent side="top" className="font-sans text-xs">{t.inlineLabel}</TooltipContent>
            </Tooltip>
          </>
        ) : val}
      </div>
    );
  }

  if (isTable) {
    return (
      <div>
        <OpPrefix op={t.operatorPrefix} />
        <span className="text-zinc-400">{t.label}</span>
        {t.inlineLabel && <span className="text-zinc-500"> [{t.inlineLabel}]</span>}
        <span className="text-zinc-300">: </span>
        <DiceList values={t.kept} term={t} inlineLabel={t.inlineLabel} />
      </div>
    );
  }

  const hasKeep = t.rolls.length !== t.kept.length;
  const st = t.successThreshold;
  const ft = t.failureThreshold;
  const stLabel = st ? `${opSymbol(st.op)} ${st.value}` : undefined;
  const ftLabel = ft ? `${opSymbol(ft.op)} ${ft.value}` : undefined;

  // For success-counting terms, colour each die: success=green, failure=red, neither=uncolored (3-state when ft present).
  const successCritStatus = st && t.successMet
    ? t.successMet.map((met, i): "success" | "fail" | null => {
        if (met) return "success";
        if (t.failureMet?.[i]) return "fail";
        return ft ? null : "fail";
      })
    : undefined;

  return (
    <div>
      <OpPrefix op={t.operatorPrefix} />
      <span className="text-zinc-400">{t.label}</span>
      {t.inlineLabel && <span className="text-zinc-500"> [{t.inlineLabel}]</span>}
      <span className="text-zinc-400">: </span>
      <DiceList values={t.rolls} term={t} rerolledFrom={t.rerolledFrom} inlineLabel={t.inlineLabel} critStatus={successCritStatus ?? t.critStatus} explosionChains={t.explosionChains} />
      {hasKeep && (
        <>
          <span className="text-zinc-500"> keep </span>
          <DiceList values={t.kept} term={t} inlineLabel={t.inlineLabel} />
        </>
      )}
      {st
        ? ft && t.failureCount !== undefined
          ? <span className="text-zinc-300">
              {" = "}{t.successCount} <span className="text-zinc-500">succ ({stLabel})</span>
              {" − "}{t.failureCount} <span className="text-zinc-500">fail ({ftLabel})</span>
              {" = "}{t.total}
            </span>
          : <span className="text-zinc-300"> = {t.total} <span className="text-zinc-500">successes ({stLabel})</span></span>
        : <span className="text-zinc-300"> = {t.total}</span>
      }
    </div>
  );
}

function GroupBreakdown({ group }: { group: GroupResult }) {
  const { keep, drop, keepMode, members, keptValues, total, successThreshold, successCount, failureThreshold, failureCount } = group;
  const stLabel = successThreshold ? `${opSymbol(successThreshold.op)} ${successThreshold.value}` : undefined;
  const ftLabel = failureThreshold ? `${opSymbol(failureThreshold.op)} ${failureThreshold.value}` : undefined;
  const modLabel = drop ? `drop ${drop.mode}${drop.count}` : keep ? `keep ${keep.mode}${keep.count}` : undefined;

  if (keepMode === "individual") {
    const terms = resolveLabels(members[0].terms);

    if (successThreshold) {
      const matchST = (v: number) => cmpMatch(successThreshold.op, v, successThreshold.value);
      const matchFT = failureThreshold
        ? (v: number) => cmpMatch(failureThreshold.op, v, failureThreshold.value)
        : null;
      // Show all dice, colour each by whether it met success/failure threshold
      const allValues = terms.flatMap((t) => t.kept.filter((v): v is number => typeof v === "number"));
      return (
        <div className="border-l-2 border-zinc-600 pl-2 my-0.5 space-y-0.5">
          {terms.map((t, i) => <TermLine key={i} t={t} />)}
          <div>
            <span className="text-zinc-500">successes ({stLabel}): </span>
            <span className="text-zinc-300">[{allValues.map((v, i) => {
              const isSuccess = matchST(v);
              const isFailure = matchFT ? matchFT(v) : false;
              return (
                <span key={i}>
                  {i > 0 && ", "}
                  <span className={isSuccess ? "text-green-400" : isFailure ? "text-red-400" : ""}>{v}</span>
                </span>
              );
            })}]</span>
            {failureThreshold && failureCount !== undefined
              ? <span className="text-zinc-300"> = {successCount} − {failureCount} <span className="text-zinc-500">fail ({ftLabel})</span> = {total}</span>
              : <span className="text-zinc-300"> = {successCount} successes</span>
            }
          </div>
        </div>
      );
    }

    return (
      <div className="border-l-2 border-zinc-600 pl-2 my-0.5 space-y-0.5">
        {terms.map((t, i) => <TermLine key={i} t={t} />)}
        {modLabel && (
          <div>
            <span className="text-zinc-500">{modLabel}: </span>
            <span className="text-zinc-300">[{keptValues!.join(", ")}]</span>
            <span className="text-zinc-300"> = {total}</span>
          </div>
        )}
      </div>
    );
  }

  // Sum mode: show each member with kept/dropped or success indicator
  const matchST_sum = successThreshold
    ? (v: number) => cmpMatch(successThreshold.op, v, successThreshold.value)
    : null;
  const matchFT_sum = failureThreshold
    ? (v: number) => cmpMatch(failureThreshold.op, v, failureThreshold.value)
    : null;
  return (
    <div className="border-l-2 border-zinc-600 pl-2 my-0.5 space-y-0.5">
      {members.map((member, mi) => {
        const terms = resolveLabels(member.terms);
        const isSuccess = matchST_sum ? matchST_sum(member.total) : member.kept;
        const isFailure = matchFT_sum ? matchFT_sum(member.total) : false;
        const icon = isSuccess ? "✓" : isFailure ? "✗" : successThreshold ? "−" : "✗";
        const iconColor = isSuccess ? "text-green-400" : isFailure ? "text-red-400" : "text-zinc-500";
        return (
          <div key={mi} className={!successThreshold && !member.kept ? "opacity-40" : ""}>
            <div className="flex items-start gap-1">
              <span className={`text-xs mt-0.5 ${iconColor}`}>{icon}</span>
              <div className="space-y-0.5">
                {terms.map((t, i) => <TermLine key={i} t={t} />)}
                <div>
                  <span className="text-zinc-500">sum: </span>
                  <span className="text-zinc-300">{member.total}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
      <div className="border-t border-zinc-700 pt-0.5">
        {successThreshold
          ? failureThreshold && failureCount !== undefined
            ? <><span className="text-zinc-500">successes ({stLabel}) = </span><span className="text-zinc-300">{successCount} − {failureCount} <span className="text-zinc-500">fail ({ftLabel})</span> = {total}</span></>
            : <><span className="text-zinc-500">successes ({stLabel}) = </span><span className="text-zinc-300">{successCount}</span></>
          : modLabel
            ? <><span className="text-zinc-500">{modLabel} = </span><span className="text-zinc-300">{total}</span></>
            : null
        }
      </div>
    </div>
  );
}

function buildBreakdown(result: RollResult) {
  const hasGroups = (result.groups?.length ?? 0) > 0;
  const isStringOnly =
    !hasGroups &&
    result.terms.every(
      (t) => t.minFace === null && t.kept.some((v) => typeof v === "string"),
    );
  const isDiceSuccessCount =
    result.terms.some((t) => t.successThreshold) ||
    result.groups?.some((g) => g.successThreshold);
  const exprST = result.successThreshold;
  const exprSTLabel = exprST ? `${opSymbol(exprST.op)} ${exprST.value}` : undefined;
  const terms = resolveLabels(result.terms);

  return (
    <div className="space-y-0.5">
      {result.label && (
        <div className="text-zinc-300 font-sans font-medium pb-0.5">{result.label}</div>
      )}
      {terms.map((t, i) => <TermLine key={i} t={t} />)}
      {result.groups?.map((g, gi) => <GroupBreakdown key={gi} group={g} />)}
      {result.annotations?.map((a, i) => (
        <div key={i} className="text-zinc-500 italic">{a}</div>
      ))}
      <div className="border-t border-zinc-600 pt-0.5 text-zinc-200">
        {isStringOnly
          ? <>Result: {terms.flatMap((t) => t.kept).join(", ")}</>
          : isDiceSuccessCount
            ? <>{result.total} <span className="text-zinc-400">successes</span></>
            : exprST
              ? <>
                  <span className="text-zinc-400">Total: </span>{result.total}
                  <span className={`ml-2 font-semibold ${result.successCount === 1 ? "text-green-400" : "text-red-400"}`}>
                    {result.successCount === 1 ? `✓ Success (${exprSTLabel})` : `✗ Failure (${exprSTLabel})`}
                  </span>
                </>
              : <>Total: {result.total}</>}
      </div>
    </div>
  );
}

function tryRoll(notation: string): RollResult | null {
  try {
    return roll(notation);
  } catch {
    return null;
  }
}

export function DiceRoll({ notation }: DiceRollProps) {
  const [result, setResult] = useState<RollResult | "invalid" | null>(null);
  const [rollKey, setRollKey] = useState(0);
  const [open, setOpen] = useState(false);
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blockOpenRef = useRef(false);
  const { showInkCritSparkles } = useRendererCtx();

  const clearTouchTimer = useCallback(() => {
    if (touchTimerRef.current) {
      clearTimeout(touchTimerRef.current);
      touchTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearTouchTimer, [clearTouchTimer]);

  const doRoll = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearTouchTimer();
      setResult(tryRoll(notation) ?? "invalid");
      setRollKey((k) => k + 1);
      setOpen(false);
    },
    [notation, clearTouchTimer],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen && blockOpenRef.current) return;
    setOpen(nextOpen);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
    blockOpenRef.current = true;
    clearTouchTimer();
    touchTimerRef.current = setTimeout(() => {
      blockOpenRef.current = false;
      setOpen(true);
      touchTimerRef.current = null;
    }, 200);
  }, [clearTouchTimer]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
    clearTouchTimer();
    // Keep blocking long enough to cover Radix's openDelay + synthetic mouse events
    setTimeout(() => { blockOpenRef.current = false; }, 700);
  }, [clearTouchTimer]);

  if (result === "invalid") {
    return (
      <span
        className="rounded bg-red-900/40 px-1.5 py-0.5 text-[0.875em] text-red-300"
        style={{ fontFamily: "var(--ui-font)" }}
      >
        dice: {notation}
      </span>
    );
  }

  if (result === null) {
    return (
      <button
        onClick={doRoll}
        className="inline-flex max-w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border border-input/70 bg-card px-2 py-0.5 text-left align-middle text-[0.875em] font-medium text-foreground shadow-xs hover:bg-accent transition-colors cursor-pointer max-sm:my-1 max-sm:min-h-11 max-sm:px-3 max-sm:py-1.5 max-sm:text-sm max-sm:whitespace-normal"
        style={{ fontFamily: "var(--ui-font)" }}
      >
        <Dices className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <DiceLabel notation={notation} />
      </button>
    );
  }

  const hasGroups = (result.groups?.length ?? 0) > 0;
  const isStringOnly =
    !hasGroups &&
    result.terms.every((t) => t.kept.some((v) => typeof v === "string"));
  const isDiceSuccessCount =
    result.terms.some((t) => t.successThreshold) ||
    (result.groups ?? []).some((g) => g.successThreshold);
  const exprST = result.successThreshold;
  const displayValue = isStringOnly
    ? result.terms.flatMap((t) => t.kept).join(", ")
    : result.total;
  const isMaxRoll = !isStringOnly && result.maxTotal !== null && result.total === result.maxTotal;
  const isMinRoll = !isStringOnly && result.minTotal !== null && result.total === result.minTotal;
  const anyCritSuccess = result.terms.some((t) => t.anyCritSuccess);
  const anyCritFail = result.terms.some((t) => t.anyCritFail);
  const isCritSuccess = anyCritSuccess || isMaxRoll;
  const showInkSparkles = !!showInkCritSparkles && isCritSuccess;

  return (
    <HoverCard key={rollKey} open={open} onOpenChange={handleOpenChange} openDelay={200}>
      <HoverCardTrigger asChild>
        <button
          onClick={doRoll}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-input/70 bg-card px-2 py-0.5 text-left text-[0.875em] text-foreground shadow-xs select-none not-prose hover:bg-accent transition-colors cursor-pointer max-sm:my-1 max-sm:min-h-11 max-sm:px-3 max-sm:py-1.5 max-sm:text-sm max-sm:whitespace-normal"
          style={{ fontFamily: "var(--ui-font)" }}
          aria-label="Re-roll"
        >
          <Dices className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono text-[0.85em] text-muted-foreground max-sm:text-[0.9em] max-sm:break-words">{prettyFormula(splitFormulaLabel(notation).formula)}</span>
          {result.label && (
            <span className="text-zinc-400">{result.label}</span>
          )}
          <span className="text-zinc-500">:</span>
          <span className={`relative font-semibold ${isMaxRoll || anyCritSuccess ? "text-green-400" : isMinRoll || anyCritFail ? "text-red-400" : "text-zinc-100"}`}>
            {displayValue}
            {showInkSparkles && (
              <span className="ink-crit-sparkles" aria-hidden="true">
                <Sparkles className="ink-crit-sparkle ink-crit-sparkle-1" />
                <Sparkles className="ink-crit-sparkle ink-crit-sparkle-2" />
                <Sparkles className="ink-crit-sparkle ink-crit-sparkle-3" />
                <Sparkles className="ink-crit-sparkle ink-crit-sparkle-4" />
                <Sparkles className="ink-crit-sparkle ink-crit-sparkle-5" />
              </span>
            )}
          </span>
          {isDiceSuccessCount && <span className="text-zinc-400 font-normal">succ</span>}
          {exprST && (
            <span className={`font-semibold ${result.successCount === 1 ? "text-green-400" : "text-red-400"}`}>
              {result.successCount === 1 ? "✓" : "✗"}
            </span>
          )}
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" className="max-w-xs font-mono text-xs">
        {buildBreakdown(result)}
      </HoverCardContent>
    </HoverCard>
  );
}


// Readable formula: a space after commas inside custom-face lists, so
// "1d[V60,French press]" reads as "1d[V60, French press]".
function prettyFormula(formula: string): string {
  return formula.replace(/,\s*/g, ", ");
}

// Unrolled chip text: the human label first, the dice syntax second and
// quieter - readers see "Try your luck · 2d6+1d4", not run-together notation.
function DiceLabel({ notation }: { notation: string }) {
  const { formula, label } = splitFormulaLabel(notation);
  // No label: the notation is the only text, so keep it quiet (muted, medium)
  // and on one line, truncating long custom-face lists (full text in title).
  if (!label) return <span title={prettyFormula(formula)} className="min-w-0 truncate font-mono text-[0.85em] max-sm:text-[0.9em] max-sm:whitespace-normal max-sm:break-words font-medium text-muted-foreground">{prettyFormula(formula)}</span>;
  return (
    <span className="inline-flex min-w-0 items-baseline gap-x-1.5">
      <span>{label}</span>
      <span aria-hidden="true" className="text-muted-foreground/60">&middot;</span>
      <span className="truncate font-mono text-[0.85em] max-sm:text-[0.9em] max-sm:whitespace-normal max-sm:break-words font-normal text-muted-foreground">{prettyFormula(formula)}</span>
    </span>
  );
}
