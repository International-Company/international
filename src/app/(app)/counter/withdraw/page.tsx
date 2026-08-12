import { permanentRedirect } from 'next/navigation';

/**
 * Selling USDT moved in beside receiving it.
 *
 * Kept as a redirect rather than deleted: this address is on the home screen of
 * a teller's phone and in whatever he has bookmarked, and a counter tool that
 * answers "not found" during a customer's visit is worse than a stale link.
 */
export default function WithdrawMoved() {
  permanentRedirect('/counter/usdt?d=out');
}
