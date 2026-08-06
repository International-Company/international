'use client';

import { type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Inbox } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { cn } from './utils';
import { Button, EmptyState, LoadingRows } from './primitives';

/**
 * The data table used by every list screen.
 *
 * Sorting and pagination are server-driven — a busy branch accumulates hundreds
 * of thousands of transactions, and shipping them to the browser to sort in
 * memory stops working long before that. The component owns presentation only;
 * the page owns the query.
 *
 * Direction is handled by logical CSS properties and the `dir` on <html>, so
 * there is no RTL-specific table code anywhere.
 */

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Renders the cell. Receives the whole row. */
  cell: (row: T, index: number) => ReactNode;
  align?: 'start' | 'center' | 'end';
  /** Sort key sent to the server. Omit to make the column unsortable. */
  sortKey?: string;
  width?: string;
  /**
   * Drop this column from the table on narrow screens. It still appears in the
   * card layout, where there is room for it.
   */
  hideOnMobile?: boolean;
  /** Numeric columns get tabular figures and LTR isolation. */
  numeric?: boolean;
  /**
   * Promotes the column to the card headline on mobile instead of appearing as
   * a labelled row. Defaults to the first column.
   */
  primary?: boolean;
  /** Never render this column in the card layout. */
  hideOnCard?: boolean;
}

export interface SortState {
  field: string;
  order: 'asc' | 'desc';
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
    onPageChange: (page: number) => void;
    onPageSizeChange?: (pageSize: number) => void;
  };
  className?: string;
  /** Renders under each row — used for expandable detail. */
  renderSubRow?: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  onRowClick,
  sort,
  onSortChange,
  emptyTitle,
  emptyDescription,
  emptyAction,
  pagination,
  className,
  renderSubRow,
}: DataTableProps<T>) {
  const { t, isRtl } = useLocale();

  const handleSort = (column: Column<T>) => {
    if (!column.sortKey || !onSortChange) return;

    const isCurrent = sort?.field === column.sortKey;
    onSortChange({
      field: column.sortKey,
      // First click on a new column sorts descending — the newest and largest
      // values are what an operator almost always wants to see first.
      order: isCurrent && sort.order === 'desc' ? 'asc' : 'desc',
    });
  };

  const alignClass = (align?: Column<T>['align']) =>
    align === 'end' ? 'text-end' : align === 'center' ? 'text-center' : 'text-start';

  return (
    <div className={cn('flex flex-col', className)}>
      {/* ---------------------------------------------------------------- */}
      {/* Card layout — phones                                             */}
      {/*                                                                  */}
      {/* A dense financial table does not survive a 375px screen, and     */}
      {/* horizontal scrolling hides exactly the columns an operator needs */}
      {/* to compare. Each row becomes a card instead: the headline stays  */}
      {/* scannable and every other column is labelled, so nothing is lost */}
      {/* the way it is when columns are simply dropped.                   */}
      {/* ---------------------------------------------------------------- */}
      {!loading && rows.length > 0 && (
        <ul className="divide-y divide-border-base sm:hidden">
          {rows.map((row, index) => (
            <MobileCard
              key={rowKey(row)}
              row={row}
              index={index}
              columns={columns}
              onRowClick={onRowClick}
              renderSubRow={renderSubRow}
            />
          ))}
        </ul>
      )}

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border-base bg-surface-sunken">
              {columns.map((column) => {
                const sortable = Boolean(column.sortKey && onSortChange);
                // Both sides must exist. `sort?.field === column.sortKey` reads
                // as undefined === undefined on an unsorted table whose column
                // has no sort key — which is true, and then dereferences a
                // `sort` that is not there.
                const isSorted = Boolean(sort && column.sortKey && sort.field === column.sortKey);

                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={column.width ? { width: column.width } : undefined}
                    aria-sort={
                      isSorted ? (sort!.order === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                    className={cn(
                      'px-[var(--cell-padding-x)] py-2 text-xs font-medium text-content-secondary',
                      'whitespace-nowrap',
                      alignClass(column.align),
                      column.hideOnMobile && 'hidden sm:table-cell',
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => handleSort(column)}
                        className={cn(
                          'inline-flex items-center gap-1 transition-colors hover:text-content',
                          isSorted && 'text-content',
                        )}
                      >
                        {column.header}
                        {isSorted ? (
                          sort!.order === 'asc' ? (
                            <ArrowUp className="size-3" />
                          ) : (
                            <ArrowDown className="size-3" />
                          )
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          {!loading && rows.length > 0 && (
            <tbody className="divide-y divide-border-base">
              {rows.map((row, index) => (
                <RowGroup
                  key={rowKey(row)}
                  row={row}
                  index={index}
                  columns={columns}
                  onRowClick={onRowClick}
                  alignClass={alignClass}
                  renderSubRow={renderSubRow}
                />
              ))}
            </tbody>
          )}
        </table>
      </div>

      {loading && <LoadingRows rows={6} columns={Math.min(columns.length, 5)} />}

      {!loading && rows.length === 0 && (
        <EmptyState
          icon={<Inbox />}
          title={emptyTitle ?? t('common.noResults')}
          description={emptyDescription ?? t('common.noResultsHint')}
          action={emptyAction}
        />
      )}

      {pagination && pagination.total > 0 && (
        <Pagination pagination={pagination} isRtl={isRtl} />
      )}
    </div>
  );
}

/**
 * One row rendered as a card for narrow screens.
 *
 * The headline column carries the row's identity — a reference, a name — and
 * everything else is shown as a labelled pair. Columns hidden from the table on
 * mobile reappear here, because the card has the room the table did not.
 */
function MobileCard<T>({
  row,
  index,
  columns,
  onRowClick,
  renderSubRow,
}: {
  row: T;
  index: number;
  columns: Column<T>[];
  onRowClick?: (row: T) => void;
  renderSubRow?: (row: T) => ReactNode;
}) {
  const headline = columns.find((column) => column.primary) ?? columns[0];
  const details = columns.filter(
    (column) => column !== headline && !column.hideOnCard,
  );

  const subRow = renderSubRow?.(row);

  return (
    <li>
      <div
        onClick={onRowClick ? () => onRowClick(row) : undefined}
        role={onRowClick ? 'button' : undefined}
        tabIndex={onRowClick ? 0 : undefined}
        onKeyDown={
          onRowClick
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onRowClick(row);
                }
              }
            : undefined
        }
        className={cn(
          'px-4 py-3 transition-colors',
          onRowClick && 'cursor-pointer active:bg-surface-active',
        )}
      >
        {headline && (
          <div className="mb-2 text-sm font-medium text-content">
            {headline.cell(row, index)}
          </div>
        )}

        <dl className="space-y-1.5">
          {details.map((column) => {
            const value = column.cell(row, index);
            if (value === null || value === undefined || value === '') return null;

            // A column with no header is an action group — give it the full
            // width rather than an empty label beside it.
            const hasLabel = column.header !== '' && column.header !== undefined;

            return hasLabel ? (
              <div key={column.key} className="flex items-start justify-between gap-3">
                <dt className="shrink-0 text-xs text-content-secondary">{column.header}</dt>
                <dd
                  className={cn(
                    'min-w-0 text-end text-sm text-content',
                    column.numeric && 'tabular-nums numeric',
                  )}
                >
                  {value}
                </dd>
              </div>
            ) : (
              <div key={column.key} className="pt-1">
                {value}
              </div>
            );
          })}
        </dl>
      </div>

      {subRow && <div className="bg-surface-sunken px-4 py-3">{subRow}</div>}
    </li>
  );
}

function RowGroup<T>({
  row,
  index,
  columns,
  onRowClick,
  alignClass,
  renderSubRow,
}: {
  row: T;
  index: number;
  columns: Column<T>[];
  onRowClick?: (row: T) => void;
  alignClass: (align?: Column<T>['align']) => string;
  renderSubRow?: (row: T) => ReactNode;
}) {
  const subRow = renderSubRow?.(row);

  return (
    <>
      <tr
        onClick={onRowClick ? () => onRowClick(row) : undefined}
        // Rows that navigate must be reachable and activatable by keyboard.
        tabIndex={onRowClick ? 0 : undefined}
        onKeyDown={
          onRowClick
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onRowClick(row);
                }
              }
            : undefined
        }
        className={cn(
          'transition-colors',
          onRowClick && 'cursor-pointer hover:bg-surface-hover focus-visible:bg-surface-hover',
        )}
      >
        {columns.map((column) => (
          <td
            key={column.key}
            className={cn(
              'px-[var(--cell-padding-x)] py-[var(--cell-padding-y)] text-sm text-content align-middle',
              alignClass(column.align),
              column.numeric && 'tabular-nums numeric',
              column.hideOnMobile && 'hidden sm:table-cell',
            )}
          >
            {column.cell(row, index)}
          </td>
        ))}
      </tr>
      {subRow && (
        <tr>
          <td colSpan={columns.length} className="bg-surface-sunken px-[var(--cell-padding-x)] py-3">
            {subRow}
          </td>
        </tr>
      )}
    </>
  );
}

function Pagination({
  pagination,
  isRtl,
}: {
  pagination: NonNullable<DataTableProps<unknown>['pagination']>;
  isRtl: boolean;
}) {
  const { t } = useLocale();
  const { page, pageSize, total, pageCount, onPageChange, onPageSizeChange } = pagination;

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  // In RTL, "previous" points to the right — swap the glyphs, not the logic.
  const PrevIcon = isRtl ? ChevronRight : ChevronLeft;
  const NextIcon = isRtl ? ChevronLeft : ChevronRight;

  return (
    <div className="flex flex-col gap-3 border-t border-border-base px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-4 text-xs text-content-secondary">
        <span>{t('common.showing', { from, to, total })}</span>

        {onPageSizeChange && (
          <label className="flex items-center gap-1.5">
            <span className="hidden sm:inline">{t('common.rowsPerPage')}</span>
            <select
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="h-7 rounded border border-border-base bg-surface px-1.5 text-xs text-content"
            >
              {[10, 25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          icon={<PrevIcon />}
        >
          <span className="hidden sm:inline">{t('common.previous')}</span>
        </Button>

        <span className="px-1 text-xs tabular-nums text-content-secondary">
          {t('common.pageOf', { page, total: pageCount })}
        </span>

        <Button
          size="sm"
          variant="secondary"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          iconEnd={<NextIcon />}
        >
          <span className="hidden sm:inline">{t('common.next')}</span>
        </Button>
      </div>
    </div>
  );
}
