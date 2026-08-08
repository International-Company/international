'use client';

import type { ReactNode } from 'react';
import { formatRate } from '@/i18n/format';
import { DateText } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * The rate board.
 *
 * Every exchange office has one on the wall: a row per currency against the
 * local one, and two columns — what the office buys at and what it sells at.
 * That board is not decoration, it is the product, and the six directional
 * pairs this machine trades are exactly those three rows read twice. Pressing
 * the buy column of USD/ILS is the customer handing over dollars; pressing the
 * sell column of the same row is them handing over shekels. One object, read
 * two ways, instead of six buttons that have to be reasoned about.
 *
 * The board is the screen at the counter and in the manager's office alike —
 * the same three rows, the same two columns, differing only in what sits inside
 * a cell: a price to press, or a switch to throw.
 *
 * It is dark in both themes. Not a preference: a board is a board, and this one
 * is meant to be legible across a counter at a glance, the way the lit board
 * behind a teller's head is.
 */

export interface BoardRate {
  baseCode: string;
  quoteCode: string;
  buyRate: string;
  sellRate: string;
  effectiveFrom: string;
}

export interface BoardCell {
  /** The direction taking this cell trades, e.g. `USD/ILS`. */
  pair: string;
  /** What the customer hands over. */
  from: string;
  /** What the customer walks away with. */
  to: string;
  /**
   * The published figure, exactly as a board states it: quote per one base.
   * Note this is not always the conversion factor — selling the base converts
   * by its reciprocal — but it is the number the customer reads and checks, so
   * it is the number shown.
   */
  rate: string | null;
  /** Whether the manager offers this direction at the counter. */
  offered: boolean;
}

export interface BoardRow {
  base: string;
  quote: string;
  /** The office buys the base: the customer hands the base over. */
  buy: BoardCell;
  /** The office sells the base: the customer hands the quote over. */
  sell: BoardCell;
  publishedAt: string | null;
}

/**
 * Folds published rates and the enabled-pair list into board rows.
 *
 * Orientation follows whatever was actually published, so a rate entered as
 * ILS/USD is never redrawn as USD/ILS behind the manager's back. Where nothing
 * is published yet, the later currency in the branch's own sort order becomes
 * the base — which puts the local currency in the quote column, where a board
 * reader expects to find it.
 */
export function buildBoard(codes: string[], rates: BoardRate[], offered: string[]): BoardRow[] {
  const rows: BoardRow[] = [];
  const isOffered = new Set(offered);

  for (let first = 0; first < codes.length; first++) {
    for (let second = first + 1; second < codes.length; second++) {
      const earlier = codes[first]!;
      const later = codes[second]!;

      const published =
        rates.find((rate) => rate.baseCode === later && rate.quoteCode === earlier) ??
        rates.find((rate) => rate.baseCode === earlier && rate.quoteCode === later) ??
        null;

      const base = published?.baseCode ?? later;
      const quote = published?.quoteCode ?? earlier;

      rows.push({
        base,
        quote,
        buy: {
          pair: `${base}/${quote}`,
          from: base,
          to: quote,
          rate: published?.buyRate ?? null,
          offered: isOffered.has(`${base}/${quote}`),
        },
        sell: {
          pair: `${quote}/${base}`,
          from: quote,
          to: base,
          rate: published?.sellRate ?? null,
          offered: isOffered.has(`${quote}/${base}`),
        },
        publishedAt: published?.effectiveFrom ?? null,
      });
    }
  }

  return rows;
}

/**
 * The board's chrome: the header, the two column headings and the row labels.
 *
 * What goes inside a cell is the caller's, because that is the only thing the
 * two roles disagree about.
 */
export function Board({
  rows,
  title,
  headings,
  names,
  updatedAt,
  liveLabel,
  cell,
  footer,
}: {
  rows: BoardRow[];
  title: string;
  /** Currency column, buy column, sell column. */
  headings: [string, string, string];
  /** Currency code to its name in the reader's language. */
  names: Map<string, string>;
  updatedAt: string | null;
  liveLabel: string;
  cell: (cell: BoardCell, kind: 'buy' | 'sell') => ReactNode;
  footer?: ReactNode;
}) {
  return (
    // `dark` re-declares the theme variables for this subtree, so every token
    // underneath resolves to its dark value without a single hard-coded colour.
    <div className="dark overflow-hidden rounded-[var(--radius-card)] border border-border-base bg-canvas shadow-[var(--shadow-md)]">
      <div className="flex items-center justify-between gap-3 border-b border-border-base px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-content-secondary">
          {title}
        </span>
        <span className="flex items-center gap-2 text-[11px] text-content-tertiary">
          <span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden />
          {liveLabel}
          {updatedAt && (
            <>
              <span aria-hidden>·</span>
              <DateText value={updatedAt} relative />
            </>
          )}
        </span>
      </div>

      <div
        role="table"
        className="[--board-grid:minmax(6.5rem,1fr)_minmax(0,1.15fr)_minmax(0,1.15fr)]"
      >
        <div
          role="row"
          className="grid grid-cols-[var(--board-grid)] gap-px bg-border-subtle text-[11px] font-medium uppercase tracking-wider text-content-tertiary"
        >
          <span role="columnheader" className="bg-canvas px-4 py-2">
            {headings[0]}
          </span>
          <span role="columnheader" className="bg-canvas px-3 py-2 text-center">
            {headings[1]}
          </span>
          <span role="columnheader" className="bg-canvas px-3 py-2 text-center">
            {headings[2]}
          </span>
        </div>

        <div className="grid gap-px bg-border-subtle pt-px">
          {rows.map((row) => (
            <div
              key={`${row.base}/${row.quote}`}
              role="row"
              className="grid grid-cols-[var(--board-grid)] gap-px bg-border-subtle"
            >
              <span role="rowheader" className="flex flex-col justify-center bg-canvas px-4 py-3">
                <span className="ltr-content font-mono text-sm font-semibold tracking-tight text-content">
                  {row.base}
                  <span className="text-content-tertiary">/</span>
                  {row.quote}
                </span>
                <span className="truncate text-[11px] text-content-tertiary">
                  {names.get(row.base) ?? row.base}
                </span>
              </span>

              <span role="cell" className="bg-canvas">
                {cell(row.buy, 'buy')}
              </span>
              <span role="cell" className="bg-canvas">
                {cell(row.sell, 'sell')}
              </span>
            </div>
          ))}
        </div>
      </div>

      {footer}
    </div>
  );
}

/**
 * The price itself, sized to be read across a counter.
 *
 * A missing rate is an em dash rather than a zero. Zero is a price; nothing
 * published is not, and the difference matters to whoever is about to quote it.
 */
export function BoardPrice({ rate, muted }: { rate: string | null; muted?: boolean }) {
  if (rate === null) {
    return <span className="font-mono text-2xl text-content-tertiary">—</span>;
  }

  return (
    <span
      className={cn(
        'ltr-content font-mono text-2xl font-semibold tabular-nums tracking-tight sm:text-[1.75rem]',
        muted ? 'text-content-tertiary' : 'text-content',
      )}
    >
      {formatRate(rate)}
    </span>
  );
}
