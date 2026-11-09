import 'server-only';
import { prisma } from '@/core/db/prisma';
import { formatDayKey } from '@/core/time/day-key';

/**
 * What the assistant has cost, counted by day: the panel shows it, so the bill
 * is not first noticed when the credit runs out.
 *
 * The credit itself cannot be read through the API. What can be known is the
 * moment it is refused, which is kept here for the panel to say so.
 */

/** Dollars per million tokens, for Claude Opus 5.5. An estimate: the bill is the truth. */
const INPUT_PER_MILLION = 4;
const OUTPUT_PER_MILLION = 20;

export const estimatedCost = (input: number, output: number) =>
  (input * INPUT_PER_MILLION + output * OUTPUT_PER_MILLION) / 1_000_000;

type Tokens = { input_tokens: number; output_tokens: number };

export async function recordUsage(kind: 'answer' | 'photo', usage: Tokens): Promise<void> {
  const day = formatDayKey(new Date());
  const counts = {
    answers: kind === 'answer' ? 1 : 0,
    photos: kind === 'photo' ? 1 : 0,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
  await prisma.botUsageDay.upsert({
    where: { day },
    create: { day, ...counts },
    update: {
      answers: { increment: counts.answers },
      photos: { increment: counts.photos },
      inputTokens: { increment: counts.inputTokens },
      outputTokens: { increment: counts.outputTokens },
    },
  });
}

export async function usageSummary() {
  const since = new Date();
  since.setDate(since.getDate() - 29);
  const rows = await prisma.botUsageDay.findMany({ where: { day: { gte: formatDayKey(since) } } });
  const today = formatDayKey(new Date());
  const sum = (picked: typeof rows) => ({
    answers: picked.reduce((total, row) => total + row.answers, 0),
    photos: picked.reduce((total, row) => total + row.photos, 0),
    cost: estimatedCost(
      picked.reduce((total, row) => total + row.inputTokens, 0),
      picked.reduce((total, row) => total + row.outputTokens, 0),
    ),
  });
  return { today: sum(rows.filter((row) => row.day === today)), month: sum(rows) };
}

// Across the app's bundles, which each get their own copy of a module's variables.
const credit = globalThis as unknown as { __ifmsBotCreditOutAt?: number | null };

export const creditOutAt = () => credit.__ifmsBotCreditOutAt ?? null;
export const creditIsBack = () => {
  credit.__ifmsBotCreditOutAt = null;
};

/** Whether this failure is the account being out of credit; noted if so. */
export function noteIfCreditOut(error: unknown): boolean {
  // The API gives this no code of its own: an invalid request, told apart by its words.
  const out = error instanceof Error && /credit balance/i.test(error.message);
  if (out) credit.__ifmsBotCreditOutAt = Date.now();
  return out;
}
