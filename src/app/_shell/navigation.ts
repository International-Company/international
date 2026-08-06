import type { TranslationKey } from '@/i18n/types';

/**
 * Navigation model.
 *
 * Declared once and filtered by permission at render time, so a teller never
 * sees an administration link they cannot open. Labels are translation keys —
 * no navigation string is ever hard-coded.
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
  | 'dashboard'
  | 'transactions'
  | 'newTransaction'
  | 'rates'
  | 'cashbox'
  | 'day'
  | 'wallet'
  | 'chain'
  | 'customers'
  | 'reports'
  | 'notifications'
  | 'users'
  | 'roles'
  | 'audit'
  | 'settings'
  | 'backup'
  | 'system';

export const NAVIGATION: NavSection[] = [
  {
    id: 'operations',
    labelKey: 'nav.operations',
    items: [
      {
        href: '/dashboard',
        labelKey: 'nav.dashboard',
        icon: 'dashboard',
        permissions: ['dashboard.view'],
        shortcut: 'g d',
      },
      {
        href: '/exchange/transactions/new',
        labelKey: 'nav.newTransaction',
        icon: 'newTransaction',
        permissions: ['exchange.transaction.create'],
        shortcut: 'n',
      },
      {
        href: '/exchange/transactions',
        labelKey: 'nav.transactions',
        icon: 'transactions',
        permissions: ['exchange.transaction.view'],
        matchPrefix: true,
        shortcut: 'g t',
      },
      {
        href: '/exchange/rates',
        labelKey: 'nav.rates',
        icon: 'rates',
        permissions: ['exchange.rate.view'],
        shortcut: 'g r',
      },
      {
        href: '/exchange/cashboxes',
        labelKey: 'nav.cashboxes',
        icon: 'cashbox',
        permissions: ['exchange.account.view'],
        matchPrefix: true,
      },
      {
        href: '/exchange/business-day',
        labelKey: 'nav.businessDay',
        icon: 'day',
        permissions: ['exchange.day.view'],
      },
    ],
  },
  {
    id: 'usdt',
    labelKey: 'nav.usdt',
    items: [
      {
        href: '/usdt/wallets',
        labelKey: 'nav.wallets',
        icon: 'wallet',
        permissions: ['usdt.wallet.view'],
        matchPrefix: true,
      },
      {
        href: '/usdt/transactions',
        labelKey: 'nav.chainTransactions',
        icon: 'chain',
        permissions: ['usdt.transaction.view'],
        matchPrefix: true,
      },
    ],
  },
  {
    id: 'management',
    labelKey: 'nav.management',
    items: [
      {
        href: '/customers',
        labelKey: 'nav.customers',
        icon: 'customers',
        permissions: ['customers.view'],
        matchPrefix: true,
        shortcut: 'g c',
      },
      {
        href: '/reports',
        labelKey: 'nav.reports',
        icon: 'reports',
        permissions: ['reports.view'],
        matchPrefix: true,
      },
      {
        href: '/notifications',
        labelKey: 'nav.notifications',
        icon: 'notifications',
        permissions: ['notifications.view'],
      },
    ],
  },
  {
    id: 'administration',
    labelKey: 'nav.administration',
    items: [
      {
        href: '/admin/users',
        labelKey: 'nav.users',
        icon: 'users',
        permissions: ['users.view'],
        matchPrefix: true,
      },
      {
        href: '/admin/roles',
        labelKey: 'nav.roles',
        icon: 'roles',
        permissions: ['users.roles.manage'],
        matchPrefix: true,
      },
      {
        href: '/admin/audit',
        labelKey: 'nav.audit',
        icon: 'audit',
        permissions: ['audit.view'],
      },
      {
        href: '/admin/settings',
        labelKey: 'nav.settings',
        icon: 'settings',
        permissions: ['settings.view'],
      },
      {
        href: '/admin/backup',
        labelKey: 'nav.backup',
        icon: 'backup',
        permissions: ['system.backup.view'],
      },
      {
        href: '/admin/system',
        labelKey: 'nav.system',
        icon: 'system',
        permissions: ['system.monitor'],
      },
    ],
  },
];

/**
 * Removes items the user cannot access, then drops any section left empty.
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

export function isActiveRoute(pathname: string, item: NavItem): boolean {
  if (item.matchPrefix) {
    // `/exchange/transactions` must not light up for `/exchange/transactions/new`
    // when that has its own entry, so exact matches win elsewhere.
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }
  return pathname === item.href;
}
