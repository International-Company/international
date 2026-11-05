import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
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

  it('gives a USDT sale its own group, else the USDT group, else the main one', () => {
    assert.equal(groupFor('USDT_SALE', {}, MAIN), MAIN);
    assert.equal(groupFor('USDT_SALE', routes, MAIN), 'coins@g.us');
    const own = { ...routes, USDT_SALE: { id: 'sales@g.us', name: 'البيع' } };
    assert.equal(groupFor('USDT_SALE', own, MAIN), 'sales@g.us');
    assert.equal(groupFor('USDT_SEND', own, MAIN), 'coins@g.us', 'the rest of USDT stays put');
    assert.equal(groupFor('USDT_RECEIVE', own, MAIN), 'coins@g.us');
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
      { id: MAIN, hears: ['الصرافة', 'تيكتوك'] },
      { id: 'coins@g.us', hears: ['USDT', 'بيع USDT'] },
      { id: 'remit@g.us', hears: ['الحوالات'] },
    ]);
    assert.deepEqual(groupPlan({}, MAIN), [
      { id: MAIN, hears: ['الصرافة', 'USDT', 'بيع USDT', 'الحوالات', 'تيكتوك'] },
    ]);
    assert.deepEqual(groupPlan({}, ''), []);
  });
});
