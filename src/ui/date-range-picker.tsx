'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { cn } from '@/ui/utils';

/**
 * A range of days, chosen on a calendar.
 *
 * The browser's own date field writes its placeholder in the visitor's language
 * and its calendar in the operating system's, which in Arabic reads as a jumble
 * of "يوم/شهر/سنة" boxes. This is the office's own: a button that says the range
 * in words, opening on a month of days where the first press starts the range and
 * the second ends it, with the usual periods one press away beside it.
 *
 * Days are keys, "2026-11-17", in the browser's clock: the day the teller lived.
 */

export interface DayRange {
  from: string | null;
  to: string | null;
}

export const ANY_DAY: DayRange = { from: null, to: null };

/** A date's key: "2026-11-17". */
export function keyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateOf(key: string): Date {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
}

function shifted(days: number, from = new Date()): Date {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return date;
}

/** Whether a day's key falls in the range; an open end lets everything through on that side. */
export function inRange(key: string, range: DayRange): boolean {
  return (!range.from || key >= range.from) && (!range.to || key <= range.to);
}

type Preset = 'all' | 'today' | 'yesterday' | 'week' | 'month30' | 'thisMonth' | 'lastMonth';

function presetRange(preset: Preset): DayRange {
  const today = new Date();
  switch (preset) {
    case 'today':
      return { from: keyOf(today), to: keyOf(today) };
    case 'yesterday':
      return { from: keyOf(shifted(-1)), to: keyOf(shifted(-1)) };
    case 'week':
      return { from: keyOf(shifted(-6)), to: keyOf(today) };
    case 'month30':
      return { from: keyOf(shifted(-29)), to: keyOf(today) };
    case 'thisMonth':
      return { from: keyOf(new Date(today.getFullYear(), today.getMonth(), 1)), to: keyOf(today) };
    case 'lastMonth':
      return {
        from: keyOf(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
        to: keyOf(new Date(today.getFullYear(), today.getMonth(), 0)),
      };
    default:
      return ANY_DAY;
  }
}

const PRESETS: Preset[] = ['all', 'today', 'yesterday', 'week', 'month30', 'thisMonth', 'lastMonth'];

export function DateRangePicker({
  value,
  onChange,
  className,
}: {
  value: DayRange;
  onChange: (next: DayRange) => void;
  className?: string;
}) {
  const { t, locale } = useLocale();
  // Western digits in either language: the rest of the screen writes numbers that way.
  const tag = locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB';
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DayRange>(value);
  const [hover, setHover] = useState<string | null>(null);
  const [month, setMonth] = useState(() => {
    const start = value.to ? dateOf(value.to) : new Date();
    return new Date(start.getFullYear(), start.getMonth(), 1);
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  const today = keyOf(new Date());
  const activePreset = PRESETS.find((preset) => {
    const range = presetRange(preset);
    return range.from === value.from && range.to === value.to;
  });

  // The words on the button: a period's name, one day, or the two ends.
  const short = (key: string) =>
    dateOf(key).toLocaleDateString(tag, {
      day: 'numeric',
      month: 'short',
      ...(dateOf(key).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
    });
  const label = activePreset
    ? t(`dateRange.${activePreset}`)
    : value.from && value.to && value.from === value.to
      ? short(value.from)
      : `${value.from ? short(value.from) : '…'} – ${value.to ? short(value.to) : '…'}`;

  /*
   * Placed against the button, in the page rather than inside the card it sits
   * in: the card clips what spills out of it, and a calendar half hidden under
   * its edge is no calendar. Kept on the screen whichever side it opens to.
   */
  const place = () => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const width = Math.min(window.innerWidth - 16, 560);
    const rtl = document.documentElement.dir === 'rtl';
    const preferred = rtl ? box.right - width : box.left;
    const left = Math.max(8, Math.min(preferred, window.innerWidth - width - 8));
    const below = box.bottom + 6;
    const height = panel.current?.offsetHeight ?? 380;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, box.top - height - 6) : below;
    setPosition({ top, left, width });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const again = () => place();
    window.addEventListener('resize', again);
    window.addEventListener('scroll', again, true);
    return () => {
      window.removeEventListener('resize', again);
      window.removeEventListener('scroll', again, true);
    };
  }, [open]);

  // Closed by a press outside it, or Escape.
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const openPicker = () => {
    setDraft(value);
    setHover(null);
    const start = value.to ? dateOf(value.to) : new Date();
    setMonth(new Date(start.getFullYear(), start.getMonth(), 1));
    setOpen(true);
  };

  // The first press starts a range, the second ends it — whichever order they come in.
  const press = (key: string) => {
    if (!draft.from || (draft.from && draft.to)) {
      setDraft({ from: key, to: null });
      return;
    }
    setDraft(key < draft.from ? { from: key, to: draft.from } : { from: draft.from, to: key });
  };

  const choosePreset = (preset: Preset) => {
    onChange(presetRange(preset));
    setOpen(false);
  };

  // The month's days in weeks that start on Saturday, as the office's calendar does.
  const weeks = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const lead = (first.getDay() + 1) % 7;
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const cells: (string | null)[] = [
      ...Array.from({ length: lead }, () => null),
      ...Array.from({ length: count }, (_, index) =>
        keyOf(new Date(month.getFullYear(), month.getMonth(), index + 1)),
      ),
    ];
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [month]);

  const weekdays = useMemo(
    () =>
      // Saturday 2024-01-06 onwards: a week starting on Saturday.
      Array.from({ length: 7 }, (_, index) =>
        new Date(2024, 0, 6 + index).toLocaleDateString(tag, { weekday: 'short' }),
      ),
    [tag],
  );

  // The range as it would be: the second end following the pointer before it is pressed.
  const preview: DayRange =
    draft.from && !draft.to && hover
      ? hover < draft.from
        ? { from: hover, to: draft.from }
        : { from: draft.from, to: hover }
      : draft;

  const monthTitle = month.toLocaleDateString(tag, { month: 'long', year: 'numeric' });
  const step = (by: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1));
  const set = Boolean(value.from || value.to);

  return (
    <>
      <div className={cn('inline-flex items-center', className)}>
        <button
          ref={trigger}
          type="button"
          onClick={() => (open ? setOpen(false) : openPicker())}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors',
            set
              ? 'bg-primary text-white shadow-[var(--shadow-sm)]'
              : 'bg-surface-sunken text-content-secondary hover:text-content',
          )}
        >
          <CalendarDays className="size-3.5" />
          <span>{label}</span>
        </button>
        {set && (
          <button
            type="button"
            onClick={() => onChange(ANY_DAY)}
            aria-label={t('dateRange.clear')}
            title={t('dateRange.clear')}
            className="ms-0.5 inline-flex size-7 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {open &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label={t('dateRange.title')}
            style={
              position
                ? { top: position.top, left: position.left, width: position.width }
                : { visibility: 'hidden' }
            }
            className="fixed z-[60] flex flex-col overflow-hidden rounded-2xl bg-surface text-content shadow-[0_20px_50px_-12px_rgb(0_0_0/0.35)] ring-1 ring-border-subtle sm:flex-row"
          >
            {/* --- The usual periods --- */}
            <nav className="flex gap-1 overflow-x-auto border-b border-border-subtle bg-surface-sunken/60 p-2 sm:w-40 sm:flex-col sm:border-b-0 sm:border-e">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => choosePreset(preset)}
                  className={cn(
                    'shrink-0 rounded-lg px-3 py-2 text-start text-xs font-medium transition-colors',
                    activePreset === preset
                      ? 'bg-primary text-white'
                      : 'text-content-secondary hover:bg-surface hover:text-content',
                  )}
                >
                  {t(`dateRange.${preset}`)}
                </button>
              ))}
            </nav>

            {/* --- A month of days --- */}
            <div className="flex-1 p-3">
              <div className="mb-2 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => step(-1)}
                  aria-label={t('dateRange.previous')}
                  className="inline-flex size-8 items-center justify-center rounded-full hover:bg-surface-sunken"
                >
                  <ChevronLeft className="size-4 rtl:-scale-x-100" />
                </button>
                <p className="text-sm font-semibold">{monthTitle}</p>
                <button
                  type="button"
                  onClick={() => step(1)}
                  disabled={keyOf(new Date(month.getFullYear(), month.getMonth() + 1, 1)) > today}
                  aria-label={t('dateRange.next')}
                  className="inline-flex size-8 items-center justify-center rounded-full hover:bg-surface-sunken disabled:opacity-30"
                >
                  <ChevronRight className="size-4 rtl:-scale-x-100" />
                </button>
              </div>

              <div className="grid grid-cols-7 text-center text-[11px] font-medium text-content-tertiary">
                {weekdays.map((day) => (
                  <span key={day} className="py-1">
                    {day}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-7" onMouseLeave={() => setHover(null)}>
                {weeks.map((key, index) => {
                  if (!key) return <span key={`blank-${index}`} />;
                  const future = key > today;
                  const start = key === preview.from;
                  const end = key === preview.to;
                  const between =
                    Boolean(preview.from && preview.to) && key > preview.from! && key < preview.to!;
                  const column = index % 7;
                  return (
                    <div
                      key={key}
                      className={cn(
                        'relative flex h-9 items-center justify-center',
                        (between || ((start || end) && preview.from && preview.to && preview.from !== preview.to)) &&
                          'bg-primary-subtle',
                        // The band rounds off where the range begins and ends, and at a week's edge.
                        start && preview.to && preview.from !== preview.to && 'rounded-s-full',
                        end && preview.from !== preview.to && 'rounded-e-full',
                        between && column === 0 && 'rounded-s-full',
                        between && column === 6 && 'rounded-e-full',
                      )}
                    >
                      <button
                        type="button"
                        disabled={future}
                        onClick={() => press(key)}
                        onMouseEnter={() => setHover(key)}
                        className={cn(
                          'relative size-9 rounded-full text-sm tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-30',
                          start || end
                            ? 'bg-primary font-semibold text-white shadow-[var(--shadow-sm)]'
                            : 'hover:bg-surface-sunken',
                          key === today && !(start || end) && 'font-bold text-primary-text ring-1 ring-primary/40',
                        )}
                      >
                        {dateOf(key).getDate()}
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* --- What is chosen, and doing it --- */}
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
                <p className="text-xs text-content-secondary">
                  {draft.from
                    ? draft.to && draft.to !== draft.from
                      ? `${short(draft.from)} – ${short(draft.to)}`
                      : draft.to
                        ? short(draft.from)
                        : t('dateRange.pickEnd', { day: short(draft.from) })
                    : t('dateRange.pickStart')}
                </p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="h-8 rounded-full px-3 text-xs font-medium text-content-secondary hover:bg-surface-sunken"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={!draft.from}
                    onClick={() => {
                      onChange({ from: draft.from, to: draft.to ?? draft.from });
                      setOpen(false);
                    }}
                    className="h-8 rounded-full bg-primary px-4 text-xs font-semibold text-white shadow-[var(--shadow-sm)] disabled:opacity-40"
                  >
                    {t('dateRange.apply')}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
