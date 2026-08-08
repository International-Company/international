'use client';

import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn, type Tone } from './utils';

/**
 * Core presentational primitives.
 *
 * Every visual decision here is driven by the semantic tokens in globals.css,
 * so the whole system re-themes without a component ever knowing which theme is
 * active. Nothing decorative: this is software people stare at for eight hours.
 */

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-white hover:bg-primary-hover active:bg-primary-active border border-transparent shadow-sm',
  secondary:
    'bg-surface text-content border border-border-base hover:bg-surface-hover active:bg-surface-active shadow-sm',
  ghost: 'bg-transparent text-content-secondary hover:bg-surface-hover hover:text-content border border-transparent',
  danger: 'bg-danger text-white hover:bg-danger-hover border border-transparent shadow-sm',
  link: 'bg-transparent text-primary-text hover:underline border-transparent p-0 h-auto',
};

/*
 * Heights are mobile-first: a finger needs roughly 44px of target, a mouse
 * needs none of it. `md` and `icon` already track `--control-height`, which the
 * stylesheet raises below 640px; `sm` and `lg` were fixed pixel heights that
 * ignored it, so a "small" button stayed 32px tall on a phone and had to be
 * aimed at.
 */
const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-10 px-3 text-xs gap-1.5 sm:h-8',
  md: 'h-[var(--control-height)] px-3.5 text-sm gap-2',
  lg: 'h-12 px-5 text-sm gap-2 sm:h-11',
  icon: 'h-[var(--control-height)] w-[var(--control-height)] p-0',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconEnd?: ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    iconEnd,
    fullWidth,
    disabled,
    children,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      // A loading button stays focusable but rejects input, so the operator
      // does not lose their place in the form while a request is in flight.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-[var(--radius-control)] font-medium',
        'transition-colors duration-100 select-none whitespace-nowrap',
        'disabled:opacity-50 disabled:pointer-events-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin shrink-0" aria-hidden />
      ) : (
        icon && <span className="shrink-0 [&>svg]:size-4">{icon}</span>
      )}
      {children}
      {iconEnd && !loading && <span className="shrink-0 [&>svg]:size-4">{iconEnd}</span>}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'bg-surface border border-border-base rounded-[var(--radius-card)] shadow-[var(--shadow-sm)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 px-4 py-3 border-b border-border-base',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-content truncate">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs text-content-secondary">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'px-4 py-3 border-t border-border-base bg-surface-sunken rounded-b-[var(--radius-card)]',
        'flex items-center justify-end gap-2',
        className,
      )}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

const TONE_STYLES: Record<Tone, string> = {
  neutral: 'bg-neutral-subtle text-neutral-text border-neutral-border',
  primary: 'bg-primary-subtle text-primary-text border-primary-border',
  success: 'bg-success-subtle text-success-text border-success-border',
  warning: 'bg-warning-subtle text-warning-text border-warning-border',
  danger: 'bg-danger-subtle text-danger-text border-danger-border',
};

export function Badge({
  tone = 'neutral',
  className,
  dot,
  children,
}: {
  tone?: Tone;
  className?: string;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5',
        'text-xs font-medium whitespace-nowrap',
        TONE_STYLES[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current shrink-0" aria-hidden />}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------------

export function Alert({
  tone = 'neutral',
  title,
  children,
  className,
  icon,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-[var(--radius-card)] border p-3', TONE_STYLES[tone], className)}
    >
      {icon && <span className="shrink-0 mt-0.5 [&>svg]:size-4">{icon}</span>}
      <div className="min-w-0 text-sm">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && 'mt-1', 'opacity-90')}>{children}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page scaffolding
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1.5">{breadcrumb}</div>}
        <h1 className="text-xl font-semibold tracking-tight text-content truncate">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-content-secondary">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon && (
        <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-surface-sunken text-content-tertiary [&>svg]:size-5">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-content">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-content-secondary">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-content-tertiary', className)} aria-hidden />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded', className)} aria-hidden />;
}

export function LoadingRows({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="divide-y divide-border-base">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4 px-4 py-3">
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={cn('h-4', columnIndex === 0 ? 'w-32' : 'flex-1')}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Statistic tile
// ---------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  hint,
  delta,
  icon,
  tone = 'neutral',
  href,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  delta?: { value: string; direction: 'up' | 'down' | 'flat' };
  icon?: ReactNode;
  tone?: Tone;
  href?: string;
}) {
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-content-secondary">{label}</p>
        {icon && (
          <span className={cn('shrink-0 [&>svg]:size-4', tone === 'neutral' ? 'text-content-tertiary' : `text-${tone}`)}>
            {icon}
          </span>
        )}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-content numeric">
        {value}
      </p>
      <div className="mt-1 flex items-center gap-2 text-xs">
        {delta && (
          <span
            className={cn(
              'font-medium tabular-nums',
              delta.direction === 'up' && 'text-success-text',
              delta.direction === 'down' && 'text-danger-text',
              delta.direction === 'flat' && 'text-content-tertiary',
            )}
          >
            {delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '—'} {delta.value}
          </span>
        )}
        {hint && <span className="text-content-tertiary truncate">{hint}</span>}
      </div>
    </>
  );

  const className = cn(
    'bg-surface border border-border-base rounded-[var(--radius-card)] p-4 shadow-[var(--shadow-sm)]',
    href && 'transition-colors hover:bg-surface-hover',
  );

  if (href) {
    return (
      <a href={href} className={className}>
        {content}
      </a>
    );
  }

  return <div className={className}>{content}</div>;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Key/value row used across detail panels. */
export function DetailRow({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 py-2', className)}>
      <dt className="text-xs text-content-secondary shrink-0">{label}</dt>
      <dd className="text-sm text-content text-end min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Monospace, LTR-locked display for hashes, references and addresses. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-xs ltr-content', className)}>{children}</span>
  );
}

export function Separator({ className }: { className?: string }) {
  return <div role="separator" className={cn('h-px w-full bg-border-base', className)} />;
}
