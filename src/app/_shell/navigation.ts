import type { TranslationKey } from '@/i18n/types';

/**
 * Navigation model.
 *
 * The teller gets one entry per job — taking USDT, exchanging cash, sending and
 * receiving remittances — and nothing else. Everything around those jobs — the
 * receipt, the last few transactions, the customer — lives inside the tool that
 * needs it, rather than as further entries they would have to learn to navigate
 * between with someone waiting.
 *
 * The manager's side is grouped by tool rather than by accounting concept: the
 * question is "what does the USDT window need from me", not "where is the chart
 * of accounts".
 *
 * Declared once and filtered by permission at render time. Labels are
 * translation keys — no navigation string is ever hard-coded.
 */

export interface NavItem {
  href: string;
  labelKey: TranslationKey;
  icon: IconName;
  /** Any one of these grants visibility. */
  permissions?: string[];
  /** Match child routes for the active state. */
  matchPrefix?: boolean;
  shortcut?: string;
}

export interface NavSection {
  id: string;
  labelKey: TranslationKey;
  items: NavItem[];
}

export type IconName =
  | 'machine'
  | 'counter'
  | 'transfer'
  | 'handover'
  | 'rates'
  | 'drawers'
  | 'day'
  | 'wallet'
  | 'ledger'
  | 'transactions'
  | 'audit'
  | 'staff'
  | 'settings';

export const NAVIGATION: NavSection[] = [
  // --- The counter ---------------------------------------------------------
  {
    id: 'counter',
    labelKey: 'nav.counter',
    items: [
      {
        href: '/treasury/handovers',
        labelKey: 'nav.handovers',
        icon: 'handover',
        permissions: ['treasury.handover.manage', 'treasury.handover.receive'],
        shortcut: 'g s',
      },
      {
        href: '/counter/usdt',
        labelKey: 'nav.usdtCounter',
        icon: 'counter',
        permissions: ['usdt.counter.use'],
        shortcut: 'g u',
      },
      {
        href: '/counter/withdraw',
        labelKey: 'nav.withdraw',
        icon: 'wallet',
        permissions: ['usdt.withdrawal.use'],
        shortcut: 'g w',
      },
      {
        href: '/counter/machine',
        labelKey: 'nav.machine',
        icon: 'machine',
        permissions: ['exchange.machine.use'],
        shortcut: 'g m',
      },
      {
        href: '/counter/remittance',
        labelKey: 'nav.remittance',
        icon: 'transfer',
        permissions: ['exchange.remittance.use'],
        shortcut: 'g h',
      },
    ],
  },

  // --- What the USDT window needs from the manager -------------------------
  {
    id: 'manageUsdt',
    labelKey: 'nav.manageUsdt',
    items: [
      {
        href: '/manage/usdt',
        labelKey: 'nav.counterAddresses',
        icon: 'wallet',
        permissions: ['usdt.wallet.view'],
        matchPrefix: true,
      },
    ],
  },

  // --- What the machine needs from the manager -----------------------------
  {
    id: 'manageMachine',
    labelKey: 'nav.manageMachine',
    items: [
      {
        href: '/manage/machine',
        labelKey: 'nav.machineControl',
        icon: 'machine',
        permissions: ['exchange.rate.view'],
      },
      {
        href: '/manage/exceptions',
        labelKey: 'nav.exceptions',
        icon: 'rates',
        permissions: ['exchange.priceException.approve'],
      },
      {
        href: '/manage/rates',
        labelKey: 'nav.rates',
        icon: 'rates',
        permissions: ['exchange.rate.view'],
        shortcut: 'g r',
      },
      {
        href: '/manage/drawers',
        labelKey: 'nav.drawers',
        icon: 'drawers',
        permissions: ['exchange.drawer.view'],
      },
      {
        href: '/manage/broker',
        labelKey: 'nav.broker',
        icon: 'drawers',
        permissions: ['exchange.drawer.view'],
      },
    ],
  },

  // --- Watching the counter ------------------------------------------------
  {
    id: 'oversight',
    labelKey: 'nav.oversight',
    items: [
      {
        href: '/manage/ledger',
        labelKey: 'nav.ledger',
        icon: 'ledger',
        permissions: ['ledger.view'],
        shortcut: 'g l',
      },
      {
        href: '/treasury/differences',
        labelKey: 'nav.differences',
        icon: 'handover',
        permissions: ['ledger.view'],
      },
      {
        href: '/manage/day',
        labelKey: 'nav.day',
        icon: 'day',
        permissions: ['exchange.day.view'],
      },
      {
        href: '/manage/transactions',
        labelKey: 'nav.transactions',
        icon: 'transactions',
        permissions: ['exchange.transaction.viewAll'],
        matchPrefix: true,
        shortcut: 'g t',
      },
      {
        href: '/manage/audit',
        labelKey: 'nav.audit',
        icon: 'audit',
        permissions: ['audit.view'],
      },
      {
        href: '/manage/staff',
        labelKey: 'nav.staff',
        icon: 'staff',
        permissions: ['users.view'],
        matchPrefix: true,
      },
      {
        href: '/manage/permissions',
        labelKey: 'nav.access',
        icon: 'staff',
        permissions: ['users.roles.assign'],
      },
      {
        href: '/manage/settings',
        labelKey: 'nav.settings',
        icon: 'settings',
        permissions: ['settings.view'],
      },
    ],
  },
];

/**
 * Removes items the user cannot access, then drops any section left empty.
 *
 * This is what leaves the teller with their own tools and no empty headings:
 * every manager section disappears whole rather than collapsing into a stub.
 */
export function visibleNavigation(permissions: string[]): NavSection[] {
  const granted = new Set(permissions);

  return NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => !item.permissions || item.permissions.some((p) => granted.has(p)),
    ),
  })).filter((section) => section.items.length > 0);
}

/**
 * Where a person lands after signing in.
 *
 * Derived from the navigation rather than a constant, because there is no
 * longer a dashboard for everyone to share: a teller belongs at the window and
 * a manager at whatever the first thing they are allowed to see is. Taking the
 * first visible entry means this can never point somewhere the user would only
 * be bounced out of.
 */
export function landingFor(permissions: string[]): string {
  const first = visibleNavigation(permissions)[0]?.items[0];
  // Everyone can reach their own profile, so it is a landing place that exists
  // even for an account whose role has been emptied.
  return first?.href ?? '/profile';
}

export function isActiveRoute(pathname: string, item: NavItem): boolean {
  if (item.matchPrefix) {
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }
  return pathname === item.href;
}
