import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import type { CursorPager } from "@/hooks/useCursorPagination";

// The shared Newer / page-number / Older footer for cursor-paged lists.
// Hidden entirely on a single-page result set.
export function CursorPaginationFooter<T>({ pager }: { pager: CursorPager<T> }) {
  const { pageNumber, canNewer, canOlder, goNewer, goOlder } = pager;
  if (pageNumber <= 1 && !canOlder) return null;

  return (
    <Pagination className="mt-5">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href="#"
            aria-disabled={!canNewer}
            className={!canNewer ? "pointer-events-none opacity-50" : undefined}
            onClick={e => {
              e.preventDefault();
              goNewer();
            }}
          />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#" isActive onClick={e => e.preventDefault()}>
            {pageNumber}
          </PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            href="#"
            aria-disabled={!canOlder}
            className={!canOlder ? "pointer-events-none opacity-50" : undefined}
            onClick={e => {
              e.preventDefault();
              goOlder();
            }}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
