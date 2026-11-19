import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyGroupFor,
  groupFor,
  groupPlan,
  newlyLinked,
  parseRoutes,
  parseWelcomed,
  withRoute,
} from '../src/modules/whatsapp/group-routes.ts';

const MAIN = 'main@g.us';
const routes = {
  REMITTANCE: { id: 'remit@g.us', name: 'الحوالات' },
  USDT: { id: 'coins@g.us', name: 'يواس' },
};

describe('which group hears of which deals', () => {
  it('sends every kind to the main group until one is given its own', () => {
    for (const type of ['EXCHANGE', 'USDT_RECEIVE', 'REMITTANCE_OUT', 'WALLET_TOPUP', 'OTHER']) {
      assert.equal(groupFor(type, {}, MAIN), MAIN);
    }
  });

  it('sends a kind with its own group there, and all of its types with it', () => {
    assert.equal(groupFor('REMITTANCE_OUT', routes, MAIN), 'remit@g.us');
    assert.equal(groupFor('REMITTANCE_IN', routes, MAIN), 'remit@g.us');
    assert.equal(groupFor('USDT_RECEIVE', routes, MAIN), 'coins@g.us');
    assert.equal(groupFor('USDT_SEND', routes, MAIN), 'coins@g.us');
    assert.equal(groupFor('USDT_SALE', routes, MAIN), 'coins@g.us');
  });

  it('sends incoming remittances to a group of their own once one is chosen', () => {
    const apart = { ...routes, REMITTANCE_IN: { id: 'in@g.us', name: 'الواردة' } };
    assert.equal(groupFor('REMITTANCE_IN', apart, MAIN), 'in@g.us');
    assert.equal(groupFor('REMITTANCE_OUT', apart, MAIN), 'remit@g.us');
    assert.equal(groupFor('REMITTANCE_IN', {}, MAIN), MAIN);
  });

  it('gives a USDT sale its own group, else the USDT group, else the main one', () => {
    assert.equal(groupFor('USDT_SALE', {}, MAIN), MAIN);
    assert.equal(groupFor('USDT_SALE', routes, MAIN), 'coins@g.us');
    const own = { ...routes, USDT_SALE: { id: 'sales@g.us', name: 'البيع' } };
    assert.equal(groupFor('USDT_SALE', own, MAIN), 'sales@g.us');
    assert.equal(groupFor('USDT_SEND', own, MAIN), 'coins@g.us', 'the rest of USDT stays put');
    assert.equal(groupFor('USDT_RECEIVE', own, MAIN), 'coins@g.us');
  });

  it('sends a cash-out from a wallet with the exchange until it has a group of its own', () => {
    const exchange = { EXCHANGE: { id: 'fx@g.us', name: 'الصرافة' } };
    assert.equal(groupFor('WALLET_CASHOUT', {}, MAIN), MAIN);
    assert.equal(groupFor('WALLET_CASHOUT', exchange, MAIN), 'fx@g.us');
    const own = { ...exchange, WALLET_CASHOUT: { id: 'wallet@g.us', name: 'سحب من محفظة' } };
    assert.equal(groupFor('WALLET_CASHOUT', own, MAIN), 'wallet@g.us');
    assert.equal(groupFor('EXCHANGE', own, MAIN), 'fx@g.us', 'the exchange stays put');
    assert.equal(groupFor('WALLET_TOPUP', own, MAIN), 'fx@g.us', 'a top-up stays with the exchange');
  });

  it('copies the transfers of exchange and USDT receipts only where asked', () => {
    assert.equal(copyGroupFor('EXCHANGE', routes, MAIN), '', 'never by itself');
    const bank = { ...routes, BANK_COPY: { id: 'bank@g.us', name: 'التحويلات' } };
    assert.equal(copyGroupFor('EXCHANGE', bank, MAIN), 'bank@g.us');
    assert.equal(copyGroupFor('USDT_RECEIVE', bank, MAIN), 'bank@g.us');
    assert.equal(copyGroupFor('WALLET_TOPUP', bank, MAIN), 'bank@g.us', 'a top-up is a transfer to the wallet');
    assert.equal(copyGroupFor('USDT_SEND', bank, MAIN), '', 'a withdrawal pays no transfer');
    assert.equal(copyGroupFor('REMITTANCE_OUT', bank, MAIN), '');
  });

  it('copies a remittance’s number and sum only where asked, and not to where it just went', () => {
    assert.equal(copyGroupFor('REMITTANCE_OUT', {}, MAIN), '', 'never to the main group by itself');
    const copy = { ...routes, REMITTANCE_COPY: { id: 'exec@g.us', name: 'التنفيذ' } };
    assert.equal(copyGroupFor('REMITTANCE_OUT', copy, MAIN), 'exec@g.us');
    assert.equal(copyGroupFor('REMITTANCE_IN', copy, MAIN), '', 'only those sent');
    assert.equal(copyGroupFor('EXCHANGE', copy, MAIN), '');
    const same = { ...routes, REMITTANCE_COPY: { id: 'remit@g.us', name: 'الحوالات' } };
    assert.equal(copyGroupFor('REMITTANCE_OUT', same, MAIN), '', 'it has them already');
    assert.deepEqual(
      groupPlan(copy, MAIN).find((entry) => entry.id === 'exec@g.us')?.hears,
      ['رقم الحوالة ومبلغها'],
    );
  });

  it('leaves the other kinds with the main group', () => {
    assert.equal(groupFor('EXCHANGE', routes, MAIN), MAIN);
    assert.equal(groupFor('WALLET_CASHOUT', routes, MAIN), MAIN);
    assert.equal(groupFor('SOMETHING_NEW', routes, MAIN), MAIN);
  });

  it('still sends a routed kind when there is no main group', () => {
    assert.equal(groupFor('REMITTANCE_OUT', routes, ''), 'remit@g.us');
    assert.equal(groupFor('EXCHANGE', routes, ''), '');
  });

  it('reads what it stored, and treats anything else as no routes', () => {
    assert.deepEqual(parseRoutes(JSON.stringify(routes)), routes);
    assert.deepEqual(parseRoutes(''), {});
    assert.deepEqual(parseRoutes('not json'), {});
    assert.deepEqual(parseRoutes('null'), {});
    assert.deepEqual(parseRoutes('{"USDT":{"id":"  "},"NOPE":{"id":"x"},"REMITTANCE":3}'), {});
  });

  it('points a kind at a group and back at the main group', () => {
    const set = withRoute({}, 'EXCHANGE', 'bank@g.us', 'البنك');
    assert.deepEqual(set, { EXCHANGE: { id: 'bank@g.us', name: 'البنك' } });
    assert.deepEqual(withRoute(set, 'EXCHANGE', '', ''), {});
    assert.deepEqual(withRoute(set, 'USDT', 'coins@g.us', 'يواس'), {
      EXCHANGE: { id: 'bank@g.us', name: 'البنك' },
      USDT: { id: 'coins@g.us', name: 'يواس' },
    });
  });

  it('welcomes only a group that just came into use and never had it', () => {
    assert.deepEqual(newlyLinked(['a'], ['a', 'b'], []), ['b']);
    assert.deepEqual(newlyLinked(['a'], ['a'], []), [], 'already in use before the message existed');
    assert.deepEqual(newlyLinked(['a'], ['a', 'b'], ['b']), [], 'relinked: it has had it');
    assert.deepEqual(newlyLinked(['a', 'b'], ['b'], []), [], 'a group leaving is told nothing');
  });

  it('reads the welcomed groups as stored', () => {
    assert.deepEqual(parseWelcomed(''), []);
    assert.deepEqual(parseWelcomed('a@g.us, b@g.us,'), ['a@g.us', 'b@g.us']);
  });

  it('names each group once, with all it hears', () => {
    assert.deepEqual(groupPlan(routes, MAIN), [
      { id: MAIN, hears: ['الصرافة', 'السحب من المحافظ', 'تيكتوك'] },
      { id: 'coins@g.us', hears: ['USDT', 'بيع USDT'] },
      { id: 'remit@g.us', hears: ['الحوالات', 'الحوالات الواردة', 'حوالات باي بال'] },
    ]);
    assert.deepEqual(groupPlan({}, MAIN), [
      {
        id: MAIN,
        hears: [
          'الصرافة',
          'السحب من المحافظ',
          'USDT',
          'بيع USDT',
          'الحوالات',
          'الحوالات الواردة',
          'حوالات باي بال',
          'تيكتوك',
        ],
      },
    ]);
    assert.deepEqual(groupPlan({}, ''), []);
  });
});
