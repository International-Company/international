import {
  ArrowLeftRight,
  BadgeCheck,
  Banknote,
  Bell,
  CalendarCheck,
  ChartNoAxesColumn,
  Database,
  FileText,
  Gauge,
  KeyRound,
  Link2,
  Plus,
  ScrollText,
  Settings,
  Users,
  Vault,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { IconName } from './navigation';

/**
 * Icon registry.
 *
 * Navigation is declared as data, so it carries icon *names*; this maps them to
 * components. Icons are used for scanability only — every item is also labelled
 * in words, because an icon alone is not an interface.
 */
export const NAV_ICONS: Record<IconName, LucideIcon> = {
  dashboard: Gauge,
  transactions: ArrowLeftRight,
  newTransaction: Plus,
  approvals: BadgeCheck,
  rates: ChartNoAxesColumn,
  cashbox: Vault,
  day: CalendarCheck,
  wallet: Wallet,
  chain: Link2,
  customers: Users,
  reports: FileText,
  notifications: Bell,
  users: Users,
  roles: KeyRound,
  audit: ScrollText,
  settings: Settings,
  backup: Database,
  system: Banknote,
};
