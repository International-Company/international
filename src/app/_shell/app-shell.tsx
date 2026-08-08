'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
    ChevronsLeft,
  ChevronsRight,
  Keyboard,
  Languages,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Search,
  Sun,
  User as UserIcon,
  X,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { useTheme } from '@/ui/theme/provider';
import { Badge, Button } from '@/ui/primitives';
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator } from '@/ui/overlay';
import { cn, initials } from '@/ui/utils';
import { isActiveRoute, visibleNavigation, type NavItem } from './navigation';
import { NAV_ICONS } from './icons';
import { CommandPalette } from './command-palette';
import { ShortcutHelp, useShortcuts } from './shortcuts';

/**
 * The application shell.
 *
 * A fixed sidebar and a compact top bar, sized for people who spend all day in
 * one window: the sidebar collapses to icons to reclaim horizontal space for
 * tables, and every destination is also reachable without touching the mouse.
 */

export interface ShellUser {
  id: string;
  fullNameEn: string;
  fullNameAr: string;
  jobTitleEn: string | null;
  jobTitleAr: string | null;
  username: string;
  branchNameEn: string | null;
  branchNameAr: string | null;
  permissions: string[];
  roles: { key: string; nameEn: string; nameAr: string }[];
}

export function AppShell({
  user,
  children,
}: {
  user: ShellUser;
  children: React.ReactNode;
}) {
  const { t, locale, ln, toggleLocale, isRtl } = useLocale();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const pathname = usePathname();
  const router = useRouter();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const sections = visibleNavigation(user.permissions);

  // Restore the sidebar width preference — it is a per-device choice, so it
  // lives in localStorage rather than on the user profile.
  useEffect(() => {
    setCollapsed(localStorage.getItem('ifms.sidebar') === 'collapsed');
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem('ifms.sidebar', next ? 'collapsed' : 'expanded');
      return next;
    });
  }, []);

  // Navigating on mobile should always close the drawer behind you.
  useEffect(() => setMobileOpen(false), [pathname]);

  useShortcuts({
    onSearch: () => setPaletteOpen(true),
    onHelp: () => setHelpOpen((current) => !current),
    onToggleTheme: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
    onToggleLanguage: toggleLocale,
    onNavigate: (href) => router.push(href),
    permissions: user.permissions,
  });

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  const displayName = locale === 'ar' ? user.fullNameAr : user.fullNameEn;
  const jobTitle = ln(user as unknown as Record<string, unknown>, 'jobTitle');
  const branchName = ln(user as unknown as Record<string, unknown>, 'branchName');

  const CollapseIcon = isRtl
    ? collapsed
      ? ChevronsLeft
      : ChevronsRight
    : collapsed
      ? ChevronsRight
      : ChevronsLeft;

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-[var(--overlay)] lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Sidebar                                                          */}
      {/* ---------------------------------------------------------------- */}
      <aside
        className={cn(
          'fixed inset-y-0 z-40 flex-col border-e border-border-base bg-surface',
          'transition-[width] duration-200 ease-out',
          collapsed ? 'w-16' : 'w-60',
          'start-0',
          // Closed on a phone means removed, not parked off-screen. A fixed
          // element translated past the edge still counts towards the page's
          // scrollable width — and `overflow: clip` on an ancestor cannot
          // reclaim it, because a fixed element's containing block is the
          // viewport. The result was a page that could be dragged sideways to
          // reveal a menu that was supposed to be shut.
          mobileOpen ? 'flex animate-in' : 'hidden lg:flex',
        )}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-border-base px-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded bg-primary text-sm font-bold text-white">
            I
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-content">{t('app.name')}</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="ms-auto rounded p-1 text-content-tertiary hover:bg-surface-hover lg:hidden"
            aria-label={t('common.close')}
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-3" aria-label={t('nav.operations')}>
          {sections.map((section) => (
            <div key={section.id}>
              {!collapsed && (
                <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">
                  {t(section.labelKey)}
                </p>
              )}
              <ul className="space-y-0.5">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <NavLink
                      item={item}
                      active={isActiveRoute(pathname, item)}
                      collapsed={collapsed}
                      label={t(item.labelKey)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-border-base p-2">
          <button
            type="button"
            onClick={toggleCollapsed}
            className={cn(
              'hidden w-full items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5',
              'text-xs text-content-secondary transition-colors hover:bg-surface-hover hover:text-content lg:flex',
              collapsed && 'justify-center',
            )}
          >
            <CollapseIcon className="size-4 shrink-0" />
            {!collapsed && <span>{t('common.close')}</span>}
          </button>
        </div>
      </aside>

      {/* ---------------------------------------------------------------- */}
      {/* Main column                                                      */}
      {/* ---------------------------------------------------------------- */}
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col transition-[padding] duration-200',
          collapsed ? 'lg:ps-16' : 'lg:ps-60',
        )}
      >
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border-base bg-surface/95 px-3 backdrop-blur sm:px-4">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded p-2 text-content-secondary hover:bg-surface-hover lg:hidden"
            aria-label={t('nav.operations')}
          >
            <Menu className="size-5" />
          </button>

          {/* Global search opens the command palette */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className={cn(
              // `min-w-0` is load-bearing: a flex item will not shrink below
              // its content's intrinsic width without it, so on a narrow phone
              // this button kept its natural size and pushed the action buttons
              // beyond the right edge, making the whole page scroll sideways.
              'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] px-3 sm:max-w-md',
              'border border-border-base bg-surface-sunken text-sm text-content-tertiary',
              'transition-colors hover:bg-surface-hover',
            )}
          >
            <Search className="size-4 shrink-0" />
            <span className="truncate">{t('search.placeholder')}</span>
            <kbd className="ms-auto hidden shrink-0 rounded border border-border-base bg-surface px-1.5 py-0.5 font-mono text-[10px] text-content-tertiary sm:inline">
              Ctrl K
            </kbd>
          </button>

          <div className="ms-auto flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleLocale}
              title={t('settings.language')}
              aria-label={t('settings.language')}
            >
              <Languages className="size-4" />
            </Button>

            <DropdownMenu
              trigger={(props) => (
                <Button variant="ghost" size="icon" title={t('settings.theme')} {...props}>
                  {resolvedTheme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
                </Button>
              )}
            >
              {(close) => (
                <>
                  <MenuLabel>{t('settings.theme')}</MenuLabel>
                  <MenuItem
                    icon={<Sun />}
                    onClick={() => {
                      setTheme('light');
                      close();
                    }}
                  >
                    {t('settings.themeLight')}
                    {theme === 'light' && ' ✓'}
                  </MenuItem>
                  <MenuItem
                    icon={<Moon />}
                    onClick={() => {
                      setTheme('dark');
                      close();
                    }}
                  >
                    {t('settings.themeDark')}
                    {theme === 'dark' && ' ✓'}
                  </MenuItem>
                  <MenuItem
                    icon={<Monitor />}
                    onClick={() => {
                      setTheme('system');
                      close();
                    }}
                  >
                    {t('settings.themeSystem')}
                    {theme === 'system' && ' ✓'}
                  </MenuItem>
                </>
              )}
            </DropdownMenu>

            <DropdownMenu
              trigger={(props) => (
                <button
                  type="button"
                  className="ms-1 flex items-center gap-2 rounded-[var(--radius-control)] px-1.5 py-1 transition-colors hover:bg-surface-hover"
                  {...props}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-[11px] font-semibold text-primary-text">
                    {initials(displayName)}
                  </span>
                  <span className="hidden min-w-0 text-start sm:block">
                    <span className="block truncate text-xs font-medium text-content">
                      {displayName}
                    </span>
                    <span className="block truncate text-[10px] text-content-tertiary">
                      {jobTitle || branchName}
                    </span>
                  </span>
                </button>
              )}
            >
              {(close) => (
                <>
                  <div className="px-3 py-2">
                    <p className="text-sm font-medium text-content">{displayName}</p>
                    <p className="text-xs text-content-tertiary">{user.username}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {user.roles.map((role) => (
                        <Badge key={role.key} tone="primary">
                          {locale === 'ar' ? role.nameAr : role.nameEn}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <MenuSeparator />
                  <MenuItem
                    icon={<UserIcon />}
                    onClick={() => {
                      close();
                      router.push('/profile');
                    }}
                  >
                    {t('nav.profile')}
                  </MenuItem>
                  <MenuItem
                    icon={<Keyboard />}
                    shortcut="?"
                    onClick={() => {
                      close();
                      setHelpOpen(true);
                    }}
                  >
                    {t('shortcuts.title')}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={<LogOut />} tone="danger" onClick={signOut}>
                    {t('nav.signOut')}
                  </MenuItem>
                </>
              )}
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 px-3 py-4 sm:px-5 sm:py-6">
          <div className="mx-auto w-full max-w-[100rem]">{children}</div>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        permissions={user.permissions}
      />
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

function NavLink({
  item,
  active,
  collapsed,
  label,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  label: string;
}) {
  const Icon = NAV_ICONS[item.icon];

  return (
    <Link
      href={item.href}
      title={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-sm transition-colors',
        active
          ? 'bg-primary-subtle font-medium text-primary-text'
          : 'text-content-secondary hover:bg-surface-hover hover:text-content',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}
