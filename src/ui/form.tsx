'use client';

import {
  forwardRef,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { normalizeDigits } from '@/core/money/money';
import { cn } from './utils';

/**
 * Form controls.
 *
 * Labels, hints and errors are wired through `aria-describedby` and
 * `aria-invalid` by the `Field` wrapper, so accessibility is a property of the
 * system rather than something each form has to remember.
 */

const CONTROL_BASE = cn(
  'w-full rounded-[var(--radius-control)] border bg-surface text-content',
  'border-border-base placeholder:text-content-tertiary',
  'transition-colors duration-100',
  'focus:outline-none focus:border-primary focus:ring-2 focus:ring-[var(--primary)]/20',
  'disabled:opacity-60 disabled:cursor-not-allowed disabled:bg-surface-sunken',
  'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-[var(--danger)]/20',
);

const CONTROL_SIZE = 'h-[var(--control-height)] px-3 text-sm';

// ---------------------------------------------------------------------------
// Field wrapper
// ---------------------------------------------------------------------------

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optionalLabel?: string;
  className?: string;
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean;
  }) => ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required,
  optionalLabel,
  className,
  children,
}: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={id} className="flex items-center gap-1 text-xs font-medium text-content">
          {label}
          {required && (
            <span className="text-danger-text" aria-hidden>
              *
            </span>
          )}
          {!required && optionalLabel && (
            <span className="font-normal text-content-tertiary">({optionalLabel})</span>
          )}
        </label>
      )}

      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) })}

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className="text-xs text-content-secondary">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text input
// ---------------------------------------------------------------------------

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, iconStart, iconEnd, ...props },
  ref,
) {
  if (!iconStart && !iconEnd) {
    return <input ref={ref} className={cn(CONTROL_BASE, CONTROL_SIZE, className)} {...props} />;
  }

  return (
    <div className="relative flex items-center">
      {iconStart && (
        <span className="pointer-events-none absolute inset-inline-start-0 flex items-center ps-3 text-content-tertiary [&>svg]:size-4">
          {iconStart}
        </span>
      )}
      <input
        ref={ref}
        className={cn(CONTROL_BASE, CONTROL_SIZE, iconStart && 'ps-9', iconEnd && 'pe-9', className)}
        {...props}
      />
      {iconEnd && (
        <span className="absolute inset-inline-end-0 flex items-center pe-3 text-content-tertiary [&>svg]:size-4">
          {iconEnd}
        </span>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Money input
// ---------------------------------------------------------------------------

export interface MoneyInputProps extends Omit<InputProps, 'onChange' | 'value' | 'type'> {
  value: string;
  onValueChange: (value: string) => void;
  currency?: string;
  decimals?: number;
}

/**
 * Amount entry.
 *
 * Accepts Arabic-Indic digits and the Arabic decimal separator, since staff type
 * on Arabic keyboards, and normalises them to a plain decimal string the server
 * can parse exactly. The field is locked to LTR so digits, the decimal point and
 * a minus sign always appear in the order the operator typed them.
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onValueChange, currency, decimals = 2, className, ...props },
  ref,
) {
  const handleChange = (raw: string) => {
    let next = normalizeDigits(raw).replace(/٫/g, '.').replace(/[,\s]/g, '');

    // Allow a partially typed number ("12.", "-", "") without fighting the user.
    if (next !== '' && !/^-?\d*\.?\d*$/.test(next)) return;

    const [whole, fraction] = next.split('.');
    if (fraction !== undefined && fraction.length > decimals) {
      next = `${whole}.${fraction.slice(0, decimals)}`;
    }

    onValueChange(next);
  };

  return (
    <div className="relative flex items-center">
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        dir="ltr"
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        className={cn(
          CONTROL_BASE,
          CONTROL_SIZE,
          'text-end font-medium tabular-nums',
          currency && 'pe-14',
          className,
        )}
        {...props}
      />
      {currency && (
        <span className="pointer-events-none absolute end-3 text-xs font-medium text-content-secondary">
          {currency}
        </span>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Password input
// ---------------------------------------------------------------------------

export const PasswordInput = forwardRef<HTMLInputElement, InputProps>(function PasswordInput(
  { className, ...props },
  ref,
) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative flex items-center">
      <input
        ref={ref}
        type={visible ? 'text' : 'password'}
        dir="ltr"
        className={cn(CONTROL_BASE, CONTROL_SIZE, 'pe-10', className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        // The label is decorative here; the input itself carries the real one.
        aria-label={visible ? 'Hide password' : 'Show password'}
        tabIndex={-1}
        className="absolute end-0 flex h-full items-center pe-3 text-content-tertiary hover:text-content"
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, options, placeholder, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        CONTROL_BASE,
        CONTROL_SIZE,
        'cursor-pointer appearance-none bg-no-repeat pe-9',
        // Inline chevron so no icon library is needed inside a native select.
        "bg-[url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%236b7280' stroke-width='1.5'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E\")]",
        'bg-[length:16px] [background-position:right_0.75rem_center] rtl:[background-position:left_0.75rem_center]',
        className,
      )}
      {...props}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
});

// ---------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 3, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(CONTROL_BASE, 'px-3 py-2 text-sm resize-y min-h-[4.5rem]', className)}
        {...props}
      />
    );
  },
);

// ---------------------------------------------------------------------------
// Checkbox & switch
// ---------------------------------------------------------------------------

export function Checkbox({
  label,
  description,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; description?: ReactNode }) {
  const id = useId();

  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input
        id={id}
        type="checkbox"
        className={cn(
          'mt-0.5 size-4 shrink-0 cursor-pointer rounded border-border-strong',
          'text-primary accent-[var(--primary)]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
          'disabled:opacity-60 disabled:cursor-not-allowed',
        )}
        {...props}
      />
      {(label || description) && (
        <label htmlFor={id} className="cursor-pointer select-none">
          {label && <span className="block text-sm text-content">{label}</span>}
          {description && (
            <span className="block text-xs text-content-secondary">{description}</span>
          )}
        </label>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();

  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      {(label || description) && (
        <label htmlFor={id} className="cursor-pointer select-none">
          {label && <span className="block text-sm text-content">{label}</span>}
          {description && (
            <span className="mt-0.5 block text-xs text-content-secondary">{description}</span>
          )}
        </label>
      )}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          checked ? 'bg-primary' : 'bg-border-strong',
        )}
      >
        <span
          className={cn(
            'absolute size-3.5 rounded-full bg-white shadow-sm transition-[inset-inline-start]',
            // Logical offsets so the knob travels the correct way in RTL.
            checked ? 'inset-inline-start-[1.125rem]' : 'inset-inline-start-[0.1875rem]',
          )}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function FormGrid({
  columns = 2,
  className,
  children,
}: {
  columns?: 1 | 2 | 3;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid gap-4',
        columns === 1 && 'grid-cols-1',
        columns === 2 && 'grid-cols-1 sm:grid-cols-2',
        columns === 3 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function FormSection({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-content">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-content-secondary">{description}</p>}
      </div>
      {children}
    </section>
  );
}
