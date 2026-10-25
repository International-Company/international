'use client';

import { HOME_CURRENCY } from '@/lib/home-currency';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDownUp,
  CalendarCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  History,
  Loader2,
  Plus,
  Printer,
  RotateCcw,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { normalizeDigits } from '@/core/money/money';
import { describeFailure, say } from '@/lib/failure';
import { api, ApiError, queryString } from '@/lib/api-client';
import { Button } from '@/ui/primitives';
import { ShareButton } from '@/ui/share';
import { Dialog, DropdownMenu, useToast } from '@/ui/overlay';
import { Field, Input, MoneyInput, Textarea } from '@/ui/form';
import { Money } from '@/ui/display';
import { CustomerPicker, type CustomerHit } from '@/ui/customer-picker';
import { cn } from '@/ui/utils';
import Link from 'next/link';
import { TodaySummary } from './today-summary';

/**
 * The exchange tool.
 *
 * One card, two amounts, a swap between them. That shape is what a person
 * already understands before they are taught anything, and it is the shape
 * every modern money app converged on for the same reason: the question at the
 * counter has only two sides.
 *
 * Both sides are live. Customers arrive with both questions — "what do I get
 * for this" and "I need exactly this much" — and a counter that answers only
 * the first makes the operator do arithmetic in front of them.
 *
 * Everything that is not those two numbers recedes. The rate sits under the
 * card as one quiet line. The customer field is folded away until someone
 * needs it. What can stop a trade — no rate, an empty drawer, a limit — appears
 * only when it applies, and always before the figure is read out rather than
 * after it has been promised.
 */

interface Currency {
  code: string;
  nameEn: string;
  nameAr: string;
  symbol: string;
  decimals: number;
}

interface MachineConfig {
  enabled: boolean;
  pairs: string[];
  transferChannels: string[];
  currencies: Currency[];
  quickAmounts: number[];
  maxAmount: string;
  requireCustomerAbove: string;
}

interface BoardRate {
  baseCode: string;
  quoteCode: string;
  channel?: string;
  buyRate: string;
  sellRate: string;
  effectiveFrom: string;
}

/** One channel's price for the whole amount. */
interface ChannelPrice {
  fromAmount: string;
  toAmount: string;
  rate: string;
  profit: string | null;
}

/**
 * Two prices, not one.
 *
 * The branch charges differently depending on where the money comes from, so
 * the server prices both channels in the same breath — quoting them separately
 * would let the board move between the two answers and price a split at rates
 * that were never simultaneously true.
 */
interface QuoteResponse {
  fromCurrency: string;
  toCurrency: string;
  cash: ChannelPrice | null;
  broker: ChannelPrice | null;
  availableCash: string;
  availableBroker: string;
  /** The office lets a short drawer go below zero, so a shortfall is not a stop. */
  overdraw: boolean;
  requiresCustomer: boolean;
  overLimit: boolean;
}

/** How the payout leaves the branch. */
type Channel = 'CASH' | 'BROKER' | 'SPLIT';

interface RecentRow {
  id: string;
  reference: string;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  createdAt: string;
  status: string;
  transferConfirmedAt: string | null;
}

/** Which field the operator is typing into; the other one is derived. */
type Side = 'pay' | 'receive';

export function MachineView({
  config,
  board,
  permissions,
}: {
  config: MachineConfig;
  board: BoardRate[];
  permissions: string[];
}) {
  const { t, ln, locale } = useLocale();
  /** The time of day an entry was made, as the teller reads it. */
  const clock = (value: string) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  const router = useRouter();
  const toast = useToast();

  const offered = useMemo(() => new Set(config.pairs), [config.pairs]);
  const byCode = useMemo(
    () => new Map(config.currencies.map((currency) => [currency.code, currency])),
    [config.currencies],
  );

  /** Currencies the customer may hand over — those with somewhere to go. */
  const payable = useMemo(
    () =>
      config.currencies.filter((currency) =>
        config.currencies.some((other) => offered.has(`${currency.code}/${other.code}`)),
      ),
    [config.currencies, offered],
  );

  /** Currencies reachable from a given one. */
  const receivable = useCallback(
    (from: string) => config.currencies.filter((c) => offered.has(`${from}/${c.code}`)),
    [config.currencies, offered],
  );

  const [pair, setPair] = useState<[string, string]>(() => {
    const first = config.pairs[0]?.split('/');
    return first && first.length === 2 ? [first[0]!, first[1]!] : ['USD', 'ILS'];
  });

  const [side, setSide] = useState<Side>('pay');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  /** An approval to break the board, once the manager has granted one. */
  const [approval, setApproval] = useState<Approval | null>(null);
  const [done, setDone] = useState<{ id: string; reference: string } | null>(null);
  const [counterpartyName, setCounterpartyName] = useState('');
  const [counterpartyPhone, setCounterpartyPhone] = useState('');
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  /** The entry the teller asked to delete, while he confirms it. */
  const [removing, setRemoving] = useState<RecentRow | null>(null);
  const [removeReason, setRemoveReason] = useState('');
  const [removeBusy, setRemoveBusy] = useState(false);
  /** Bumped by a deletion, so today's totals and the days follow at once. */
  const [removedTick, setRemovedTick] = useState(0);

  /*
   * How the payout is handed over, and — when it is split — how much of it goes
   * by transfer. Only that one figure is held: the cash share is always the
   * remainder, so the two can never drift apart or disagree with the total.
   */
  const [channel, setChannel] = useState<Channel>('CASH');
  const [brokerShare, setBrokerShare] = useState('');

  /*
   * Where a transfer goes. Defaults to the first destination the manager lists,
   * because for most offices there is only one and making the teller pick it
   * every time is a step that never changes its answer.
   */
  const [destination, setDestination] = useState(config.transferChannels[0] ?? '');

  /*
   * How the customer pays: across the counter, or by transfer into one of the
   * office's accounts. Paid by transfer, the deal is priced at the bank rate —
   * the money arrived through the bank, not as notes — and handed back in
   * cash, so the payout choice below gives way to a plain "paid in cash".
   */
  const [intakeVia, setIntakeVia] = useState<'CASH' | 'TRANSFER'>('CASH');
  const [intakeChannel, setIntakeChannel] = useState(config.transferChannels[0] ?? '');
  const paidByTransfer = intakeVia === 'TRANSFER';

  // Clearing hands the caret back, so the next customer can be served without
  // reaching for the mouse first.
  const payRef = useRef<HTMLInputElement>(null);

  const [from, to] = pair;
  const fromCurrency = byCode.get(from);
  const toCurrency = byCode.get(to);
  const canSeeSpread = permissions.includes('exchange.margin.view');

  const clearEntry = () => {
    setAmount('');
    setQuote(null);
    setError(null);
    setDone(null);
  };

  /**
   * Changing what the customer hands over.
   *
   * The other side may become unreachable — not every direction is offered —
   * so it moves to the first one that is rather than leaving the card in a
   * state the server would refuse.
   */
  const chooseFrom = (code: string) => {
    const targets = receivable(code);
    if (targets.length === 0) return;
    setPair([code, targets.some((c) => c.code === to) ? to : targets[0]!.code]);
    clearEntry();
  };

  const chooseTo = (code: string) => {
    setPair([from, code]);
    clearEntry();
  };

  const reversible = offered.has(`${to}/${from}`);
  const swap = () => {
    if (!reversible) return;
    setPair([to, from]);
    clearEntry();
  };

  // --- The teller's own recent work, for a reprint ---------------------------
  //
  // Inside the tool rather than on a screen of its own: a lost receipt is asked
  // for at the counter, while the next customer waits.
  const loadRecent = useCallback(async () => {
    try {
      setRecent(
        await api.get<RecentRow[]>(
          `/api/manage/transactions${queryString({ recent: true, type: 'EXCHANGE', pageSize: 4 })}`,
        ),
      );
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  // --- Deleting a wrong entry -------------------------------------------------
  //
  // Not erased: reversed. The drawer gets back exactly what the entry moved and
  // the books keep both rows, marked, so the day still adds up and the manager
  // can see what was undone and why. The server holds the limits: his own, the
  // open day, nothing in it already sent.
  const canRemove =
    permissions.includes('exchange.transaction.reverseOwn') ||
    permissions.includes('exchange.transaction.reverse');
  const todayKey = new Date().toDateString();
  const removable = (row: RecentRow) =>
    canRemove &&
    row.status !== 'REVERSED' &&
    !row.transferConfirmedAt &&
    new Date(row.createdAt).toDateString() === todayKey;

  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    try {
      await api.post(`/api/manage/transactions/${removing.id}`, {
        action: 'reverse',
        reason: removeReason.trim() || t('machine.deleteReasonDefault'),
      });
      toast.success(t('machine.deleted', { reference: removing.reference }));
      setRemoving(null);
      setRemovedTick((tick) => tick + 1);
      void loadRecent();
      router.refresh();
    } catch (cause) {
      const failure = describeFailure(cause, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setRemoveBusy(false);
    }
  };

  // --- Pricing ---------------------------------------------------------------
  //
  // Debounced, and every response is checked against the request that is
  // current when it lands. Without that a slow reply for "50" can overwrite the
  // reply for "500" and the customer is quoted the wrong figure.
  const requestId = useRef(0);

  useEffect(() => {
    const value = amount.trim();
    if (!value || Number(value) <= 0) {
      setQuote(null);
      setError(null);
      setQuoting(false);
      return;
    }

    const id = ++requestId.current;
    setQuoting(true);

    const timer = setTimeout(() => {
      void api
        .get<QuoteResponse>(
          `/api/exchange/machine${queryString({
            from,
            to,
            [side]: value,
            // A reverse-priced amount is sized against one channel; a split is
            // priced forwards, so the till is the sensible one to size against.
            // Paid by transfer, the whole deal is at the bank rate.
            through: channel === 'BROKER' || paidByTransfer ? 'BROKER' : 'CASH',
          })}`,
        )
        .then((result) => {
          if (id !== requestId.current) return;
          setQuote(result);
          setError(null);
        })
        .catch((cause) => {
          if (id !== requestId.current) return;
          setQuote(null);
          setError(
            cause instanceof ApiError
              ? say(t, cause.messageKey, cause.params) || cause.message
              : t('errors.generic'),
          );
        })
        .finally(() => {
          if (id === requestId.current) setQuoting(false);
        });
    }, 220);

    return () => clearTimeout(timer);
  }, [amount, from, to, side, channel, paidByTransfer, t]);

  /**
   * Typed entry, as opposed to the keypad.
   *
   * Takes whatever reached the field and keeps only what an amount can be:
   * Arabic-Indic digits become Western ones, a comma or an Arabic decimal mark
   * becomes a point, anything else is dropped, and the fraction is cut to the
   * currency's own precision — so a dinar accepts three places and a shekel
   * two, without the field ever rejecting a keystroke in a way that feels like
   * the keyboard is broken.
   */
  const typeAmount = useCallback(
    (raw: string, into: Side) => {
      setDone(null);
      setAmount(sanitiseAmount(raw, (into === 'pay' ? fromCurrency : toCurrency)?.decimals ?? 2));
    },
    [fromCurrency, toCurrency],
  );

  /**
   * Start typing anywhere.
   *
   * A teller who arrives at the screen and reaches for a digit should not have
   * to find and click a field first. The keystroke is redirected into the field
   * they would have clicked, caret and all, rather than being collected into a
   * hidden buffer — so what happens next is the ordinary behaviour of an
   * ordinary text field, which is the whole reason these are real fields now.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!/^[0-9]$/.test(event.key)) return;

      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      event.preventDefault();
      setDone(null);
      setSide('pay');
      setAmount(event.key);
      payRef.current?.focus();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const reset = () => {
    clearEntry();
    setCounterpartyName('');
    setCounterpartyPhone('');
    setCustomer(null);
    setCustomerOpen(false);
    setChannel('CASH');
    setBrokerShare('');
    setDestination(config.transferChannels[0] ?? '');
    setIntakeVia('CASH');
    setIntakeChannel(config.transferChannels[0] ?? '');
    setSide('pay');
    payRef.current?.focus();
  };

  /*
   * The two legs, in the scaled units the server speaks.
   *
   * Derived from the quote rather than from anything the operator typed into
   * the receive field, so the split always adds to the figure that will
   * actually be posted.
   */
  /*
   * What each channel pays out, priced at its own rate.
   *
   * The split is a share of what the customer *hands over*, not of what they
   * take away — the amount handed back is not known until both parts have been
   * priced, so it cannot be the thing divided. Each part is converted at its
   * channel's own per-unit rate, which is exactly what the server will do again
   * before it posts.
   */
  const legs = (() => {
    const none = { cash: 0n, broker: 0n, from: 0n };
    if (!quote) return none;

    // Paid by transfer: the bank's price, handed back in notes.
    if (paidByTransfer) {
      return quote.broker
        ? { cash: BigInt(quote.broker.toAmount), broker: 0n, from: BigInt(quote.broker.fromAmount) }
        : none;
    }

    if (channel === 'CASH') {
      return quote.cash
        ? { cash: BigInt(quote.cash.toAmount), broker: 0n, from: BigInt(quote.cash.fromAmount) }
        : none;
    }
    if (channel === 'BROKER') {
      return quote.broker
        ? { cash: 0n, broker: BigInt(quote.broker.toAmount), from: BigInt(quote.broker.fromAmount) }
        : none;
    }

    if (!quote.cash || !quote.broker) return none;

    /*
     * The customer names the transfer, in the money they are taking away:
     * "put two hundred shekels in my account". So that leg is exact, and what
     * it *costs* is worked backwards through the broker's own price. The till
     * then counts out whatever the rest of their money buys at its price —
     * which is why the total moves a little as the transfer is typed.
     */
    const paid = BigInt(quote.cash.fromAmount);
    const wanted = scaleAmount(brokerShare);
    if (wanted <= 0n) return { cash: 0n, broker: 0n, from: paid };

    const brokerRate = BigInt(quote.broker.rate);
    if (brokerRate <= 0n) return none;

    /*
     * What that transfer costs the customer, at the broker's price — rounded to
     * what their currency can actually express, which is what the server does
     * when it prices the same leg. Truncating instead left the screen a
     * hundredth above the figure that would be posted, and a teller reading out
     * a total the receipt then contradicts is an argument at the counter.
     */
    const costsFrom = roundTo((wanted * 100000000n) / brokerRate, fromCurrency?.decimals ?? 2);
    if (costsFrom >= paid) return { cash: 0n, broker: 0n, from: paid };

    /*
     * The till pays what the rest of the money buys before the transfer's cost
     * was rounded — the same figure the server posts. Rounding the cost first
     * and then the cash lost a hundredth: 300 USD at 2.90 with 70 transferred
     * came to 869.99 instead of 870.00.
     */
    const cashRate = BigInt(quote.cash.rate);
    const numerator = (paid * brokerRate - wanted * 100000000n) * cashRate;
    const denominator = brokerRate * 100000000n;
    const exact = (numerator + denominator / 2n) / denominator;

    return {
      cash: roundTo(exact, toCurrency?.decimals ?? 2),
      broker: wanted,
      from: paid,
    };
  })();

  /** What the customer walks away with, across both channels. */
  const received = legs.cash + legs.broker;

  const shortLeg = quote && !quote.overdraw
    ? legs.cash > BigInt(quote.availableCash)
      ? ('CASH' as const)
      : legs.broker > BigInt(quote.availableBroker)
        ? ('BROKER' as const)
        : null
    : null;

  /**
   * Whose price this deal is at. Paid by transfer it is the bank's, though the
   * customer takes notes — so the price and the payout channel part company.
   */
  const pricedAs: Channel = paidByTransfer ? 'BROKER' : channel;

  /** The rate to show, and the margin, for the chosen way of paying. */
  const shownRate =
    pricedAs === 'BROKER'
      ? (quote?.broker?.rate ?? null)
      : pricedAs === 'CASH'
        ? (quote?.cash?.rate ?? null)
        : // A split has no single rate; what the customer actually got per unit
          // is the only one that describes their trade.
          legs.from > 0n && received > 0n
          ? ((received * 100000000n) / legs.from).toString()
          : null;

  const margin = (() => {
    if (!canSeeSpread || !quote) return null;
    if (pricedAs === 'CASH') return quote.cash ? BigInt(quote.cash.profit ?? '0') : null;
    if (pricedAs === 'BROKER') return quote.broker ? BigInt(quote.broker.profit ?? '0') : null;

    // Each channel's margin in proportion to the money that went through it.
    if (!quote.cash?.profit || !quote.broker?.profit || legs.from === 0n) return null;
    const brokerRate = BigInt(quote.broker.rate);
    if (brokerRate <= 0n) return null;
    const costsFrom = (legs.broker * 100000000n) / brokerRate;
    if (costsFrom <= 0n || costsFrom >= legs.from) return null;
    return (
      (BigInt(quote.cash.profit) * (legs.from - costsFrom)) / legs.from +
      (BigInt(quote.broker.profit) * costsFrom) / legs.from
    );
  })();

  /**
   * The ways of paying the teller has chosen that carry no published price.
   *
   * Named rather than merely counted, because "there is no price" is a
   * different sentence depending on which one is missing — and a split needs
   * both, so it can be missing either or both of them.
   */
  const unpriced = quote
    ? ([
        (pricedAs === 'CASH' || pricedAs === 'SPLIT') && !quote.cash
          ? t('machine.payoutCash')
          : null,
        (pricedAs === 'BROKER' || pricedAs === 'SPLIT') && !quote.broker
          ? t('machine.payoutBank')
          : null,
      ].filter(Boolean) as string[])
    : [];

  /*
   * Money going through a bank belongs to a person who can be reached.
   *
   * Cash across a counter is anonymous by its nature; a transfer leaves a trail
   * with the broker's name on it, and the office is the only party who knows
   * whose money it was. The server refuses either way — this is so the teller
   * learns it while the customer is still in front of him rather than after
   * pressing record.
   */
  // Paid by transfer is money through a bank too, on the way in.
  const throughBank =
    paidByTransfer || channel === 'BROKER' || (channel === 'SPLIT' && legs.broker > 0n);
  const named = Boolean(customer) || counterpartyName.trim().length > 0;
  const reachable = Boolean(customer?.phone?.trim()) || counterpartyPhone.trim().length > 0;
  const needsContact = throughBank && (!named || !reachable);

  /** No price published for the way the teller has chosen to pay. */
  const noPrice = unpriced.length > 0;

  // Every reason the record button is unavailable, each of which the operator
  // has already been told about in words.
  const blocked =
    !quote ||
    noPrice ||
    received <= 0n ||
    quote.overLimit ||
    shortLeg !== null ||
    (quote.requiresCustomer && !customer) ||
    needsContact;

  const submit = async () => {
    if (!quote || blocked) return;
    setPosting(true);
    try {
      const result = await api.post<{ id: string; reference: string; status: string }>(
        '/api/exchange/machine',
        {
          from,
          to,
          // Paid by transfer is always handed back in cash.
          mode: paidByTransfer ? 'CASH' : channel,
          intakeChannel: paidByTransfer ? intakeChannel : null,
          [side]: amount.trim(),
          /*
           * Only the broker's share of what the customer hands over travels.
           * The till takes the rest and the server prices both legs from its
           * own board — sending the totals would let a screen holding a stale
           * price post figures that were never quoted.
           */
          brokerPayout: channel === 'SPLIT' ? unscale(scaleAmount(brokerShare)) : undefined,
          payoutChannel: legs.broker > 0n ? destination : null,
          /*
           * The id, never the price. The server reads the rate off the approval,
           * so this screen cannot name one even if it wanted to.
           */
          priceExceptionId: approval?.id ?? null,
          customerId: customer?.id ?? null,
          counterpartyName: counterpartyName.trim() || null,
          counterpartyPhone: counterpartyPhone.trim() || null,
        },
      );

      toast.success(t('machine.recorded'), result.reference);
      setDone(result);
      setAmount('');
      setQuote(null);
      setCounterpartyName('');
      setCounterpartyPhone('');
      setCustomer(null);
      setCustomerOpen(false);
      // Spent. Leaving it on screen would invite a second press at a price that
      // no longer exists.
      setApproval(null);
      void loadRecent();
      router.refresh();
    } catch (cause) {
      const failure = describeFailure(cause, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setPosting(false);
    }
  };

  const payAmount = side === 'pay' ? amount : legs.from > 0n ? legs.from.toString() : '';
  const receiveAmount = side === 'receive' ? amount : received > 0n ? received.toString() : '';

  // The rate for this direction, as one quiet line rather than a table.
  //
  // The board can carry the pair both ways round and once per channel. Taking
  // whichever row came first showed a dinar-or-shekel figure upside down (1 USD
  // = 0.32 ILS) whenever the reverse row happened to lead; the row published
  // in this direction, for this way of paying, is the one the teller means.
  const boardRate = (() => {
    const rows = board.filter(
      (rate) =>
        rate.baseCode !== HOME_CURRENCY &&
        ((rate.baseCode === from && rate.quoteCode === to) ||
          (rate.baseCode === to && rate.quoteCode === from)),
    );
    const wanted = channel === 'BROKER' ? 'BROKER' : 'CASH';
    const direct = (rate: BoardRate) => rate.baseCode === from;
    return (
      rows.find((rate) => direct(rate) && rate.channel === wanted) ??
      rows.find(direct) ??
      rows.find((rate) => rate.channel === wanted) ??
      rows[0]
    );
  })();

  /*
   * Buying or selling, said the way the office says it.
   *
   * Every pair is published once, as "1 base = n quote" with a buying and a
   * selling price. When the customer hands over the base, the office is buying
   * it; when he takes the base away, it is selling. The rate is always read in
   * the base — "1 USD = 2.95 ILS" — never as its upside-down 0.339, because
   * that is the figure on the board and the figure the customer asks about.
   */
  const base =
    to === HOME_CURRENCY ? from : from === HOME_CURRENCY ? to : (boardRate?.baseCode ?? from);
  const counter = base === from ? to : from;
  const selling = to === base;
  const baseCurrency = byCode.get(base);
  /** A from→to rate, turned to read "1 base = n counter". */
  const inBase = (rate: string) => {
    if (!selling) return rate;
    const value = BigInt(rate);
    return value > 0n ? ((10n ** 16n + value / 2n) / value).toString() : '0';
  };
  /** The published price for this side, for when nothing has been quoted yet. */
  const boardPrice = boardRate
    ? boardRate.baseCode === base
      ? selling
        ? boardRate.sellRate
        : boardRate.buyRate
      : effectiveRate(boardRate, from)
    : null;
  /*
   * The price as it was published, for one channel — what the manager typed,
   * and what the board on the wall says.
   *
   * A sale is priced through the inverse of the selling price, and turning
   * that back for the screen loses the last digit: 1 / (1 / 3.15) comes back
   * as 3.1499. So the line reads the published row itself, and only falls back
   * to the quote when there is no row to read or a one-off price was granted.
   */
  const publishedFor = (which: 'CASH' | 'BROKER'): string | null => {
    if (approval) return null;
    const row = board.find(
      (rate) => rate.baseCode === base && rate.quoteCode === counter && rate.channel === which,
    );
    return row ? (selling ? row.sellRate : row.buyRate) : null;
  };

  const deal = (side: 'BUY' | 'SELL') => {
    if ((side === 'SELL') === selling) return;
    swap();
  };

  const print = (id: string) => window.open(`/print/receipt/${id}`, '_blank');

  return (
    /*
     * A form, so Enter posts from any field. A narrow page gets one centred
     * column; a page with room for both keeps that same column and sets the
     * teller's account beside it, so the day is in view while he works.
     */
    <div className="@container">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className={cn(
          'mx-auto grid w-full max-w-xl gap-6',
          // Measured against the space the page actually has, not the window:
          // with the sidebar open, a wide screen can still be a narrow page.
          '@4xl:max-w-6xl @4xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)] @4xl:items-start',
        )}
      >
        <div className="space-y-4">
          {/* ============ The card ============ */}
          <div className="space-y-4">
            {/* Buying or selling the base — the first thing the customer says. */}
            <div
              role="radiogroup"
              aria-label={t('machine.dealSide')}
              className="grid grid-cols-2 gap-1 rounded-2xl bg-surface-sunken p-1 ring-1 ring-border-subtle"
            >
              {(['BUY', 'SELL'] as const).map((side) => {
                const active = (side === 'SELL') === selling;
                const possible = active || reversible;
                return (
                  <button
                    key={side}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={!possible}
                    onClick={() => deal(side)}
                    className={cn(
                      'flex h-12 flex-col items-center justify-center rounded-xl text-sm font-semibold transition-all',
                      active
                        ? side === 'BUY'
                          ? 'bg-success text-white shadow-[var(--shadow-sm)]'
                          : 'bg-primary text-white shadow-[var(--shadow-sm)]'
                        : 'text-content-secondary hover:bg-surface hover:text-content',
                      !possible && 'opacity-40',
                    )}
                  >
                    <span>
                      {t(side === 'BUY' ? 'machine.buying' : 'machine.selling', {
                        currency: baseCurrency ? ln(baseCurrency, 'name') : base,
                      })}
                    </span>
                    <span
                      className={cn(
                        'text-[11px] font-medium',
                        active ? 'text-white/80' : 'text-content-tertiary',
                      )}
                    >
                      {t(side === 'BUY' ? 'machine.buyingHint' : 'machine.sellingHint', {
                        base,
                        counter,
                      })}
                    </span>
                  </button>
                );
              })}
            </div>

            <section className="rounded-3xl bg-surface p-2 shadow-[var(--shadow-lg)] ring-1 ring-border-subtle">
              <AmountRow
                label={t('machine.customerPays')}
                currency={fromCurrency}
                options={payable}
                onChoose={chooseFrom}
                value={payAmount}
                active={side === 'pay'}
                onFocusSide={() => {
                  if (side !== 'pay') {
                    setSide('pay');
                    setAmount(legs.from > 0n ? formatPlain(legs.from.toString(), fromCurrency?.decimals ?? 2) : '');
                  }
                }}
                onType={(raw) => typeAmount(raw, 'pay')}
                inputRef={payRef}
                ln={ln}
              />

              {/*
                The swap sits on the seam where the two sides meet. Centred by a
                flex row rather than by `start-1/2` and a translate, because that
                pair has to be mirrored by hand in RTL and this does not.
              */}
              <div className="relative z-10 h-0">
                <div className="absolute inset-x-0 top-0 flex -translate-y-1/2 justify-center">
                  <button
                    type="button"
                    onClick={swap}
                    disabled={!reversible}
                    aria-label={t('machine.swap')}
                    className={cn(
                      'flex size-11 items-center justify-center rounded-full',
                      'bg-surface text-content-secondary shadow-[var(--shadow-md)] ring-4 ring-surface',
                      'transition-all duration-150',
                      reversible
                        ? 'hover:text-primary-text hover:shadow-[var(--shadow-lg)] active:scale-90'
                        : 'opacity-40',
                    )}
                  >
                    <ArrowDownUp className="size-5" />
                  </button>
                </div>
              </div>

              <AmountRow
                label={t('machine.customerReceives')}
                currency={toCurrency}
                options={receivable(from)}
                onChoose={chooseTo}
                value={receiveAmount}
                active={side === 'receive'}
                onFocusSide={() => {
                  if (side !== 'receive') {
                    setSide('receive');
                    setAmount(received > 0n ? formatPlain(received.toString(), toCurrency?.decimals ?? 2) : '');
                  }
                }}
                onType={(raw) => typeAmount(raw, 'receive')}
                ln={ln}
                hero
                busy={quoting}
              />
            </section>

            {/*
              The rate, as one line rather than a board.

              Silent when the chosen way of paying carries no price of its own.
              The line used to fall back to the board whenever the quote had
              nothing — which meant choosing the broker, for a pair with no broker
              price, replaced the figure with one taken from a different row
              entirely, still wearing the live dot, above a payout of zero. A rate
              that does not belong to what the teller is doing is worse than no
              rate at all: he reads it aloud.
            */}
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm">
              {noPrice ? (
                <span className="text-danger-text">
                  {t('machine.noChannelPrice', { channel: unpriced.join('، ') })}
                </span>
              ) : channel === 'SPLIT' &&
                quote?.cash &&
                quote.broker &&
                quote.cash.rate !== quote.broker.rate ? (
                /*
                 * A split is two trades at two published prices. Showing their
                 * blend (total received over total paid) produced figures no
                 * board ever carried — 2.8999 for a 2.90 and a 2.90 once the
                 * cash leg was rounded — and the teller reads the line aloud.
                 * So each part gets its own price, as published.
                 */
                <span className="flex flex-wrap items-center justify-center gap-2 text-content-secondary">
                  <span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden />
                  {(
                    [
                      ['payoutCash', publishedFor('CASH') ?? inBase(quote.cash.rate)],
                      ['payoutBank', publishedFor('BROKER') ?? inBase(quote.broker.rate)],
                    ] as const
                  ).map(([label, rate]) => (
                    <span
                      key={label}
                      className="flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-0.5"
                    >
                      <span className="text-xs">{t(`machine.${label}`)}</span>
                      <span className="ltr-content font-medium tabular-nums text-content">
                        1 {base} = {rateText(rate)} {counter}
                      </span>
                    </span>
                  ))}
                </span>
              ) : quote || boardRate ? (
                <span className="flex items-center gap-2 text-content-secondary">
                  <span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden />
                  <span className="text-xs">
                    {t(selling ? 'machine.sellPrice' : 'machine.buyPrice')}
                  </span>
                  <span className="ltr-content font-medium tabular-nums text-content">
                    1 {base} ={' '}
                    {rateText(
                      (() => {
                        const published = publishedFor(pricedAs === 'BROKER' ? 'BROKER' : 'CASH');
                        if (published) return published;
                        const quoted =
                          channel === 'SPLIT'
                            ? (quote?.cash?.rate ?? quote?.broker?.rate ?? null)
                            : shownRate;
                        if (quoted) return inBase(quoted);
                        return boardPrice ?? '0';
                      })(),
                    )}{' '}
                    {counter}
                  </span>
                </span>
              ) : (
                <span className="text-danger-text">{t('rates.noRateForPair')}</span>
              )}

              {canSeeSpread && margin !== null && (
                <span className="text-content-tertiary">
                  {t('transactions.profit')}{' '}
                  <Money
                    value={margin.toString()}
                    currency={to}
                    className="text-content-secondary"
                  />
                </span>
              )}
            </div>

            {/*
              How the customer pays. Notes across the counter, or a transfer
              into one of the office's accounts — priced at the bank rate, and
              handed back in cash, so the payout choice below steps aside.
            */}
            <div className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-content-secondary">
                  {t('machine.intakeTitle')}
                </span>
                <div dir="ltr" className="flex gap-1 rounded-full bg-surface-sunken p-1">
                  {(['CASH', 'TRANSFER'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => {
                        setIntakeVia(option);
                        setDone(null);
                        if (option === 'TRANSFER') {
                          setChannel('CASH');
                          setBrokerShare('');
                        }
                      }}
                      aria-pressed={intakeVia === option}
                      disabled={option === 'TRANSFER' && config.transferChannels.length === 0}
                      className={cn(
                        'h-9 rounded-full px-4 text-sm font-medium transition-colors disabled:opacity-40',
                        intakeVia === option
                          ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                          : 'text-content-tertiary hover:text-content-secondary',
                      )}
                    >
                      {option === 'CASH' ? t('machine.intakeCash') : t('machine.intakeTransfer')}
                    </button>
                  ))}
                </div>
              </div>

              {paidByTransfer && (
                <>
                  <label className="mt-3 block">
                    <span className="text-xs text-content-tertiary">{t('machine.intakeInto')}</span>
                    <select
                      value={intakeChannel}
                      onChange={(event) => {
                        setDone(null);
                        setIntakeChannel(event.target.value);
                      }}
                      className="mt-1 h-12 w-full rounded-xl bg-surface-sunken px-3 text-base font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary"
                    >
                      {config.transferChannels.map((entry) => (
                        <option key={entry} value={entry}>
                          {entry}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="mt-2 text-xs text-content-tertiary">
                    {t('machine.intakeTransferHint')}
                  </p>
                </>
              )}
            </div>

            {/* Paid by transfer is handed back in cash; nothing to choose. */}
            {!paidByTransfer && (
            <>
            {/*
              How it is handed over.
              Three segments, defaulting to cash, so the ordinary trade costs
              nothing to record. Splitting reveals one field — the transferred
              share — and the cash side is shown beside it as a consequence rather
              than as a second thing to fill in, because two editable halves of a
              fixed total is a sum the operator has to keep in their head.
            */}
            <div className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-content-secondary">
                  {t('machine.payoutTitle')}
                </span>

                <div dir="ltr" className="flex gap-1 rounded-full bg-surface-sunken p-1">
                  {(['CASH', 'BROKER', 'SPLIT'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => {
                        setChannel(option);
                        setDone(null);
                        if (option !== 'SPLIT') {
                          setBrokerShare('');
                        } else if (side !== 'pay') {
                          /*
                           * A split is priced from what the customer hands over —
                           * what they take away is not known until both parts have
                           * been priced, so it cannot be the thing divided.
                           *
                           * So choosing it moves the entry to that side, carrying
                           * the figure the counter has already worked out. The
                           * alternative was to leave the button offering a
                           * combination the server refuses, which the teller only
                           * discovers after pressing record in front of a customer.
                           */
                          setSide('pay');
                          setAmount(
                            legs.from > 0n
                              ? formatPlain(legs.from.toString(), fromCurrency?.decimals ?? 2)
                              : '',
                          );
                        }
                      }}
                      aria-pressed={channel === option}
                      className={cn(
                        'h-9 rounded-full px-4 text-sm font-medium transition-colors',
                        channel === option
                          ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                          : 'text-content-tertiary hover:text-content-secondary',
                      )}
                    >
                      {option === 'CASH'
                        ? t('machine.payoutCash')
                        : option === 'BROKER'
                          ? t('machine.payoutBank')
                          : t('machine.payoutSplit')}
                    </button>
                  ))}
                </div>
              </div>

              {/*
                Where it is going. Only asked when something is actually being
                transferred — and the server refuses a transfer without it, so
                this is the convenient way to answer, not the only one trusted.
              */}
              {channel !== 'CASH' && config.transferChannels.length > 0 && (
                <label className="mt-3 block">
                  <span className="text-xs text-content-tertiary">{t('machine.transferTo')}</span>
                  <select
                    value={destination}
                    onChange={(event) => {
                      setDone(null);
                      setDestination(event.target.value);
                    }}
                    className="mt-1 h-12 w-full rounded-xl bg-surface-sunken px-3 text-base font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary"
                  >
                    {config.transferChannels.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {/*
                Both halves in the money the customer takes away, because that is
                the money they are talking about: "put two hundred in my account
                and give me the rest." The transfer is exact — it is the figure
                that will appear on their statement — and the cash is whatever
                the remainder of their money buys at the till's own price, which
                is why it moves as the transfer is typed.
              */}
              {channel === 'SPLIT' && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs text-content-tertiary">
                      {t('machine.payoutBankLeg')} ({to})
                    </span>
                    <input
                      type="text"
                      dir="ltr"
                      inputMode="decimal"
                      autoComplete="off"
                      data-zoom-safe=""
                      value={brokerShare}
                      placeholder={(0).toFixed(toCurrency?.decimals ?? 2)}
                      onChange={(event) => {
                        setDone(null);
                        setBrokerShare(sanitiseAmount(event.target.value, toCurrency?.decimals ?? 2));
                      }}
                      className="mt-1 h-12 w-full rounded-xl bg-surface-sunken px-3 text-end text-xl font-semibold tabular-nums text-content outline-none ring-1 ring-transparent focus:ring-primary"
                    />
                  </label>

                  <div className="block">
                    <span className="text-xs text-content-tertiary">
                      {t('machine.payoutCashLeg')} ({to})
                    </span>
                    <p className="mt-1 flex h-12 items-center justify-end rounded-xl bg-surface-sunken px-3 text-xl font-semibold tabular-nums text-content-secondary ltr-content">
                      {formatScaled(legs.cash.toString(), toCurrency?.decimals ?? 2)}
                    </p>
                  </div>
                </div>
              )}
            </div>
            </>
            )}

            {/* --- Anything standing in the way --------------------------- */}
            {error && <Blocker tone="danger">{error}</Blocker>}

            {/*
              Every other blocker on this screen explains itself; this one used to
              grey the button and say nothing, so a teller looking at a payout of
              zero had no way to know the office had simply never published a
              price for paying that way.
            */}
            {noPrice && (
              <Blocker tone="danger" title={t('machine.noPriceTitle')}>
                {t('machine.noPriceBody', { channel: unpriced.join('، '), pair: `${from}/${to}` })}
              </Blocker>
            )}

            {quote && shortLeg === 'BROKER' && (
              <Blocker tone="danger" title={t('machine.cannotPayTitle')}>
                {t('machine.payoutBankShort', {
                  currency: to,
                  available: `${formatScaled(quote.availableBroker, toCurrency?.decimals ?? 2)} ${to}`,
                })}
              </Blocker>
            )}

            {quote && shortLeg === 'CASH' && (
              <Blocker tone="danger" title={t('machine.cannotPayTitle')}>
                {t('machine.cannotPayBody', {
                  account: `${t('drawers.title')} ${to}`,
                  available: `${formatScaled(quote.availableCash, toCurrency?.decimals ?? 2)} ${to}`,
                })}
              </Blocker>
            )}

            {quote?.overLimit && (
              <Blocker tone="warning" title={t('machine.overLimitTitle')}>
                {t('machine.overLimitBody', {
                  maximum: `${formatScaled(config.maxAmount, fromCurrency?.decimals ?? 2)} ${from}`,
                })}
              </Blocker>
            )}

            {quote?.requiresCustomer && !customer && (
              <Blocker tone="warning" title={t('machine.customerRequiredTitle')}>
                {t('machine.customerRequiredBody')}
              </Blocker>
            )}

            {done && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-success-subtle px-4 py-3 ring-1 ring-success-border">
                <span className="flex items-center gap-2 text-sm text-content">
                  <span className="flex size-6 items-center justify-center rounded-full bg-success">
                    <Check className="size-4 text-white" />
                  </span>
                  {t('machine.recorded')}
                  <span className="font-mono ltr-content">{done.reference}</span>
                </span>
                {permissions.includes('exchange.receipt.print') && (
                  <span className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Printer />}
                      onClick={() => print(done.id)}
                    >
                      {t('transactions.printReceipt')}
                    </Button>
                    <ShareButton transactionId={done.id} />
                  </span>
                )}
              </div>
            )}

            <PriceException
              from={from}
              to={to}
              channel={channel}
              payAmount={side === 'pay' ? amount : ''}
              approval={approval}
              onApproval={setApproval}
              enabled={permissions.includes('exchange.priceException.request')}
            />
          </div>

          {/* ============ Shortcuts and the action ============ */}
          <div className="space-y-3">
            {config.quickAmounts.length > 0 && (
              <div dir="ltr" className="flex flex-wrap gap-2">
                {config.quickAmounts.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setDone(null);
                      setSide('pay');
                      setAmount(String(value));
                    }}
                    className={cn(
                      'h-11 min-w-[4.5rem] flex-1 rounded-full bg-surface-sunken px-4',
                      'text-sm font-medium text-content-secondary',
                      'transition-colors hover:bg-surface-hover hover:text-content active:bg-surface-active',
                    )}
                  >
                    {value.toLocaleString('en-US')}
                  </button>
                ))}
              </div>
            )}

            <button
              type="submit"
              disabled={!quote || blocked || quoting || posting}
              className={cn(
                'flex h-14 w-full items-center justify-center gap-2 rounded-2xl',
                'bg-primary text-base font-semibold text-white',
                'shadow-[var(--shadow-md)] transition-all duration-150',
                'hover:bg-primary-hover active:scale-[0.98]',
                'disabled:opacity-40 disabled:shadow-none disabled:active:scale-100',
              )}
            >
              {posting ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5" />}
              {t('machine.record')}
            </button>

            <button
              type="button"
              onClick={reset}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-full text-sm text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content-secondary"
            >
              <RotateCcw className="size-4" />
              {t('machine.clear')}
            </button>
          </div>

          {/* ============ Folded away until needed ============ */}
          <div className="space-y-3">
            {customerOpen || customer || quote?.requiresCustomer || throughBank ? (
              <div className="rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-content">
                    {throughBank
                      ? t('machine.transferNeedsContact')
                      : quote?.requiresCustomer
                        ? t('machine.customerRequiredTitle')
                        : t('machine.customerOptional')}
                  </p>
                  {!quote?.requiresCustomer && !throughBank && (
                    <button
                      type="button"
                      onClick={() => {
                        setCustomerOpen(false);
                        setCustomer(null);
                        setCounterpartyName('');
                      }}
                      aria-label={t('common.close')}
                      className="rounded-full p-1 text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content"
                    >
                      <X className="size-4" />
                    </button>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <CustomerPicker
                    value={customer}
                    onChange={setCustomer}
                    permissions={permissions}
                    required={quote?.requiresCustomer || throughBank}
                  />
                  {!customer && (
                    <Field label={t('transactions.counterpartyName')} required={throughBank}>
                      {(props) => (
                        <Input
                          {...props}
                          value={counterpartyName}
                          onChange={(event) => setCounterpartyName(event.target.value)}
                        />
                      )}
                    </Field>
                  )}
                  {/*
                    A registered customer carries his own number; anybody else has
                    to leave one, because a transfer the office cannot trace to a
                    person is the one it will be asked about.
                  */}
                  {!customer?.phone && (
                    <Field label={t('transactions.counterpartyPhone')} required={throughBank}>
                      {(props) => (
                        <Input
                          {...props}
                          type="tel"
                          dir="ltr"
                          value={counterpartyPhone}
                          onChange={(event) => setCounterpartyPhone(event.target.value)}
                        />
                      )}
                    </Field>
                  )}
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCustomerOpen(true)}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border-base text-sm text-content-tertiary transition-colors hover:border-primary hover:text-primary-text"
              >
                <Plus className="size-4" />
                {t('machine.attachCustomer')}
              </button>
            )}

          </div>
        </div>

        {/*
          The teller's account, beside the machine whenever there is room for
          both, and below it otherwise: what today came to, what he just did (to
          reprint or delete), and each day with what of its own was owed.
        */}
        <aside className="@container min-w-0 space-y-4">
          <TodaySummary
            refreshKey={`${done?.id ?? ''}:${removedTick}`}
            decimalsOf={(code) => byCode.get(code)?.decimals ?? 2}
          />

          {recent.length > 0 && (
            <section className="overflow-hidden rounded-2xl bg-surface ring-1 ring-border-subtle">
              <header className="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-content">
                  <History className="size-4 text-primary-text" />
                  {t('machine.recent')}
                </h3>
              </header>
              <ul className="divide-y divide-border-subtle">
                {recent.map((row) => {
                  const gone = row.status === 'REVERSED';
                  return (
                    <li
                      key={row.id}
                      className={cn(
                        'flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-surface-sunken/60',
                        gone && 'bg-danger-subtle/20',
                      )}
                    >
                      <div className="min-w-0">
                        <p
                          className={cn(
                            'ltr-content flex flex-wrap items-baseline gap-x-1.5 text-sm font-medium tabular-nums',
                            gone
                              ? 'text-content-tertiary line-through decoration-danger/60'
                              : 'text-content',
                          )}
                        >
                          <span>
                            {formatScaled(row.fromAmount, byCode.get(row.fromCurrency)?.decimals ?? 2)}{' '}
                            <span className="text-xs text-content-secondary">{row.fromCurrency}</span>
                          </span>
                          <span className="text-content-tertiary">→</span>
                          <span>
                            {formatScaled(row.toAmount, byCode.get(row.toCurrency)?.decimals ?? 2)}{' '}
                            <span className="text-xs text-content-secondary">{row.toCurrency}</span>
                          </span>
                        </p>
                        <p className="mt-0.5 flex items-center gap-2 text-[11px] text-content-tertiary">
                          <span className="tabular-nums ltr-content">{clock(row.createdAt)}</span>
                          <span className="font-mono ltr-content">{row.reference}</span>
                          {gone && (
                            <span className="rounded bg-danger-subtle px-1.5 py-px font-medium text-danger-text">
                              {t('machine.deletedBadge')}
                            </span>
                          )}
                        </p>
                      </div>
                      <span className="flex shrink-0 items-center gap-0.5">
                        {permissions.includes('exchange.receipt.print') && (
                          <button
                            type="button"
                            onClick={() => print(row.id)}
                            title={t('transactions.printReceipt')}
                            aria-label={t('transactions.printReceipt')}
                            className="flex size-10 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content sm:size-8"
                          >
                            <Printer className="size-4" />
                          </button>
                        )}
                        {permissions.includes('exchange.receipt.print') && (
                          <ShareButton transactionId={row.id} compact />
                        )}
                        {removable(row) && (
                          <button
                            type="button"
                            onClick={() => {
                              setRemoveReason('');
                              setRemoving(row);
                            }}
                            title={t('machine.delete')}
                            aria-label={t('machine.delete')}
                            className="flex size-10 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-danger-subtle hover:text-danger-text sm:size-8"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* The days have a screen of their own; one tap away from here. */}
          <Link
            href="/counter/days"
            className="flex items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3 text-sm font-medium text-content ring-1 ring-border-subtle transition-colors hover:bg-surface-sunken hover:text-primary-text"
          >
            <span className="flex items-center gap-2">
              <CalendarCheck className="size-4 text-primary-text" />
              {t('nav.workDays')}
            </span>
            <ChevronLeft className="size-4 text-content-tertiary rtl:rotate-0 ltr:rotate-180" />
          </Link>
        </aside>

        <Dialog
          open={removing !== null}
          onClose={() => {
            if (!removeBusy) setRemoving(null);
          }}
          title={t('machine.deleteTitle')}
          description={removing ? t('machine.deleteBody', { reference: removing.reference }) : ''}
          footer={
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRemoving(null)}
                disabled={removeBusy}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                icon={<Trash2 />}
                loading={removeBusy}
                onClick={() => void remove()}
              >
                {t('machine.deleteConfirm')}
              </Button>
            </>
          }
        >
          {removing && (
            <div className="space-y-3">
              <p className="ltr-content rounded-lg bg-surface-sunken px-3 py-2 text-center text-sm font-medium tabular-nums text-content">
                {formatScaled(removing.fromAmount, byCode.get(removing.fromCurrency)?.decimals ?? 2)}{' '}
                {removing.fromCurrency}
                <span className="mx-2 text-content-tertiary">→</span>
                {formatScaled(removing.toAmount, byCode.get(removing.toCurrency)?.decimals ?? 2)}{' '}
                {removing.toCurrency}
              </p>
              <Field label={t('machine.deleteReason')}>
                {(props) => (
                  <Input
                    {...props}
                    value={removeReason}
                    onChange={(event) => setRemoveReason(event.target.value)}
                    placeholder={t('machine.deleteReasonDefault')}
                    maxLength={200}
                  />
                )}
              </Field>
            </div>
          )}
        </Dialog>
      </form>
    </div>
  );
}

/**
 * One side of the card: what is handed over, or what is handed back.
 *
 * The receiving side is the hero — it is the figure read out loud and the one
 * the customer checks — so it is the largest thing on the screen and the only
 * one carrying colour.
 */
function AmountRow({
  label,
  currency,
  options,
  onChoose,
  value,
  active,
  onFocusSide,
  onType,
  inputRef,
  hero,
  busy,
  ln,
}: {
  label: string;
  currency: Currency | undefined;
  options: Currency[];
  onChoose: (code: string) => void;
  value: string;
  active: boolean;
  onFocusSide: () => void;
  onType: (raw: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  hero?: boolean;
  busy?: boolean;
  ln: (record: object, baseKey: string) => string;
}) {
  const decimals = currency?.decimals ?? 2;
  const zero = (0).toFixed(decimals);

  const field = useRef<HTMLInputElement>(null);
  const wasActive = useRef(active);

  /*
   * Select this field's contents the moment it becomes the active side.
   *
   * A layout effect rather than a timer, and this distinction is the whole
   * point: focusing the other side re-seeds this field with the converted
   * figure, so selecting inside the focus handler would select the text that is
   * about to be replaced. Deferring with `setTimeout` fixes that and introduces
   * something worse — a fast typist has already entered two or three digits by
   * the time the callback runs, and select-all then eats them. A layout effect
   * runs synchronously after the DOM is updated and before anything else can be
   * typed, so there is no window to race.
   */
  useLayoutEffect(() => {
    const node = field.current;
    if (active && !wasActive.current && node && node === document.activeElement) {
      node.select();
    }
    wasActive.current = active;
  }, [active]);

  /*
   * While typing, show exactly what was typed — reformatting mid-entry moves
   * the digits under the operator's fingers.
   *
   * An empty active field shows nothing and leans on its placeholder. Putting a
   * literal "0.00" in the field looks the same but is real text, so the next
   * keystroke lands after it and 5 becomes 0.005.
   */
  const display = active ? value : value === '' ? zero : formatScaled(value, decimals);

  return (
    <div
      className={cn(
        'rounded-[1.35rem] px-5 transition-colors duration-150',
        hero ? 'py-6' : 'py-5',
        active ? 'bg-primary-subtle' : 'bg-surface-sunken',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-content-secondary">{label}</span>
        {busy && <Loader2 className="size-3.5 animate-spin text-content-tertiary" />}
      </div>

      {/*
        Tapping anywhere along the row puts the caret in the field. The input is
        only as tall as its text — about nineteen pixels — so without this a
        thumb has to be aimed at the digits themselves, which is not a target
        anyone should have to hit while a customer waits.
      */}
      <div
        className="mt-3 flex cursor-text items-center gap-3 py-1"
        onClick={(event) => {
          if (event.target === event.currentTarget) field.current?.focus();
        }}
      >
        <DropdownMenu
          align="start"
          trigger={(props) => (
            <button
              {...props}
              type="button"
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-full bg-surface py-1.5 pe-2 ps-1.5',
                'shadow-[var(--shadow-sm)] ring-1 ring-border-subtle',
                'transition-all duration-150 hover:ring-primary active:scale-95',
              )}
            >
              <span
                className={cn(
                  'flex size-8 items-center justify-center rounded-full text-sm font-semibold',
                  hero ? 'bg-primary text-white' : 'bg-surface-sunken text-content-secondary',
                )}
              >
                {currency?.symbol}
              </span>
              <span className="font-semibold text-content ltr-content">{currency?.code}</span>
              <ChevronDown className="size-4 text-content-tertiary" />
            </button>
          )}
        >
          {(close) => (
            <div className="py-1">
              {options.map((option) => (
                <button
                  key={option.code}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onChoose(option.code);
                    close();
                  }}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2 text-start transition-colors',
                    'hover:bg-surface-hover',
                    option.code === currency?.code && 'bg-primary-subtle',
                  )}
                >
                  <span className="flex size-7 items-center justify-center rounded-full bg-surface-sunken text-xs font-semibold text-content-secondary">
                    {option.symbol}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-content ltr-content">
                      {option.code}
                    </span>
                    <span className="block truncate text-xs text-content-tertiary">
                      {ln(option as unknown as Record<string, unknown>, 'name')}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </DropdownMenu>

        {/*
          A real field, not a styled button.

          The obvious way to enter a number is to click it and type, so that is
          what happens: a caret, select-on-focus, and the keypad writing into the
          same value. Making this a button meant a click gave no caret and the
          focus ring landed on whatever button sat next to it.
        */}
        <input
          ref={(node) => {
            field.current = node;
            if (inputRef) inputRef.current = node;
          }}
          type="text"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          /*
           * Sets its own size, and never drops below 20px — comfortably past
           * the point where mobile Safari zooms — so the global 16px guard for
           * small fields would only shrink it. See `globals.css`.
           */
          data-zoom-safe=""
          aria-current={active}
          aria-label={label}
          value={display}
          placeholder={zero}
          onFocus={(event) => {
            // Already the active side: nothing is about to re-render, so the
            // next digit can safely replace what is here.
            if (active) event.currentTarget.select();
            else onFocusSide();
          }}
          onChange={(event) => onType(event.target.value)}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-end tabular-nums tracking-tight outline-none',
            'placeholder:text-content-tertiary transition-[font-size] duration-100',
            hero ? 'font-bold text-primary-text' : 'font-semibold text-content',
            amountSize(display || zero, Boolean(hero)),
          )}
        />
      </div>
    </div>
  );
}

/** A reason the trade cannot go through, said plainly and in one place. */
function Blocker({
  tone,
  title,
  children,
}: {
  tone: 'danger' | 'warning';
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex gap-3 rounded-2xl px-4 py-3 ring-1',
        tone === 'danger'
          ? 'bg-danger-subtle ring-danger-border'
          : 'bg-warning-subtle ring-warning-border',
      )}
    >
      <TriangleAlert
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'danger' ? 'text-danger-text' : 'text-warning-text',
        )}
      />
      <div className="min-w-0 text-sm">
        {title && <p className="font-medium text-content">{title}</p>}
        <p className="text-content-secondary">{children}</p>
      </div>
    </div>
  );
}

/**
 * How large the figure can be drawn without running out of row.
 *
 * A phone gives the amount roughly two hundred pixels once the currency pill
 * has taken its share, which a seven-figure sum at the largest size overruns.
 * Stepping down by length keeps the number whole — truncating an amount, or
 * letting it scroll out of sight inside its own field, is the one thing a
 * counter display must never do.
 */
function amountSize(text: string, hero: boolean): string {
  const digits = text.length;

  if (digits > 12) return hero ? 'text-2xl sm:text-3xl' : 'text-xl sm:text-2xl';
  if (digits > 9) return hero ? 'text-3xl sm:text-4xl' : 'text-2xl sm:text-3xl';
  return hero ? 'text-4xl sm:text-5xl' : 'text-3xl sm:text-4xl';
}

/**
 * The published figure for a direction, as a rate from one unit of `from`.
 *
 * A board stores one row per pair: the office buys the base at `buyRate` and
 * sells it at `sellRate`. Handing over the base is a purchase, handing over the
 * quote is a sale priced by the reciprocal — so the direction decides which of
 * the two the line should show, and whether it needs inverting.
 */
/**
 * A rate as it is read aloud: four places where the board uses them, but not
 * a trail of zeros after the second — 2.90, 2.895, 0.7078.
 */
function rateText(scaled: string): string {
  // Rounded to the fourth place, not cut at it: 3.14999997 is 3.15.
  const value = BigInt(scaled || '0');
  const rounded = ((value + 5_000n) / 10_000n) * 10_000n;
  return formatScaled(rounded.toString(), 4).replace(/(\.\d{2}\d*?)0+$/, '$1');
}

function effectiveRate(rate: BoardRate, from: string): string {
  if (rate.baseCode === from) return rate.buyRate;

  const sell = BigInt(rate.sellRate);
  if (sell === 0n) return '0';
  return ((10n ** 16n) / sell).toString();
}

/**
 * Keeps only what an amount can be.
 *
 * Arabic-Indic digits become Western ones, a comma or an Arabic decimal mark
 * becomes a point, anything else is dropped, and the fraction is cut to the
 * currency's own precision — so a dinar accepts three places and a shekel two,
 * without the field ever rejecting a keystroke in a way that feels like the
 * keyboard is broken.
 */
function sanitiseAmount(raw: string, limit: number): string {
  const cleaned = normalizeDigits(raw)
    .replace(/[,٫٬]/g, '.')
    .replace(/[^\d.]/g, '');

  const [whole = '', ...rest] = cleaned.split('.');
  const hasPoint = rest.length > 0 && limit > 0;
  const fraction = rest.join('').slice(0, limit);

  const next = hasPoint ? `${whole}.${fraction}` : whole;
  // "007" is a typo, "0.5" is not.
  return next.replace(/^0+(?=\d)/, '');
}

/**
 * Converts an amount at a per-unit rate, both scaled 1e8, rounding half-up to
 * the target currency's precision.
 *
 * The same arithmetic the server performs, so the figure the customer is read
 * out is the figure that gets posted rather than one that rounds differently on
 * the way through.
 */
/** A scaled figure cut to what a currency can express, rounding half up. */
function roundTo(amount: bigint, decimals: number): bigint {
  const step = 10n ** BigInt(8 - decimals);
  if (step <= 1n) return amount;
  return ((amount + step / 2n) / step) * step;
}

/**
 * A typed decimal, as the scaled integer the rest of the system uses.
 *
 * Parsed digit by digit rather than through `Number`: a float cannot hold
 * 1234567.89 exactly, and the error lands in the fraction — which is the part
 * this is being used to decide.
 */
function scaleAmount(text: string): bigint {
  const [whole = '', fraction = ''] = text.trim().split('.');
  const digits = (whole.replace(/\D/g, '') || '0') + fraction.replace(/\D/g, '').padEnd(8, '0').slice(0, 8);
  try {
    return BigInt(digits);
  } catch {
    return 0n;
  }
}

/** The inverse, for putting an amount back on the wire. */
function unscale(value: bigint): string {
  const digits = value.toString().padStart(9, '0');
  return `${digits.slice(0, -8)}.${digits.slice(-8)}`;
}

/** Renders a 1e8-scaled string at a currency's own precision. */
function formatScaled(scaled: string, decimals: number): string {
  const value = BigInt(scaled || '0');
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(9, '0');

  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).slice(0, decimals);

  const grouped = Number(whole).toLocaleString('en-US');
  const text = decimals > 0 ? `${grouped}.${fraction}` : grouped;
  return negative ? `-${text}` : text;
}

/** Renders a 1e8-scaled string without grouping, for an editable field. */
function formatPlain(scaled: string, decimals: number): string {
  const value = BigInt(scaled || '0');
  const digits = value.toString().padStart(9, '0');
  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).slice(0, decimals);
  return decimals > 0 ? `${whole}.${fraction}` : whole;
}

// ---------------------------------------------------------------------------
// Breaking the price
// ---------------------------------------------------------------------------

interface Approval {
  id: string;
  reference: string;
  status: string;
  fromCurrency: string;
  toCurrency: string;
  channel: string;
  maxFromAmount: string;
  requestedRate: string;
  approvedRate: string | null;
  expiresAt: string | null;
}

/**
 * The teller's half of a broken price, on the machine screen where he needs it.
 *
 * Three states and nothing else: nothing asked, asked and waiting, granted and
 * ticking. The countdown is shown rather than merely enforced — a teller who
 * cannot see the seconds go will press record on a dead approval and be refused
 * for a reason he had no way to anticipate, in front of the customer.
 *
 * It polls only while something is outstanding. A screen sitting idle at the
 * counter all day should not be asking the server anything.
 */
function PriceException({
  from,
  to,
  channel,
  payAmount,
  approval,
  onApproval,
  enabled,
}: {
  from: string;
  to: string;
  channel: Channel;
  payAmount: string;
  approval: Approval | null;
  onApproval: (value: Approval | null) => void;
  enabled: boolean;
}) {
  const { t } = useLocale();
  const toast = useToast();

  const [asking, setAsking] = useState(false);
  const [wanted, setWanted] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Approval | null>(null);
  const [left, setLeft] = useState(0);

  const outstanding = waiting !== null || approval !== null;

  const poll = useCallback(async () => {
    try {
      const data = await api.get<{ mine?: Approval[] }>('/api/exchange/price-exceptions');
      const rows = data.mine ?? [];
      const live = rows.find((row) => row.status === 'APPROVED');
      const pending = rows.find((row) => row.status === 'PENDING');
      setWaiting(pending ?? null);
      if (live) onApproval(live);
    } catch {
      // A poll that fails changes nothing on screen; the teller still has the
      // board and can trade on it.
    }
  }, [onApproval]);

  /*
   * Asked once when the screen opens, whatever the state — the manager may have
   * answered while the teller was on another screen, or the tab may have been
   * reopened, and a strip that only polls once something is already outstanding
   * can never learn about the approval it is meant to show.
   */
  useEffect(() => {
    if (enabled) void poll();
  }, [enabled, poll]);

  // After that, only while something is actually outstanding. A screen sitting
  // idle at the counter all day should not be asking the server anything.
  useEffect(() => {
    if (!enabled || !outstanding) return;
    const timer = setInterval(() => void poll(), 4000);
    return () => clearInterval(timer);
  }, [enabled, outstanding, poll]);

  // The countdown, ticking on its own so the number moves without a request.
  useEffect(() => {
    if (!approval?.expiresAt) return;
    const tick = () => {
      const seconds = Math.max(
        0,
        Math.floor((new Date(approval.expiresAt!).getTime() - Date.now()) / 1000),
      );
      setLeft(seconds);
      if (seconds === 0) onApproval(null);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [approval, onApproval]);

  if (!enabled) return null;

  // An approval names one channel, so a deal being settled another way cannot
  // spend it. Saying so here beats being refused at the moment of recording.
  const fits =
    approval !== null &&
    approval.fromCurrency === from &&
    approval.toCurrency === to &&
    (channel === 'SPLIT' || approval.channel === channel);

  const ask = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ status: string }>('/api/exchange/price-exceptions', {
        action: 'request',
        fromCurrency: from,
        toCurrency: to,
        channel: channel === 'BROKER' ? 'BROKER' : 'CASH',
        maxFromAmount: payAmount.trim() || '0',
        requestedRate: wanted,
        reason: reason.trim() || null,
      });
      // Within the teller's own room it applies at once; past it, the manager decides.
      toast.success(result.status === 'APPROVED' ? t('exception.selfApplied') : t('exception.asked2'));
      setAsking(false);
      setWanted('');
      setReason('');
      await poll();
    } catch (cause) {
      const failure = describeFailure(cause, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {approval && fits ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-warning-subtle px-4 py-3 text-sm ring-1 ring-warning-border">
          <span className="font-semibold">
            {t('exception.live', { rate: formatPlain(approval.approvedRate ?? '0', 6) })}
          </span>
          <span className="text-content-secondary text-xs">
            {t('exception.liveHint', { amount: formatPlain(approval.maxFromAmount, 2) })}
          </span>
          <span className="ms-auto font-mono text-xs">
            {t('exception.expiresIn', { seconds: left })}
          </span>
          <Button size="sm" variant="ghost" onClick={() => onApproval(null)}>
            {t('exception.dropIt')}
          </Button>
        </div>
      ) : waiting ? (
        <div className="flex items-center gap-3 rounded-2xl bg-surface-sunken px-4 py-3 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('exception.pendingMine')}
          <span className="font-mono ltr-content ms-auto text-xs">{waiting.reference}</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAsking(true)}
          className="text-content-secondary hover:text-content text-xs underline underline-offset-4"
        >
          {t('exception.ask')}
        </button>
      )}

      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title={t('exception.ask')}
        description={t('exception.askHint')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={ask} loading={busy} disabled={!wanted}>
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('exception.askRate')} required>
            {(field) => (
              <MoneyInput {...field} value={wanted} onValueChange={setWanted} decimals={6} />
            )}
          </Field>
          <Field label={`${t('exception.askAmount')} — ${from}`}>
            {() => (
              <p className="text-content-secondary text-sm">
                {payAmount.trim() || '—'}
              </p>
            )}
          </Field>
          <Field label={t('exception.askReason')}>
            {(field) => (
              <Textarea
                {...field}
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
        </div>
      </Dialog>
    </>
  );
}
