'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn, type Tone } from './utils';
import { Button } from './primitives';

/**
 * Overlays: dialogs, menus and toasts.
 *
 * Built on native focus management rather than a component library — the whole
 * surface is small enough to own, and owning it means the RTL and print
 * behaviour is exactly what this system needs rather than what a generic
 * library assumes.
 */

// ---------------------------------------------------------------------------
// Focus trap
// ---------------------------------------------------------------------------

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Where a dialog should put the caret when it opens.
 *
 * Not simply the first focusable element: the close button comes first in the
 * markup, and opening a form with focus on "dismiss" is a step backwards for
 * whoever came to fill it in.
 */
const FIRST_FIELD = [
  'input:not([disabled]):not([type="hidden"]):not([readonly])',
  'select:not([disabled])',
  'textarea:not([disabled]):not([readonly])',
].join(',');

/**
 * Confines Tab to the container and restores focus to the trigger on close.
 * Losing your place in a form because a dialog stole focus is a small thing
 * that costs a busy teller real time.
 */
function useFocusTrap(active: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  /*
   * `onClose` is an inline arrow at nearly every call site, so it is a brand
   * new function on every render of the screen behind the dialog. Listing it as
   * a dependency meant this entire effect tore itself down and set itself up
   * again on every keystroke — and setting up moves focus to the top of the
   * dialog. Type one character into a form, and the caret jumped to the close
   * button.
   *
   * Held in a ref instead, so the trap is governed by the only thing that
   * should govern it: whether the dialog is open.
   */
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!active) return;

    previousFocus.current = document.activeElement as HTMLElement | null;

    const container = ref.current;
    const field = container?.querySelector<HTMLElement>(FIRST_FIELD);
    const focusables = container?.querySelectorAll<HTMLElement>(FOCUSABLE);
    (field ?? focusables?.[0] ?? container)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
        return;
      }

      if (event.key !== 'Tab' || !container) return;

      const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null,
      );
      if (items.length === 0) return;

      const first = items[0]!;
      const last = items[items.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    // Prevent the page behind from scrolling while the overlay is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previousFocus.current?.focus?.();
    };
  }, [active]);

  return ref;
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

const DIALOG_SIZES: Record<DialogSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  children,
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  size?: DialogSize;
  footer?: ReactNode;
  children: ReactNode;
  closeOnBackdrop?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  const trapRef = useFocusTrap(open, onClose);

  useEffect(() => setMounted(true), []);
  if (!mounted || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-[var(--overlay)] animate-in"
        onClick={closeOnBackdrop ? onClose : undefined}
        aria-hidden
      />

      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full animate-in',
          'bg-surface border border-border-base rounded-[var(--radius-card)] shadow-[var(--shadow-lg)]',
          DIALOG_SIZES[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-base px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-content">{title}</h2>
            {description && (
              <p className="mt-0.5 text-sm text-content-secondary">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-me-1 rounded p-1 text-content-tertiary transition-colors hover:bg-surface-hover hover:text-content"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="max-h-[calc(100vh-16rem)] overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border-base bg-surface-sunken px-5 py-3 rounded-b-[var(--radius-card)]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** A dialog that asks before doing something irreversible. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = 'primary',
  loading,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone?: Tone;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message && <p className="text-sm text-content-secondary">{message}</p>}
      {children && <div className={cn(message && 'mt-4')}>{children}</div>}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Dropdown menu
// ---------------------------------------------------------------------------

export function DropdownMenu({
  trigger,
  children,
  align = 'end',
  className,
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  return (
    <div ref={containerRef} className="relative">
      {trigger({ onClick: () => setOpen((current) => !current), 'aria-expanded': open })}

      {open && (
        <div
          role="menu"
          className={cn(
            'absolute z-40 mt-1 min-w-[12rem] animate-in',
            'bg-surface border border-border-base rounded-[var(--radius-control)] shadow-[var(--shadow-lg)]',
            'py-1',
            align === 'end' ? 'inset-inline-end-0' : 'inset-inline-start-0',
            className,
          )}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  icon,
  tone = 'neutral',
  disabled,
  shortcut,
}: {
  children: ReactNode;
  onClick?: () => void;
  icon?: ReactNode;
  tone?: 'neutral' | 'danger';
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 px-3 py-1.5 text-start text-sm transition-colors',
        'disabled:opacity-50 disabled:pointer-events-none',
        tone === 'danger'
          ? 'text-danger-text hover:bg-danger-subtle'
          : 'text-content hover:bg-surface-hover',
      )}
    >
      {icon && <span className="shrink-0 text-content-tertiary [&>svg]:size-4">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <kbd className="text-xs text-content-tertiary ltr-content">{shortcut}</kbd>}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border-base" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-content-tertiary">
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

export interface Toast {
  id: string;
  tone: Tone;
  title: string;
  description?: string;
  duration?: number;
}

interface ToastContextValue {
  toast: (input: Omit<Toast, 'id'>) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_TONES: Record<Tone, string> = {
  neutral: 'border-border-base',
  primary: 'border-primary-border',
  success: 'border-success-border',
  warning: 'border-warning-border',
  danger: 'border-danger-border',
};

const TOAST_ACCENT: Record<Tone, string> = {
  neutral: 'bg-neutral-text',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (input: Omit<Toast, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Errors persist longer — they usually require the operator to act.
      const duration = input.duration ?? (input.tone === 'danger' ? 8000 : 4000);

      setToasts((current) => [...current.slice(-4), { ...input, id }]);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      dismiss,
      success: (title, description) => toast({ tone: 'success', title, description }),
      error: (title, description) => toast({ tone: 'danger', title, description }),
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 z-[60] flex w-full max-w-sm flex-col gap-2 px-4 inset-inline-end-0 sm:px-0 sm:me-4"
      role="region"
      aria-live="polite"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          className={cn(
            'pointer-events-auto flex items-start gap-3 overflow-hidden animate-in',
            'bg-surface border rounded-[var(--radius-card)] shadow-[var(--shadow-lg)]',
            TOAST_TONES[item.tone],
          )}
        >
          <div className={cn('w-1 self-stretch shrink-0', TOAST_ACCENT[item.tone])} aria-hidden />
          <div className="min-w-0 flex-1 py-3">
            <p className="text-sm font-medium text-content">{item.title}</p>
            {item.description && (
              <p className="mt-0.5 text-xs text-content-secondary break-words">{item.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(item.id)}
            className="p-3 text-content-tertiary transition-colors hover:text-content"
            aria-label="Dismiss"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const [visible, setVisible] = useState(false);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          className={cn(
            'pointer-events-none absolute bottom-full start-1/2 z-50 mb-1.5 -translate-x-1/2 rtl:translate-x-1/2',
            'whitespace-nowrap rounded bg-content px-2 py-1 text-xs text-content-inverse shadow-[var(--shadow-md)]',
          )}
        >
          {label}
        </span>
      )}
    </span>
  );
}
