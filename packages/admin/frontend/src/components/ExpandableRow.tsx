// The click/keyboard a11y props for a table row that toggles an expansion
// row (previously repeated inline on Users / Projects / Audit rows).
export function expandableRowProps(
  expanded: boolean,
  setExpanded: (updater: (v: boolean) => boolean) => void,
  enabled = true,
) {
  if (!enabled) return {};
  return {
    className: "cursor-pointer",
    role: "button" as const,
    tabIndex: 0,
    "aria-expanded": expanded,
    onClick: () => setExpanded(v => !v),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setExpanded(v => !v);
      }
    },
  };
}
