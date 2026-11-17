'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/ui/utils';

/**
 * A choice among a few, as a pill that opens a list.
 *
 * The browser's own select draws its list in the operating system's look — a
 * grey box with a blue bar in Arabic on Windows — beside a screen that is
 * otherwise the office's. This is the office's: the pill says what is chosen and
 * turns blue when something is, and the list beside it marks the choice and says
 * how many of each there are.
 *
 * Placed in the page rather than inside the card it sits in, so the card's edge
 * never clips it.
 */

export interface PillOption {
  value: string;
  label: string;
  /** Beside the label: how many, usually. */
  hint?: ReactNode;
}

export function PillSelect({
  value,
  onChange,
  options,
  placeholder,
  icon,
  label,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  options: PillOption[];
  /** What the pill says when nothing is chosen, and the first row that chooses nothing. */
  placeholder: string;
  icon?: ReactNode;
  /** For screen readers: what is being chosen. */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const chosen = options.find((option) => option.value === value) ?? null;

  const place = () => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const width = Math.max(box.width, 200);
    const rtl = document.documentElement.dir === 'rtl';
    const preferred = rtl ? box.right - width : box.left;
    const left = Math.max(8, Math.min(preferred, window.innerWidth - width - 8));
    const height = panel.current?.offsetHeight ?? 240;
    const below = box.bottom + 6;
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

  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  const row = (option: { value: string | null; label: string; hint?: ReactNode }) => {
    const selected = option.value === value;
    return (
      <button
        key={option.value ?? '__all'}
        type="button"
        role="option"
        aria-selected={selected}
        onClick={() => pick(option.value)}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm transition-colors',
          selected ? 'bg-primary-subtle font-semibold text-primary-text' : 'text-content hover:bg-surface-sunken',
        )}
      >
        <Check className={cn('size-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
        <span className="min-w-0 flex-1 truncate">{option.label}</span>
        {option.hint !== undefined && (
          <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 text-[11px] tabular-nums text-content-tertiary">
            {option.hint}
          </span>
        )}
      </button>
    );
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className={cn(
          'inline-flex h-8 max-w-[13rem] items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors',
          chosen
            ? 'bg-primary text-white shadow-[var(--shadow-sm)]'
            : 'bg-surface-sunken text-content-secondary hover:text-content',
        )}
      >
        {icon}
        <span className="truncate">{chosen?.label ?? placeholder}</span>
        <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open &&
        createPortal(
          <div
            ref={panel}
            role="listbox"
            aria-label={label}
            style={
              position
                ? { top: position.top, left: position.left, width: position.width }
                : { visibility: 'hidden' }
            }
            className="fixed z-[60] max-h-72 overflow-y-auto rounded-2xl bg-surface p-1.5 shadow-[0_20px_50px_-12px_rgb(0_0_0/0.35)] ring-1 ring-border-subtle"
          >
            {row({ value: null, label: placeholder })}
            <div className="my-1 border-t border-border-subtle" />
            {options.map((option) => row(option))}
          </div>,
          document.body,
        )}
    </>
  );
}
