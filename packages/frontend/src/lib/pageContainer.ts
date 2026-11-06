// Shared page containers, so every in-app page shares one of two left edges
// with the document column.
//
// DocPage lays a doc out as a flex row: an article pane (px-4 sm:px-6) holding
// a centred 44rem column, plus a w-60 (15rem) outline rail on the right at xl.
// So at xl the doc column's left edge sits (paneContent - 15rem - 44rem) / 2
// into the padded pane, and below xl it is simply centred. The containers
// below reproduce that edge in a single padded block (no rail element):
//
//   <div className={PAGE_PADDING}>
//     <div className={READING_CONTAINER | WIDE_CONTAINER}>…</div>
//   </div>
//
// READING is the doc column itself (44rem). WIDE (59rem) keeps the same left
// edge at xl and runs further right; below xl it is centred, since there's no
// rail to offset against. Both rely on the container being a block child
// (width auto) of the padded wrapper - don't add w-full, or the WIDE offset
// would overflow the pane at 1280px.
//
// Measured at a 256px sidebar: 1280 → x=296, 1440 → x=376, 1920 → x=616 for
// both the doc column and these containers.

/** Pane padding matching DocPage's article pane (top/sides). */
export const PAGE_PADDING = "px-4 py-6 sm:px-6 sm:py-10";

/** xl: the doc column's left offset inside the padded pane (15rem rail + 44rem column). */
const DOC_COLUMN_LEFT = "xl:ml-[max(0px,calc((100%_-_59rem)/2))]";

/** The doc reading column (44rem / 704px): profile, tag lists, file headers. */
export const READING_CONTAINER = `mx-auto max-w-[44rem] ${DOC_COLUMN_LEFT}`;

/** Wide index pages (59rem / 944px - equal 120px margins at 1440): dashboard, wide file previews. */
export const WIDE_CONTAINER = `mx-auto max-w-[59rem] ${DOC_COLUMN_LEFT}`;
