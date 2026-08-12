'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { Alert } from '@/ui/primitives';
import { cn } from '@/ui/utils';
import { CounterView } from './counter-view';
import { WithdrawView } from './withdraw-view';

/**
 * The USDT window — both directions behind one door.
 *
 * The two used to be separate screens with separate entries, and a teller had
 * to know which of them the customer in front of him belonged to before he
 * could start. He does not think that way: a man walks in with coins or wants
 * coins, and that is one counter with two directions.
 *
 * ## Why they are not one form
 *
 * They are joined, not merged. Receiving **waits on the world**: an address is
 * shown, the customer sends, the chain is watched, and only then is cash paid —
 * a request with a life of its own that can be open for ten minutes. Sending
 * **acts on it**: an amount, a way of paying, an address, recorded at once.
 *
 * Forcing those into one layout would be a false symmetry that flatters the
 * screen and lies about the work. So what is shared is what should be — one
 * entry, one heading, one switch, one vocabulary — and each direction keeps the
 * shape its own flow actually has.
 *
 * ## What the switch shows
 *
 * Only what the person may do. A teller allowed to receive and not to send sees
 * no switch at all, because a control with one option is a control that teaches
 * people to ignore controls.
 */

export type Direction = 'in' | 'out';

interface Side {
  /** Whether the office has this direction switched on at all. */
  enabled: boolean;
  /** Whether this person may work it. */
  allowed: boolean;
}

export function UsdtView({
  receive,
  send,
  initial,
  permissions,
  counter,
  withdraw,
}: {
  receive: Side;
  send: Side;
  initial: Direction;
  permissions: string[];
  /** Everything the receiving side needs, or null when it is not on offer. */
  counter: Parameters<typeof CounterView>[0] | null;
  /** Everything the sending side needs, or null when it is not on offer. */
  withdraw: Parameters<typeof WithdrawView>[0] | null;
}) {
  const { t } = useLocale();
  const [direction, setDirection] = useState<Direction>(initial);

  const both = receive.allowed && send.allowed;

  /*
   * Kept in the address so a refresh does not throw the teller back to the
   * other direction mid-customer, and so a manager can send a link that opens
   * the side he means.
   */
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('d') === direction) return;
    url.searchParams.set('d', direction);
    window.history.replaceState(null, '', url.toString());
  }, [direction]);

  const pick = useCallback(
    (next: Direction) => {
      if (next === 'in' && !receive.allowed) return;
      if (next === 'out' && !send.allowed) return;
      setDirection(next);
    },
    [receive.allowed, send.allowed],
  );

  const side = direction === 'in' ? receive : send;

  return (
    <div className="space-y-4">
      {both && (
        <div
          role="tablist"
          aria-label={t('usdtWindow.title')}
          className="bg-surface-sunken flex gap-1 rounded-xl p-1"
        >
          <Tab
            active={direction === 'in'}
            onClick={() => pick('in')}
            icon={<ArrowDownToLine className="size-4" />}
            label={t('usdtWindow.receive')}
          />
          <Tab
            active={direction === 'out'}
            onClick={() => pick('out')}
            icon={<ArrowUpFromLine className="size-4" />}
            label={t('usdtWindow.send')}
          />
        </div>
      )}

      {/*
        A direction the office has switched off, or one with nothing to work
        with, is said here rather than inside the tool — the answer is the same
        whichever direction is chosen, and it is not the tool's business.
      */}
      {!side.enabled ? (
        <Alert tone="neutral" title={t('usdtWindow.offTitle')}>
          {direction === 'in' ? t('counter.disabledBody') : t('withdraw.disabledBody')}
        </Alert>
      ) : direction === 'in' ? (
        counter === null ? (
          <Alert tone="warning" title={t('counter.noAddressesTitle')}>
            {t('counter.noAddressesBody')}
          </Alert>
        ) : (
          <CounterView {...counter} permissions={permissions} />
        )
      ) : withdraw === null ? (
        <Alert tone="warning" title={t('withdraw.noWalletsTitle')}>
          {t('withdraw.noWalletsBody')}
        </Alert>
      ) : (
        <WithdrawView {...withdraw} permissions={permissions} />
      )}
    </div>
  );
}

/** The two words, and an arrow that agrees with each. Nothing else. */
function Tab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5',
        'text-sm font-semibold transition-colors',
        active
          ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
          : 'text-content-tertiary hover:text-content',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
