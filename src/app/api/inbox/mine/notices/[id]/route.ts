import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { errors } from '@/core/errors/app-error';
import { toJsonSafe } from '@/core/http/json';
import {
  decideNotice,
  noticeDetail,
  passToCustomer,
  remitOutNotice,
  quoteRemit,
  remitNotice,
  remitOptions,
  reopenNotice,
  sendForCheck,
  updateNotice,
} from '@/modules/whatsapp/remittance-notice.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** One notice, with what its agent has said so far. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  handler: async ({ params, actor }) => noticeDetail(actor.id, params.id),
});

const patchSchema = z.object({
  network: z.string().trim().min(1).max(40).optional(),
  amount: z.string().max(30).nullish(),
  currency: z.string().max(8).nullish(),
  note: z.string().max(500).nullish(),
  beneficiaryName: z.string().max(120).nullish(),
  beneficiaryPhone: z.string().max(40).nullish(),
  beneficiaryAccount: z.string().max(80).nullish(),
  destination: z.string().max(120).nullish(),
  deliverAmount: z.string().max(30).nullish(),
  deliverCurrency: z.string().max(8).nullish(),
  intakeMethod: z.enum(['CASH', 'BANK', 'SPLIT']).nullish(),
  intakeChannel: z.string().max(80).nullish(),
  photoMessageId: z.string().max(40).nullish(),
});

/** What the teller read off the notice. */
export const PATCH = route<z.infer<typeof patchSchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  bodySchema: patchSchema,
  handler: async ({ params, body, actor }) =>
    updateNotice(actor.id, params.id, {
      network: body.network,
      amount:
        body.amount === undefined ? undefined : body.amount?.trim() ? parseMoney(body.amount) : null,
      currency: body.currency,
      note: body.note,
      beneficiaryName: body.beneficiaryName,
      beneficiaryPhone: body.beneficiaryPhone,
      beneficiaryAccount: body.beneficiaryAccount,
      destination: body.destination,
      deliverAmount:
        body.deliverAmount === undefined
          ? undefined
          : body.deliverAmount?.trim()
            ? parseMoney(body.deliverAmount)
            : null,
      deliverCurrency: body.deliverCurrency,
      intakeMethod: body.intakeMethod,
      intakeChannel: body.intakeChannel,
      photoMessageId: body.photoMessageId,
    }),
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), agentChat: z.string().min(5).max(120) }),
  z.object({ action: z.literal('decide'), decision: z.enum(['CONFIRMED', 'REJECTED']) }),
  z.object({ action: z.literal('reopen') }),
  /** A photo the agent answered with, passed to the customer. */
  z.object({ action: z.literal('pass'), replyId: z.string().min(1).max(40) }),
  /** Sent out and carried out: the outgoing remittance recorded. */
  z.object({
    action: z.literal('remitOut'),
    destination: z.string().max(120).default(''),
    currency: z.string().min(2).max(8),
    collected: z.string().max(30),
    cost: z.string().max(30).nullish(),
    intakeChannel: z.string().max(80).nullish(),
    intakeTransfer: z.string().max(30).nullish(),
  }),
  /** What the payout form offers. */
  z.object({ action: z.literal('options') }),
  /** A sum in the money it is paid out in, at the board. */
  z.object({
    action: z.literal('quote'),
    amount: z.string().max(30),
    from: z.string().min(2).max(8),
    to: z.string().min(2).max(8),
  }),
  /** Paid out: the incoming remittance made. */
  z.object({
    action: z.literal('remit'),
    destination: z.string().max(120).default(''),
    currency: z.string().min(2).max(8),
    credited: z.string().max(30),
    payCurrency: z.string().min(2).max(8),
    paid: z.string().max(30),
    payoutChannel: z.string().max(80).nullish(),
    payoutAccount: z.string().max(80).nullish(),
    recipientName: z.string().max(200).nullish(),
    recipientIdNumber: z.string().max(40).nullish(),
  }),
]);

/** Sent to the agent for checking, decided, or opened again. */
export const POST = route<z.infer<typeof actionSchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  bodySchema: actionSchema,
  handler: async ({ params, body, actor, session }) => {
    if (body.action === 'send') return sendForCheck(actor.id, params.id, body.agentChat);
    if (body.action === 'options') return remitOptions(actor.id, params.id);
    if (body.action === 'pass') return toJsonSafe(await passToCustomer(actor.id, params.id, body.replyId));
    if (body.action === 'remitOut') {
      if (!['exchange.remittance.use', 'exchange.transaction.create'].every((name) => actor.permissions.includes(name))) {
        throw errors.forbidden('exchange.remittance.use');
      }
      return toJsonSafe(
        await remitOutNotice(
          actor.id,
          params.id,
          {
            destination: body.destination,
            currency: body.currency,
            collected: parseMoney(body.collected),
            cost: body.cost?.trim() ? parseMoney(body.cost) : null,
            intakeChannel: body.intakeChannel ?? null,
            intakeTransfer: body.intakeTransfer?.trim() ? parseMoney(body.intakeTransfer) : null,
          },
          actor,
        ),
      );
    }
    if (body.action === 'quote') {
      return toJsonSafe(await quoteRemit(actor.id, params.id, parseMoney(body.amount || '0'), body.from, body.to));
    }
    if (body.action === 'remit') {
      // Paying out is the counter's remittance, with the counter's permissions.
      if (!['exchange.remittance.use', 'exchange.transaction.create'].every((name) => actor.permissions.includes(name))) {
        throw errors.forbidden('exchange.remittance.use');
      }
      return toJsonSafe(
        await remitNotice(
          actor.id,
          params.id,
          {
            destination: body.destination,
            currency: body.currency,
            credited: parseMoney(body.credited),
            payCurrency: body.payCurrency,
            paid: parseMoney(body.paid),
            payoutChannel: body.payoutChannel ?? null,
            payoutAccount: body.payoutAccount ?? null,
            recipientName: body.recipientName ?? null,
            recipientIdNumber: body.recipientIdNumber ?? null,
          },
          actor,
        ),
      );
    }
    if (body.action === 'decide') {
      return decideNotice(actor.id, params.id, body.decision, session.user.fullNameAr || actor.name);
    }
    return reopenNotice(actor.id, params.id);
  },
});
