import {
  ArrowLeftRight,
  CalendarCheck,
  Calculator,
  ChartNoAxesColumn,
  QrCode,
  Send,
  ScrollText,
  BookOpen,
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
  machine: Calculator,
  counter: QrCode,
  rates: ChartNoAxesColumn,
  drawers: Vault,
  day: CalendarCheck,
  wallet: Wallet,
  ledger: BookOpen,
  transfer: Send,
  transactions: ArrowLeftRight,
  audit: ScrollText,
  staff: Users,
  settings: Settings,
};
