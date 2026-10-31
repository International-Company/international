import 'server-only';
import { prisma } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import { dayBounds, formatDayKey } from '@/core/time/day-key';
import { cashLedger } from '@/modules/exchange/cash-ledger.service';
import { dailyCount } from '@/modules/exchange/daily-count.service';
import * as settings from '@/modules/settings/settings.service';
import {
  composeAmbiguous,
  composeHelp,
  composeReport,
  matchTellers,
  parseCommand,
  senderAllowed,
  type TellerCandidate,
  type TellerDay,
} from './report-command';
import { reportImage } from './report-image';
import {
  memberPhone,
  onIncomingText,
  sendImage,
  sendText,
  type IncomingText,
} from './whatsapp.service';

/**
 * «#جرد أحمد» in the office's group, answered with Ahmad's day so far.
 *
 * Three locks before anything is read: the message is in the office's own
 * group, its sender's number is one the manager listed, and it starts with the
 * code the manager chose. Anyone else typing the code is ignored without a
 * word — an answer of any kind would tell them the code works.
 */

const log = createLogger('whatsapp:report');

export interface ReportDeps {
  config: () => Promise<{ group: string; code: string; numbers: string }>;
  /** The sender's phone, however WhatsApp addressed them. */
  phoneOf: (incoming: IncomingText) => Promise<string | null>;
  tellers: () => Promise<TellerCandidate[]>;
  /** Who recorded something today, by name — for the help line. */
  workedToday: () => Promise<string[]>;
  dayOf: (teller: TellerCandidate) => Promise<TellerDay>;
  reply: (incoming: IncomingText, text: string) => Promise<void>;
  /** The report as a picture; when it cannot be drawn or sent, the text goes instead. */
  replyImage: (incoming: IncomingText, day: TellerDay, caption: string) => Promise<void>;
}

export type ReportOutcome =
  | 'IGNORED'
  | 'REFUSED'
  | 'HELP'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'FAILED'
  | 'REPORTED'
  | 'REPORTED_AS_TEXT';

export async function handleReportCommand(
  incoming: IncomingText,
  deps: ReportDeps,
): Promise<ReportOutcome> {
  const { group, code, numbers } = await deps.config();
  if (!group || incoming.chat !== group) return 'IGNORED';

  const query = parseCommand(incoming.text, code);
  if (query === null) return 'IGNORED';

  const phone = await deps.phoneOf(incoming);
  if (!senderAllowed(phone, numbers)) {
    log.warn('A report was asked for by a number not on the list', {
      sender: phone ? `…${phone.replace(/\D/g, '').slice(-4)}` : 'unknown',
    });
    return 'REFUSED';
  }

  if (!query) {
    await deps.reply(incoming, composeHelp(code, await deps.workedToday()));
    return 'HELP';
  }

  const found = matchTellers(query, await deps.tellers());
  if (found.length === 0) {
    await deps.reply(incoming, composeHelp(code, await deps.workedToday(), query));
    return 'NOT_FOUND';
  }
  if (found.length > 1) {
    await deps.reply(
      incoming,
      composeAmbiguous(
        query,
        found.map((user) => user.fullNameAr),
      ),
    );
    return 'AMBIGUOUS';
  }

  let day: TellerDay;
  try {
    day = await deps.dayOf(found[0]!);
  } catch (error) {
    // Said, so the manager is not left waiting on an answer that is not coming.
    log.error('Could not read a teller’s day for the group', { error });
    await deps.reply(incoming, 'تعذّرت قراءة الجرد الآن، حاول بعد قليل.');
    return 'FAILED';
  }

  /*
   * A picture, which reads at a glance as a table does. Should it fail —
   * drawing or uploading — the same figures go as text, so the manager always
   * gets an answer.
   */
  try {
    await deps.replyImage(incoming, day, `جرد ${day.teller} — ${day.day} حتى ${day.asOf}`);
    return 'REPORTED';
  } catch (error) {
    log.warn('Could not send the report as a picture; sending it as text', { error });
  }
  await deps.reply(incoming, composeReport(day));
  return 'REPORTED_AS_TEXT';
}

/** A teller's day so far, read the way their own daily count and cash pages read it. */
export async function tellerDay(teller: TellerCandidate): Promise<TellerDay> {
  const now = new Date();
  const { start, end } = dayBounds(now);
  const day = formatDayKey(start);
  // Read as the teller reads their own pages: these services answer for "me".
  const as = { id: teller.id, name: teller.fullNameEn, permissions: ['exchange.transaction.view'] };

  const [ledger, count] = await Promise.all([
    cashLedger({ from: start, to: end, day }, as),
    dailyCount({ from: start, to: end }, as),
  ]);

  /*
   * In and out from the deals that stand. A deleted deal and its reversal
   * cancel to nothing in the box, so counting either would only inflate both
   * columns; the closing figure is the box itself.
   */
  const flows = new Map<string, { in: bigint; out: bigint }>();
  for (const entry of ledger.entries) {
    if (entry.reversal || entry.reversed) continue;
    for (const [side, amounts] of [
      ['in', entry.cashIn],
      ['out', entry.cashOut],
    ] as const) {
      for (const { currency, amount } of amounts) {
        const row = flows.get(currency) ?? { in: 0n, out: 0n };
        row[side] += amount;
        flows.set(currency, row);
      }
    }
  }

  return {
    teller: teller.fullNameAr,
    day,
    asOf: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    openingSet: ledger.openingSet,
    cash: ledger.closing.map((closing) => ({
      currency: closing.currency,
      opening: ledger.opening.find((row) => row.currency === closing.currency)?.amount ?? 0n,
      in: flows.get(closing.currency)?.in ?? 0n,
      out: flows.get(closing.currency)?.out ?? 0n,
      closing: closing.amount,
    })),
    groups: count.groups.map((group) => ({
      kind: group.kind,
      count: group.count,
      received: group.received,
      paid: group.paid,
    })),
  };
}

let registered = false;

/** Listens for the code in the office's group. Once per process. */
export function registerReportCommand(): void {
  if (registered) return;
  registered = true;

  onIncomingText(async (incoming) => {
    await handleReportCommand(incoming, {
      config: async () => ({
        group: (await settings.getString('whatsapp.groupId')).trim(),
        code: (await settings.getString('whatsapp.reportCode')).trim(),
        numbers: await settings.getString('whatsapp.reportNumbers'),
      }),
      phoneOf: async (message) =>
        message.senderPhone ??
        (message.sender ? await memberPhone(message.chat, message.sender).catch(() => null) : null),
      tellers: () =>
        prisma.user.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, username: true, fullNameAr: true, fullNameEn: true },
        }),
      workedToday: async () => {
        const { start, end } = dayBounds(new Date());
        const rows = await prisma.transaction.findMany({
          where: { createdAt: { gte: start, lte: end } },
          distinct: ['createdById'],
          select: { createdBy: { select: { fullNameAr: true } } },
        });
        return rows
          .map((row) => row.createdBy?.fullNameAr)
          .filter((name): name is string => !!name);
      },
      dayOf: tellerDay,
      reply: async (message, text) => {
        await sendText(message.chat, text, message.message);
      },
      replyImage: async (message, day, caption) => {
        const office = (await settings.getString('company.name.ar')).trim();
        await sendImage(message.chat, reportImage(day, office), caption, message.message);
      },
    });
  });
}
