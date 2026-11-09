'use client';

import { networkLabel } from '@/lib/network-label';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  Copy,
  ExternalLink,
  History,
  Inbox,
  Loader2,
  MessageCircle,
  Printer,
  RefreshCw,
  UserCheck,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, queryString } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { QrCode } from '@/core/qr/qr-code';
import { Alert, Badge, Button, Card, CardBody, CardHeader } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Input, Select } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import { CustomerPicker, type CustomerHit } from '@/ui/customer-picker';
import { PendingTransfersButton } from '@/ui/pending-transfers';
import { ShareButton } from '@/ui/share';
import { AutoPrintToggle, printAfterRecording } from '@/ui/auto-print';
import { cn } from '@/ui/utils';
import { convert, normalizeDigits } from '@/core/money/money';
import { payoutAtPercent, validPercent } from '@/modules/usdt/percent-payout';
import { tellerPriceAllowed, withinEditLimit } from '@/modules/usdt/payout-edit';

/**
 * Taking USDT at the window: the address, then the log of what actually landed.
 *
 * ## Why there is no amount to type
 *
 * Asking the teller to type what the customer says they sent turns a fact into
 * a claim and then searches for it. Two customers sending the same round number
 * are then indistinguishable by the only thing the search knows, and a week of
 * unclaimed transfers for that number all answer at once.
 *
 * The chain already keeps a chronological record of everything that reached the
 * address. So this shows that record instead: newest first, with the time, the
 * sender and the hash. The customer sent four minutes ago; their transfer is at
 * the top. Nobody types anything and nothing has to be matched.
 *
 * ## Why every row opens the explorer
 *
 * Because the office's word for what arrived should not be the only word
 * available. A teller who can put the transfer on TronScan next to the
 * customer's own wallet has settled the question in front of them, in the one
 * place neither of them controls. It is also the answer to "are you sure it
 * arrived?" that does not require the customer to trust this screen.
 *
 * ## Where it still refuses
 *
 * Priced at the board when it is recorded, because nothing was promised
 * earlier. A transfer that has not reached its confirmations is shown — the
 * customer is standing there and "it is coming" beats an empty list — but it
 * cannot be paid.
 */

interface CounterAddress {
  id: string;
  label: string;
  labelAr: string;
  network: string;
  address: string;
  tokenSymbol: string;
  minConfirmations: number;
  drawerId: string | null;
  isAutomatic: boolean;
}

/** How the customer is paid, and therefore which balance the money leaves. */
type Mode = 'CASH' | 'BROKER' | 'SPLIT';

/** One price per channel, because the office charges differently for each. */
interface Priced {
  amount: string;
  payoutCurrency: string;
  cash: { toAmount: string; rate: string } | null;
  broker: { toAmount: string; rate: string } | null;
  /** USDT into dollars: the manager's percentages, to start from. */
  percent?: { cash: string; broker: string };
  /** How far the teller may change the computed figure, in percent. Zero: no limit. */
  editLimit: number;
}

interface Arrival {
  id: string;
  txHash: string;
  amount: string;
  confirmations: number;
  required: number;
  ready: boolean;
  firstSeenAt: string;
  fromAddress: string | null;
  explorerUrl: string;
  wallet: { id: string; label: string; labelAr: string; network: string; tokenSymbol: string };
  recognised: Recognised | null;
  /** Set on a deal made of several transfers: the rest of them, and their sums. */
  alsoIds?: string[];
  parts?: string[];
  mixedSenders?: boolean;
  mixedWallets?: boolean;
}

interface SavedPayout {
  id: string;
  channel: string;
  account: string;
  isDefault: boolean;
  timesUsed: number;
}

/** What the server knows about the address a transfer came from. */
type Recognised =
  | {
      status: 'KNOWN';
      customer: {
        id: string;
        code: string;
        fullNameEn: string;
        fullNameAr: string;
        phone: string | null;
        isBlocked: boolean;
      };
      timesSeen: number;
      payout: SavedPayout | null;
    }
  | { status: 'SHARED'; customers: number; marked?: boolean };

/** Where this browser keeps the currency its teller last paid in. */
const LAST_CURRENCY_KEY = 'ifms.receive.lastCurrency';

/** How often the log refreshes itself while a customer is waiting. */
const POLL_MS = 10_000;

export function ReceiveFlow({
  addresses,
  currencies,
  companyName,
  transferChannels,
  permissions,
}: {
  addresses: CounterAddress[];
  currencies: { code: string; nameEn: string; nameAr: string; decimals: number }[];
  /** Put at the head of an address sent out, so it does not arrive anonymous. */
  companyName: string;
  /** The broker's accounts a transfer may be instructed to. */
  transferChannels: string[];
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [walletId, setWalletId] = useState(addresses[0]?.id ?? '');
  const [arrivals, setArrivals] = useState<Arrival[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Which address's arrivals are shown: one wallet's id, or all of them. */
  const [logWallet, setLogWallet] = useState('ALL');

  const [chosen, setChosen] = useState<Arrival | null>(null);
  /** The transfers ticked to settle together. */
  const [merging, setMerging] = useState<string[]>([]);
  const [payoutCurrency, setPayoutCurrency] = useState(currencies[0]?.code ?? 'ILS');
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [counterpartyName, setCounterpartyName] = useState('');
  const [quote, setQuote] = useState<Priced | null>(null);
  const [mode, setMode] = useState<Mode>('CASH');
  const [brokerShare, setBrokerShare] = useState('');
  const [percentCash, setPercentCash] = useState('');
  const [percentBroker, setPercentBroker] = useState('');
  /** The teller's own shekel price per coin, each way of paying. Empty keeps the board's. */
  const [priceCash, setPriceCash] = useState('');
  const [priceBroker, setPriceBroker] = useState('');
  /** The rarely needed fields, folded away until asked for. */
  const [adjusting, setAdjusting] = useState(false);
  const [customerAsked, setCustomerAsked] = useState(false);
  /** The teller's own figure for what is paid in all. Empty keeps the computed one. */
  const [payoutEdit, setPayoutEdit] = useState('');
  const [destination, setDestination] = useState(transferChannels[0] ?? '');
  const [counterpartyPhone, setCounterpartyPhone] = useState('');
  const [payoutAccount, setPayoutAccount] = useState('');
  const [saveCustomer, setSaveCustomer] = useState(true);
  const [savedPayouts, setSavedPayouts] = useState<SavedPayout[]>([]);
  const [recording, setRecording] = useState(false);
  const [done, setDone] = useState<{ id: string; reference: string } | null>(null);
  const [recent, setRecent] = useState<RecentReceipt[]>([]);

  /*
   * The teller's last few USDT taken in, each with its receipt.
   *
   * The customer who sold us coins for a bank transfer leaves with a receipt
   * saying what will reach their account, where, and that it is still on its
   * way — and asks for it again when they lose it.
   */
  const loadRecent = useCallback(async () => {
    try {
      setRecent(
        await api.get<RecentReceipt[]>(
          `/api/manage/transactions${queryString({ recent: true, type: 'USDT_RECEIVE', pageSize: 5 })}`,
        ),
      );
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const print = (id: string) => window.open(`/print/receipt/${id}`, '_blank');

  const wallet = addresses.find((entry) => entry.id === walletId);

  const toMerge = (arrivals ?? []).filter((arrival) => merging.includes(arrival.id));
  const mergeToken = toMerge[0]?.wallet.tokenSymbol;

  /** The ticked transfers as one to settle, oldest first in what it says. */
  const openMerged = () => {
    const [first, ...rest] = toMerge;
    if (!first || rest.length === 0) return;
    const oldestFirst = [...toMerge].sort(
      (a, b) => new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime(),
    );
    const mixedSenders = new Set(toMerge.map((row) => row.fromAddress)).size > 1;
    open({
      ...first,
      amount: toMerge.reduce((sum, row) => sum + BigInt(row.amount), 0n).toString(),
      alsoIds: rest.map((row) => row.id),
      parts: oldestFirst.map((row) => String(Number(BigInt(row.amount)) / 1e8)),
      mixedSenders,
      mixedWallets: new Set(toMerge.map((row) => row.wallet.id)).size > 1,
      // Two senders: nobody's name is filled in for the teller.
      recognised: mixedSenders ? null : first.recognised,
    });
  };

  const shownArrivals =
    logWallet === 'ALL'
      ? arrivals
      : (arrivals ?? []).filter((arrival) => arrival.wallet.id === logWallet);

  /*
   * What the customer walks away with, worked out from the two prices the
   * server already sent rather than by asking again for every toggle.
   *
   * A split is priced per leg at that leg's own rate, which is what the server
   * will do again before it posts — so the figure shown here is the figure
   * recorded, and not an approximation of it.
   */
  const payout = (() => {
    if (!quote) return null;

    // USDT into dollars: worked out here as the percentage is typed, with the
    // same arithmetic the server uses before it posts.
    if (quote.percent) {
      const coins = BigInt(quote.amount);
      const share = mode === 'SPLIT' ? scaleCoins(brokerShare) : mode === 'BROKER' ? coins : 0n;
      if (share < 0n || share > coins || (mode === 'SPLIT' && (share === 0n || share === coins))) {
        return null;
      }
      const places = currencies.find((entry) => entry.code === payoutCurrency)?.decimals ?? 2;
      const leg = (part: bigint, typed: string) => {
        if (part === 0n) return 0n;
        if (!typed.trim()) return null;
        const percent = scaleCoins(typed);
        return validPercent(percent) ? payoutAtPercent(part, percent, places) : null;
      };
      const cash = leg(coins - share, percentCash);
      const broker = leg(share, percentBroker);
      return cash === null || broker === null ? null : cash + broker;
    }

    const coins = BigInt(quote.amount);
    const share = mode === 'SPLIT' ? scaleCoins(brokerShare) : mode === 'BROKER' ? coins : 0n;
    if (mode === 'SPLIT' && (share <= 0n || share >= coins)) return null;

    // Each part at its own price, as the server converts it: the teller's where
    // they typed one the limit allows, the board's otherwise.
    const places = currencies.find((entry) => entry.code === payoutCurrency)?.decimals ?? 2;
    const leg = (part: bigint, board: Priced['cash'], typed: string) => {
      if (part === 0n) return 0n;
      if (!board) return null;
      const rate = priceToUse(typed, BigInt(board.rate), quote.editLimit);
      return rate === null ? null : convert(part, rate, places);
    };
    const cash = leg(coins - share, quote.cash, priceCash);
    const broker = leg(share, quote.broker, priceBroker);
    return cash === null || broker === null ? null : cash + broker;
  })();

  /*
   * The figure that will be paid, recorded and written by the bot: the teller's
   * when they typed one. A typed figure belongs to the sum it was typed against,
   * so changing how the deal is paid clears it rather than leaving it standing.
   */
  useEffect(() => {
    setPayoutEdit('');
  }, [chosen, payoutCurrency, mode, brokerShare, percentCash, percentBroker, priceCash, priceBroker]);

  /** Whether this deal takes a teller's own price: shekels, with a board to start from. */
  const pricing = quote !== null && !quote.percent && tellerPriceAllowed(payoutCurrency);
  const payoutPlaces = currencies.find((entry) => entry.code === payoutCurrency)?.decimals ?? 2;
  const edited = payoutEdit.trim() ? scaleCoins(payoutEdit) : null;
  const editChanged = edited !== null && payout !== null && edited !== payout;
  const editTooFar =
    editChanged && !withinEditLimit(payout, edited, quote?.editLimit ?? 0);
  const editRefused = edited !== null && (edited <= 0n || editTooFar);
  const finalPayout = edited !== null && !editRefused ? edited : payout;

  // One read of the chain at a time. A slow provider would otherwise have the
  // timer stack a second request on the first, and a third on both.
  const inFlight = useRef(false);

  const load = useCallback(async (manual = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (manual) setRefreshing(true);
    try {
      setArrivals(await api.get<Arrival[]>('/api/usdt/arrivals'));
    } catch {
      // A log that shouts about a provider outage would shout all day.
      setArrivals((current) => current ?? []);
    } finally {
      inFlight.current = false;
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    /*
     * What is already stored first, so the log is on screen at once rather than
     * after the chain answers; the chain is asked straight after. Never left
     * behind it: a stored read that lands late must not overwrite a fresher one.
     */
    let asked = false;
    void api
      .get<Arrival[]>('/api/usdt/arrivals?sync=false')
      .then((stored) => {
        if (!asked) setArrivals((current) => current ?? stored);
      })
      .catch(() => {});
    void load().finally(() => {
      asked = true;
    });
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  /*
   * Opening an arrival, already filled in when the sender is known.
   *
   * A known address brings its customer and, if they were paid by transfer
   * last time, the channel and account — the teller checks and records. A
   * shared address brings nothing: it has sent for more than one person, and
   * filling it in would be a guess about whose money this is.
   */
  /*
   * "Not this customer." An exchange's wallet sends for everyone who withdraws
   * from it, so the first person seen on it would otherwise be filled in on
   * every later arrival. Marking it shared clears the form and stops that for
   * good, on every row from the same address at once.
   */
  const [marking, setMarking] = useState<string | null>(null);
  const notThisCustomer = async (arrival: Arrival) => {
    if (!arrival.fromAddress) return;
    setMarking(arrival.fromAddress);
    try {
      await api.post('/api/usdt/shared-addresses', {
        network: arrival.wallet.network,
        address: arrival.fromAddress,
      });
      const shared = { status: 'SHARED' as const, customers: 0, marked: true };
      setArrivals((current) =>
        (current ?? []).map((row) =>
          row.fromAddress === arrival.fromAddress && row.wallet.network === arrival.wallet.network
            ? { ...row, recognised: shared }
            : row,
        ),
      );
      setChosen((current) =>
        current && current.fromAddress === arrival.fromAddress
          ? { ...current, recognised: shared }
          : current,
      );
      setCustomer(null);
      setSavedPayouts([]);
      setMode('CASH');
      setPayoutAccount('');
      toast.success(t('receive.markedShared'));
    } catch (caught) {
      const failure = describeFailure(caught, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setMarking(null);
    }
  };

  const open = (arrival: Arrival) => {
    setDone(null);
    setAdjusting(false);
    setCustomerAsked(false);
    // The last deal's price must not read as this one's while its own is fetched.
    setQuote(null);

    // The currency this teller last paid in: most of a counter's day is one.
    try {
      const last = window.localStorage.getItem(LAST_CURRENCY_KEY);
      if (last && currencies.some((entry) => entry.code === last)) setPayoutCurrency(last);
    } catch {
      // Private window or blocked storage: the first currency is a fine default.
    }

    setCounterpartyName('');
    setCounterpartyPhone('');
    setSaveCustomer(true);
    setBrokerShare('');
    setSavedPayouts([]);

    const known = arrival.recognised?.status === 'KNOWN' ? arrival.recognised : null;
    setCustomer(
      known && !known.customer.isBlocked
        ? {
            id: known.customer.id,
            code: known.customer.code,
            fullNameEn: known.customer.fullNameEn,
            fullNameAr: known.customer.fullNameAr,
            phone: known.customer.phone,
          }
        : null,
    );

    const payout = known?.payout;
    if (payout && transferChannels.includes(payout.channel)) {
      setMode('BROKER');
      setDestination(payout.channel);
      setPayoutAccount(payout.account);
    } else {
      setMode('CASH');
      setDestination(transferChannels[0] ?? '');
      setPayoutAccount('');
    }

    setChosen(arrival);
  };

  // A chosen customer's saved accounts, offered under the account field.
  useEffect(() => {
    if (!customer) {
      setSavedPayouts([]);
      return;
    }
    let current = true;
    void api
      .get<{ payouts: SavedPayout[] }>(`/api/usdt/customers/${customer.id}/payouts`)
      .then(({ payouts }) => {
        if (!current) return;
        setSavedPayouts(payouts.filter((entry) => transferChannels.includes(entry.channel)));
      })
      .catch(() => {
        if (current) setSavedPayouts([]);
      });
    return () => {
      current = false;
    };
  }, [customer, transferChannels]);

  // Priced when a row is chosen, and again if the currency changes under it.
  useEffect(() => {
    if (!chosen) return;
    let current = true;
    setQuote(null);
    void api
      .get<Priced>(
        `/api/usdt/arrivals/${chosen.id}?payoutCurrency=${payoutCurrency}${
          chosen.alsoIds?.length ? `&also=${chosen.alsoIds.join(',')}` : ''
        }`,
      )
      .then((result) => {
        if (!current) return;
        setQuote(result);
        setPercentCash(result.percent?.cash ?? '');
        setPercentBroker(result.percent?.broker ?? '');
        setPriceCash('');
        setPriceBroker('');
      })
      .catch(() => {
        if (current) setQuote(null);
      });
    return () => {
      current = false;
    };
  }, [chosen, payoutCurrency]);

  // A remembered transfer with no broker price published today falls back to
  // cash, rather than leaving a payout of nothing and a button that stays grey.
  useEffect(() => {
    if (quote && !quote.broker && mode !== 'CASH') setMode('CASH');
  }, [quote, mode]);

  /*
   * What the server will refuse, refused here first: a transfer needs an
   * account to go to and, with no customer chosen, a name and a phone for the
   * person it is for.
   */
  const transferring = mode !== 'CASH';
  /*
   * The account a transfer goes to. Left empty, it is the customer's phone —
   * the number the field already shows greyed out, and for a wallet the very
   * number the money is sent to. Without this the teller saw a number in the
   * field and a button that would not press.
   */
  const accountToUse =
    payoutAccount.trim() || customer?.phone?.trim() || counterpartyPhone.trim();

  const missingForTransfer =
    transferring &&
    (!accountToUse ||
      (!customer && (!counterpartyName.trim() || !counterpartyPhone.trim())));

  // Open while there is anything typed in it: a price must never be hidden and still apply.
  const adjustOpen = adjusting || Boolean(priceCash || priceBroker || payoutEdit);
  const showCustomer = customerAsked || transferring || Boolean(customer);
  const ready = payout !== null && !missingForTransfer && !editRefused;

  /*
   * A deal with nothing left to ask is one key away: the teller looks, and presses
   * Enter. Once, when it becomes ready, so typing in a field is never interrupted.
   */
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!chosen) {
      focused.current = null;
      return;
    }
    if (!ready || focused.current === chosen.id) return;
    focused.current = chosen.id;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>('button[form=settle-arrival]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [chosen, ready]);

  const record = async () => {
    if (!chosen) return;
    setRecording(true);
    try {
      const created = await api.post<{ id: string; reference: string }>(
        `/api/usdt/arrivals/${chosen.id}`,
        {
          payoutCurrency,
          alsoArrivals: chosen.alsoIds ?? [],
          mode,
          /*
           * Only the broker's share of the coins travels. The till takes the
           * rest and the server prices both legs from its own board — sending
           * the totals would let a screen holding a stale price post figures
           * that were never quoted.
           */
          brokerShare: mode === 'SPLIT' ? brokerShare.trim() : undefined,
          // Only the percentage of a way of paying actually used.
          percentCash: quote?.percent && mode !== 'BROKER' ? percentCash.trim() : undefined,
          percentBroker: quote?.percent && mode !== 'CASH' ? percentBroker.trim() : undefined,
          payoutEdit: editChanged ? payoutEdit.trim() : undefined,
          // Only a price the teller typed, for a way of paying actually used.
          priceCash: pricing && mode !== 'BROKER' && priceCash.trim() ? priceCash.trim() : undefined,
          priceBroker: pricing && mode !== 'CASH' && priceBroker.trim() ? priceBroker.trim() : undefined,
          payoutChannel: mode === 'CASH' ? null : destination,
          payoutAccount: mode === 'CASH' ? null : accountToUse || null,
          customerId: customer?.id ?? null,
          counterpartyName: customer ? null : counterpartyName.trim() || null,
          counterpartyPhone: customer ? null : counterpartyPhone.trim() || null,
          saveCustomer: !customer && saveCustomer,
        },
      );
      toast.success(t('receive.recorded'), created.reference);
      printAfterRecording(created.id, permissions);
      setDone(created);
      try {
        window.localStorage.setItem(LAST_CURRENCY_KEY, payoutCurrency);
      } catch {
        // Only a convenience.
      }
      void loadRecent();
      setMerging([]);
      setChosen(null);
      setCustomer(null);
      setCounterpartyName('');
      setCounterpartyPhone('');
      setPayoutAccount('');
      await load();
      router.refresh();
    } catch (caught) {
      const failure = describeFailure(caught, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setRecording(false);
    }
  };

  if (addresses.length === 0) return null;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ============ The address, shown before anything is asked ========= */}
        <Card>
          <CardHeader title={t('receive.addressTitle')} description={t('receive.addressBody')} />
          <CardBody className="space-y-4">
            <Field label={t('counter.address')} required>
              {(props) => (
                <Select
                  {...props}
                  value={walletId}
                  onChange={(event) => setWalletId(event.target.value)}
                  options={addresses.map((entry) => ({
                    value: entry.id,
                    label: `${ln(entry, 'label')} — ${networkLabel(entry.network)}`,
                  }))}
                />
              )}
            </Field>

            {wallet && !wallet.drawerId && (
              <Alert tone="warning">{t('counter.walletNotLinked')}</Alert>
            )}

            {wallet && (
              <>
                {/* Getting the network wrong destroys the money with no
                    recourse from anyone. It is the loudest thing here. */}
                <div className="rounded-[var(--radius-control)] border-2 border-warning bg-warning-subtle p-3 text-center">
                  <p className="text-xs font-medium uppercase tracking-wide text-content-secondary">
                    {t('counter.networkWarningLabel')}
                  </p>
                  <p className="mt-1 text-2xl font-bold text-content ltr-content">
                    {networkLabel(wallet.network)}
                  </p>
                  <p className="mt-1 text-xs text-content-secondary">
                    {t('counter.networkWarningBody')}
                  </p>
                </div>

                <div className="flex justify-center">
                  <QrCode value={wallet.address} size={220} title={wallet.address} />
                </div>

                <AddressBlock
                  address={wallet.address}
                  network={wallet.network}
                  companyName={companyName}
                  onCopy={() => toast.success(t('common.copied'))}
                />
              </>
            )}
          </CardBody>
        </Card>

        {/* ============ The log of what actually landed ===================== */}
        <Card>
          <CardHeader
            title={t('receive.logTitle')}
            description={t('receive.logBody')}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {permissions.includes('exchange.receipt.print') && (
                  <PendingTransfersButton variant="ghost" kind="usdt" />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  onClick={() => void load(true)}
                >
                  {t('common.refresh')}
                </Button>
              </div>
            }
          />
          <CardBody className="space-y-3">
            {done && (
              <Alert tone="success" icon={<Check />} title={t('receive.recorded')}>
                {/*
                  The message is one tap from the moment it is recorded —
                  sending it is the next thing the teller does, every time.
                */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono ltr-content">{done.reference}</span>
                  {permissions.includes('exchange.receipt.print') && (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Printer />}
                        onClick={() => print(done.id)}
                      >
                        {t('transactions.printReceipt')}
                      </Button>
                      <AutoPrintToggle />
                      <ShareButton transactionId={done.id} variant="secondary" />
                    </>
                  )}
                </div>
              </Alert>
            )}

            {/*
              One tab per address, each with what is waiting on it, so a teller
              whose customer used a particular address can look only there.
            */}
            {addresses.length > 1 && (
              <div role="tablist" className="flex flex-wrap gap-1.5">
                {[
                  { id: 'ALL', label: t('common.all'), count: arrivals?.length ?? 0 },
                  ...addresses.map((entry) => ({
                    id: entry.id,
                    label: `${ln(entry, 'label')} · ${networkLabel(entry.network)}`,
                    count: (arrivals ?? []).filter((arrival) => arrival.wallet.id === entry.id)
                      .length,
                  })),
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={logWallet === tab.id}
                    onClick={() => setLogWallet(tab.id)}
                    className={cn(
                      'inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors',
                      logWallet === tab.id
                        ? 'bg-primary text-content-inverse'
                        : 'bg-surface-sunken text-content-secondary hover:text-content',
                    )}
                  >
                    <span>{tab.label}</span>
                    <span
                      className={cn(
                        'tabular-nums',
                        logWallet === tab.id ? 'opacity-80' : 'text-content-tertiary',
                      )}
                    >
                      {tab.count}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {toMerge.length >= 2 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-primary-subtle px-3 py-2">
                <span className="text-sm font-semibold text-content">
                  {t('receive.mergeSummary', { count: toMerge.length })}{' '}
                  <Money
                    value={toMerge.reduce((sum, row) => sum + BigInt(row.amount), 0n).toString()}
                    currency={toMerge[0]!.wallet.tokenSymbol}
                  />
                </span>
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setMerging([])}>
                    {t('common.cancel')}
                  </Button>
                  <Button size="sm" onClick={openMerged}>
                    {t('receive.mergeAction')}
                  </Button>
                </span>
              </div>
            )}

            {arrivals === null ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-content-tertiary" />
              </div>
            ) : shownArrivals?.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <Inbox className="size-8 text-content-tertiary" />
                <p className="text-sm text-content-secondary">{t('receive.logEmpty')}</p>
              </div>
            ) : (
              <ul className="divide-border-subtle divide-y">
                {shownArrivals?.map((arrival) => (
                  <li key={arrival.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-lg font-bold text-content tabular-nums">
                        <Money value={arrival.amount} currency={arrival.wallet.tokenSymbol} />
                      </span>
                      {/*
                        When, in the form the teller actually needs: "four
                        minutes ago" answers "is this the man in front of me",
                        and a date does not.
                      */}
                      <span className="text-sm font-medium text-content-secondary">
                        <DateText value={arrival.firstSeenAt} relative />
                      </span>
                      <span className="text-xs text-content-tertiary">
                        <DateText value={arrival.firstSeenAt} withTime />
                      </span>
                      {!arrival.ready && (
                        <Badge tone="warning">
                          {t('arrivals.confirming', {
                            confirmations: arrival.confirmations,
                            required: arrival.required,
                          })}
                        </Badge>
                      )}
                    </div>

                    {arrival.fromAddress && (
                      <p className="text-xs text-content-tertiary">
                        {t('receive.from')}{' '}
                        <span className="font-mono ltr-content">{arrival.fromAddress}</span>
                      </p>
                    )}

                    {/* Who it is, before the row is even opened. */}
                    {arrival.recognised?.status === 'KNOWN' && (
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone="success">
                          <UserCheck className="me-1 inline size-3.5" />
                          {ln(arrival.recognised.customer, 'fullName')}
                          {arrival.recognised.payout ? ` · ${arrival.recognised.payout.channel}` : ''}
                        </Badge>
                        <button
                          type="button"
                          onClick={() => void notThisCustomer(arrival)}
                          disabled={marking === arrival.fromAddress}
                          className="text-xs font-medium text-danger-text underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          {t('receive.notThisCustomer')}
                        </button>
                      </span>
                    )}
                    {arrival.recognised?.status === 'SHARED' && (
                      <Badge tone="warning">{t('receive.sharedBadge')}</Badge>
                    )}

                    <p className="break-all font-mono text-[11px] text-content-tertiary ltr-content">
                      {arrival.txHash}
                    </p>

                    <div className="flex flex-wrap items-center gap-2">
                      {/*
                        The public record, one press away. Neither the office nor
                        the customer owns TronScan, which is exactly why it
                        settles the argument.
                      */}
                      {/* A Binance Pay transfer has no public record to open. */}
                      {arrival.explorerUrl && (
                        <a
                          href={arrival.explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border-base px-3 text-sm text-content-secondary transition-colors hover:border-primary hover:text-primary-text"
                        >
                          <ExternalLink className="size-4" />
                          {t('receive.openExplorer')}
                        </a>
                      )}

                      {arrival.ready && (!mergeToken || mergeToken === arrival.wallet.tokenSymbol) && (
                        <label className="ms-auto inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm text-content-secondary">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--primary)]"
                            checked={merging.includes(arrival.id)}
                            onChange={(event) =>
                              setMerging((current) =>
                                event.target.checked
                                  ? [...current, arrival.id]
                                  : current.filter((id) => id !== arrival.id),
                              )
                            }
                          />
                          {t('receive.mergeTick')}
                        </label>
                      )}

                      {arrival.ready && (
                        <Button size="sm" onClick={() => open(arrival)}>
                          {t('receive.record')}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* ============ The teller's recent receipts, for a reprint ========== */}
        {recent.length > 0 && (
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <History className="size-4 text-primary-text" />
                  {t('receive.recent')}
                </span>
              }
            />
            <CardBody className="p-0">
              <ul className="divide-y divide-border-subtle">
                {recent.map((row) => {
                  const gone = row.status === 'REVERSED';
                  return (
                    <li
                      key={row.id}
                      className={cn(
                        'flex items-center justify-between gap-3 px-4 py-2.5',
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
                          <Money value={row.fromAmount} currency={row.fromCurrency} />
                          <span className="text-content-tertiary">→</span>
                          <Money value={row.toAmount} currency={row.toCurrency} />
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-content-tertiary">
                          <DateText value={row.createdAt} withTime />
                          <span className="font-mono ltr-content">{row.reference}</span>
                          {row.status === 'PENDING_TRANSFER' && (
                            <span className="rounded bg-warning-subtle px-1.5 py-px font-medium text-warning-text">
                              {t('machine.pendingTransfer')}
                            </span>
                          )}
                          {gone && (
                            <span className="rounded bg-danger-subtle px-1.5 py-px font-medium text-danger-text">
                              {t('machine.deletedBadge')}
                            </span>
                          )}
                        </p>
                      </div>
                      {permissions.includes('exchange.receipt.print') && (
                        <span className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => print(row.id)}
                            title={t('transactions.printReceipt')}
                            aria-label={t('transactions.printReceipt')}
                            className="flex size-10 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content sm:size-8"
                          >
                            <Printer className="size-4" />
                          </button>
                          <ShareButton transactionId={row.id} compact />
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </CardBody>
          </Card>
        )}
      </div>

      {/* ============ Recording the one the teller picked ================== */}
      <Dialog
        open={chosen !== null}
        onClose={() => setChosen(null)}
        title={t('receive.recordTitle')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setChosen(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              form="settle-arrival"
              loading={recording}
              disabled={!ready}
            >
              {t('receive.record')}
              {finalPayout !== null && (
                <span className="ms-2 font-bold tabular-nums ltr-content">
                  {toPlainAmount(finalPayout, payoutPlaces)} {payoutCurrency}
                </span>
              )}
            </Button>
          </>
        }
      >
        {chosen && (
          /*
           * A form, so Enter records: for a known sender the teller's whole job
           * is to look, and press Enter.
           */
          <form
            id="settle-arrival"
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready && !recording) void record();
            }}
          >
            {chosen.parts && (
              <Alert tone={chosen.mixedSenders || chosen.mixedWallets ? 'warning' : 'primary'}>
                <p className="font-medium">
                  {t('receive.mergedParts', {
                    parts: chosen.parts.join(' + '),
                  })}
                </p>
                {chosen.mixedWallets && <p className="mt-1">{t('receive.mergedWallets')}</p>}
                {chosen.mixedSenders && <p className="mt-1">{t('receive.mergedSenders')}</p>}
              </Alert>
            )}

            {chosen.recognised?.status === 'KNOWN' && (
              <Alert tone="success" icon={<UserCheck />}>
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {t('receive.known', {
                      name: ln(chosen.recognised.customer, 'fullName'),
                      count: chosen.recognised.timesSeen,
                    })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    loading={marking === chosen.fromAddress}
                    onClick={() => void notThisCustomer(chosen)}
                  >
                    {t('receive.notThisCustomer')}
                  </Button>
                </span>
              </Alert>
            )}
            {chosen.recognised?.status === 'SHARED' && (
              <Alert tone="warning">
                {chosen.recognised.marked
                  ? t('receive.sharedMarked')
                  : t('receive.shared', { count: chosen.recognised.customers })}
              </Alert>
            )}

            <div className="flex items-center justify-between rounded-xl bg-surface-sunken px-3 py-2">
              <span className="text-sm text-content-secondary">{t('arrivals.arrived')}</span>
              <span className="font-semibold tabular-nums">
                <Money value={chosen.amount} currency={chosen.wallet.tokenSymbol} />
              </span>
            </div>

            <Field label={t('counter.payoutCurrency')} required>
              {(props) => (
                <Select
                  {...props}
                  value={payoutCurrency}
                  onChange={(event) => setPayoutCurrency(event.target.value)}
                  options={currencies.map((currency) => ({
                    value: currency.code,
                    label: `${ln(currency, 'name')} (${currency.code})`,
                  }))}
                />
              )}
            </Field>

            {/*
              How it is handed over — and therefore which balance it leaves.

              The same three segments as the exchange machine, in the same
              order, so a teller who has learned the control on one screen has
              learned it on both. A bank payout is not the till's money under a
              different name: the broker holds it and charges his own price for
              moving it, which is why each segment carries its own figure.
            */}
            <div className="rounded-xl bg-surface p-2 ring-1 ring-border-subtle">
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
                        setMode(option);
                        if (option !== 'SPLIT') setBrokerShare('');
                      }}
                      aria-pressed={mode === option}
                      disabled={
                        (option === 'BROKER' && !quote?.broker) ||
                        (option === 'SPLIT' && (!quote?.cash || !quote?.broker))
                      }
                      className={cn(
                        'h-8 rounded-full px-3 text-sm font-medium transition-colors',
                        'disabled:opacity-40',
                        mode === option
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
                Where the transfer is instructed to. Only asked when something
                is actually being transferred — and the server refuses a
                transfer without it, so this is the convenient way to answer,
                not the only one trusted.
              */}
              {mode !== 'CASH' && transferChannels.length > 0 && (
                <label className="mt-2 block">
                  <span className="text-xs text-content-tertiary">{t('machine.transferTo')}</span>
                  <select
                    value={destination}
                    onChange={(event) => setDestination(event.target.value)}
                    className="mt-1 h-11 w-full rounded-[var(--radius-control)] bg-surface-sunken px-3 text-sm font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary"
                  >
                    {transferChannels.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {/*
                The account on that channel — without it, "send through PalPay"
                is an instruction nobody can carry out. A customer's earlier
                accounts are one tap away, and a phone given above is offered as
                the likeliest wallet number.
              */}
              {transferring && (
                <div className="mt-2">
                  <label className="block">
                    <span className="text-xs text-content-tertiary">{t('receive.account')}</span>
                    <input
                      type="text"
                      dir="ltr"
                      inputMode="text"
                      autoComplete="off"
                      value={payoutAccount}
                      onChange={(event) => setPayoutAccount(event.target.value)}
                      placeholder={customer?.phone ?? (counterpartyPhone || undefined)}
                      required
                      className="mt-1 h-11 w-full rounded-[var(--radius-control)] bg-surface-sunken px-3 font-mono text-sm font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary"
                    />
                  </label>
                  <p className="mt-1 text-xs text-content-tertiary">{t('receive.accountHint')}</p>

                  {savedPayouts.length > 0 && (
                    <div className="mt-2">
                      <p className="mb-1 text-xs text-content-tertiary">
                        {t('receive.savedPayouts')}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {savedPayouts.map((saved) => {
                          const active =
                            saved.channel === destination && saved.account === payoutAccount.trim();
                          return (
                            <button
                              key={saved.id}
                              type="button"
                              onClick={() => {
                                setDestination(saved.channel);
                                setPayoutAccount(saved.account);
                              }}
                              className={cn(
                                'rounded-full px-3 py-1 text-xs transition-colors',
                                active
                                  ? 'bg-primary text-content-inverse'
                                  : 'bg-surface-sunken text-content-secondary hover:text-content',
                              )}
                            >
                              {saved.channel} ·{' '}
                              <span className="font-mono ltr-content">{saved.account}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/*
                A split divides the coins, not the cash: the two channels price
                differently, so what the customer takes away is not known until
                both parts have been priced and cannot be the thing divided.
              */}
              {mode === 'SPLIT' && (
                <label className="mt-2 block">
                  <span className="text-xs text-content-tertiary">
                    {t('receive.brokerShare', { token: chosen.wallet.tokenSymbol })}
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    dir="ltr"
                    value={brokerShare}
                    onChange={(event) => setBrokerShare(event.target.value.replace(/[^\d.]/g, ''))}
                    className="mt-1 h-11 w-full rounded-[var(--radius-control)] bg-surface-sunken px-3 text-sm font-medium tabular-nums text-content outline-none ring-1 ring-transparent focus:ring-primary"
                  />
                </label>
              )}
            </div>

            {/*
              The office's cut on dollars, each way of paying with its own. Filled
              in from the manager's settings; the teller changes it when the deal
              with this customer is different.
            */}
            {quote?.percent && (
              <div className="grid gap-3 sm:grid-cols-2">
                {mode !== 'BROKER' && (adjustOpen || !percentCash.trim()) && (
                  <label className="block">
                    <span className="text-xs text-content-tertiary">{t('receive.percentCash')}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      dir="ltr"
                      autoComplete="off"
                      value={percentCash}
                      onChange={(event) => setPercentCash(cleanPercent(event.target.value))}
                      required
                      className="mt-1 h-11 w-full rounded-[var(--radius-control)] bg-surface-sunken px-3 text-sm font-medium tabular-nums text-content outline-none ring-1 ring-transparent focus:ring-primary"
                    />
                  </label>
                )}
                {mode !== 'CASH' && (adjustOpen || !percentBroker.trim()) && (
                  <label className="block">
                    <span className="text-xs text-content-tertiary">
                      {t('receive.percentBroker')}
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      dir="ltr"
                      autoComplete="off"
                      value={percentBroker}
                      onChange={(event) => setPercentBroker(cleanPercent(event.target.value))}
                      required
                      className="mt-1 h-11 w-full rounded-[var(--radius-control)] bg-surface-sunken px-3 text-sm font-medium tabular-nums text-content outline-none ring-1 ring-transparent focus:ring-primary"
                    />
                  </label>
                )}
              </div>
            )}

            {/*
              The teller's own price for this customer, in place of the board's,
              which shows faintly in the field. Left empty, the board stands.
            */}
            {pricing && quote && adjustOpen && (
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ['CASH', 'receive.priceCash', priceCash, setPriceCash, quote.cash],
                    ['BROKER', 'receive.priceBroker', priceBroker, setPriceBroker, quote.broker],
                  ] as const
                )
                  .filter(([way]) => mode === 'SPLIT' || mode === way)
                  .map(([way, label, value, change, board]) => (
                    <label key={way} className="block">
                      <span className="text-xs text-content-tertiary">{t(label)}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        dir="ltr"
                        autoComplete="off"
                        value={value}
                        placeholder={board ? toPlainAmount(BigInt(board.rate), 4) : undefined}
                        onChange={(event) => change(cleanAmount(event.target.value, 4))}
                        className="mt-1 h-11 w-full rounded-[var(--radius-control)] bg-surface-sunken px-3 text-sm font-medium tabular-nums text-content outline-none ring-1 ring-transparent focus:ring-primary"
                      />
                      {board && value.trim() && (
                        <span
                          className={cn(
                            'mt-1 block text-xs',
                            priceToUse(value, BigInt(board.rate), quote.editLimit) === null
                              ? 'text-danger-text'
                              : 'text-warning-text',
                          )}
                        >
                          {priceToUse(value, BigInt(board.rate), quote.editLimit) === null
                            ? t('errors.tellerPriceTooFar', { limit: String(quote.editLimit) })
                            : t('receive.priceEdited', {
                                board: toPlainAmount(BigInt(board.rate), 4),
                              })}
                        </span>
                      )}
                    </label>
                  ))}
              </div>
            )}

            <div className="flex items-center justify-between rounded-xl bg-primary-subtle px-3 py-2">
              <span className="text-sm text-content-secondary">{t('arrivals.payout')}</span>
              {finalPayout === null ? (
                quote ? (
                  <span className="text-lg font-bold text-content-tertiary">—</span>
                ) : (
                  <Loader2 className="size-4 animate-spin text-content-tertiary" />
                )
              ) : (
                <span className="text-lg font-bold tabular-nums">
                  <Money value={finalPayout.toString()} currency={payoutCurrency} />
                </span>
              )}
            </div>

            {/*
              The figure the bot will write, and the one the office pays: the
              books follow it. Offered once there is a computed figure to change.
            */}
            {payout !== null && !adjustOpen && (
              <button
                type="button"
                onClick={() => setAdjusting(true)}
                className="text-sm text-primary-text hover:underline"
              >
                {t('receive.adjust')}
              </button>
            )}
            {payout !== null && adjustOpen && (
              <label className="block">
                <span className="text-xs text-content-tertiary">
                  {t('receive.payoutEdit', { currency: payoutCurrency })}
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  dir="ltr"
                  autoComplete="off"
                  value={payoutEdit}
                  placeholder={toPlainAmount(payout, payoutPlaces)}
                  onChange={(event) =>
                    setPayoutEdit(cleanAmount(event.target.value, payoutPlaces))
                  }
                  className="mt-1 h-11 w-full rounded-[var(--radius-control)] bg-surface-sunken px-3 text-sm font-medium tabular-nums text-content outline-none ring-1 ring-transparent focus:ring-primary"
                />
                {editRefused ? (
                  <span className="mt-1 block text-xs text-danger-text">
                    {editTooFar
                      ? t('errors.payoutEditTooFar', { limit: String(quote?.editLimit ?? 0) })
                      : t('errors.payoutEditInvalid')}
                  </span>
                ) : editChanged ? (
                  <span className="mt-1 block text-xs text-warning-text">
                    {t('receive.payoutEdited', {
                      computed: `${toPlainAmount(payout, payoutPlaces)} ${payoutCurrency}`,
                    })}
                  </span>
                ) : null}
              </label>
            )}

            {/*
              Enter inside the search is a search, not a settlement. Without
              this, typing half a name and pressing Enter would record the
              transfer for nobody.
            */}
            {!showCustomer && (
              <button
                type="button"
                onClick={() => setCustomerAsked(true)}
                className="block text-sm text-primary-text hover:underline"
              >
                {t('receive.addCustomer')}
              </button>
            )}
            {showCustomer && (
              <div
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.preventDefault();
                }}
              >
                <CustomerPicker value={customer} onChange={setCustomer} permissions={permissions} />
              </div>
            )}

            {showCustomer && !customer && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('transactions.counterpartyName')} required={transferring}>
                    {(props) => (
                      <Input
                        {...props}
                        value={counterpartyName}
                        onChange={(event) => setCounterpartyName(event.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={t('receive.phone')} required={transferring}>
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
                </div>

                {/*
                  On by default: a walk-in who sends once usually sends again,
                  and saving him is what makes the second visit a single Enter.
                  Only offered with both a name and a phone — the phone is how a
                  second record for the same person is avoided.
                */}
                {counterpartyName.trim() && counterpartyPhone.trim() && (
                  <label className="flex cursor-pointer items-start gap-2 text-sm text-content-secondary">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                      checked={saveCustomer}
                      onChange={(event) => setSaveCustomer(event.target.checked)}
                    />
                    {t('receive.saveCustomer')}
                  </label>
                )}
              </>
            )}
          </form>
        )}
      </Dialog>
    </>
  );
}

/**
 * The address, split so a human can actually verify it against a phone — and
 * two ways to get it into theirs.
 *
 * ## Why sending it matters more than copying it
 *
 * Copying works when the customer is holding the same device. They are not:
 * they are looking at this screen and typing into their own phone, and a
 * thirty-four character address typed by hand is the single easiest way to lose
 * the money — one wrong character and it goes somewhere nobody can reach.
 *
 * The QR solves that for a customer whose wallet can scan. WhatsApp solves it
 * for everybody else, and for the customer who is not in the room at all. The
 * message carries the network warning with the address, because an address on
 * its own in a chat window is exactly the thing that gets pasted into the wrong
 * chain three days later.
 */
export function AddressBlock({
  address,
  network,
  companyName,
  onCopy,
}: {
  address: string;
  network?: string;
  companyName?: string;
  onCopy: () => void;
}) {
  const { t } = useLocale();
  const head = address.slice(0, 6);
  const tail = address.slice(-6);
  const middle = address.slice(6, -6);

  const message = [
    companyName,
    '',
    t('receive.shareHeading', { network: network ?? '' }),
    address,
    '',
    t('receive.shareWarning', { network: network ?? '' }),
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  return (
    <div className="rounded-[var(--radius-control)] border border-border-base bg-surface p-3">
      <p className="break-all text-center font-mono text-sm ltr-content">
        <span className="text-base font-bold text-content">{head}</span>
        <span className="text-content-tertiary">{middle}</span>
        <span className="text-base font-bold text-content">{tail}</span>
      </p>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(address);
          onCopy();
        }}
        className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border-base text-sm text-content-secondary transition-colors hover:border-primary hover:text-primary-text"
      >
        <Copy className="h-4 w-4" />
        {t('counter.copyAddress', { length: String(address.length) })}
      </button>

      {network && (
        <a
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border-base text-sm text-content-secondary transition-colors hover:border-success hover:text-success-text"
        >
          <MessageCircle className="h-4 w-4" />
          {t('receive.shareAddress')}
        </a>
      )}
    </div>
  );
}

/** A typed USDT figure at the scale the rest of the system speaks. */
/**
 * The price a leg goes at: the board's when nothing is typed, the teller's when
 * it is within the limit, null when what they typed cannot be used.
 */
function priceToUse(typed: string, board: bigint, limit: number): bigint | null {
  if (!typed.trim()) return board;
  const price = scaleCoins(typed);
  return price > 0n && withinEditLimit(board, price, limit) ? price : null;
}

/** What an amount can be as it is typed: digits and one point, Arabic digits included. */
function cleanAmount(raw: string, places: number): string {
  const cleaned = normalizeDigits(raw)
    .replace(/[,٫]/g, '.')
    .replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = cleaned.split('.');
  return rest.length > 0 && places > 0 ? `${whole}.${rest.join('').slice(0, places)}` : whole;
}

const cleanPercent = (raw: string) => cleanAmount(raw, 4);

/** A scaled amount as plain digits, for a field: 985.5, or 985 when whole. */
function toPlainAmount(scaled: bigint, places: number): string {
  const digits = scaled.toString().padStart(9, '0');
  const fraction = digits.slice(-8).slice(0, places).replace(/0+$/, '');
  return `${digits.slice(0, -8)}${fraction ? `.${fraction}` : ''}`;
}

function scaleCoins(value: string): bigint {
  const [whole = '0', fraction = ''] = value.trim().split('.');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return 0n;
  return BigInt(whole || '0') * 100000000n + BigInt((fraction + '00000000').slice(0, 8));
}

interface RecentReceipt {
  id: string;
  reference: string;
  status: string;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  createdAt: string;
}
