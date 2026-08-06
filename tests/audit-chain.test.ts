import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { canonicalize } from '../src/core/security/canonical.ts';

/**
 * The audit chain's tamper-evidence rests entirely on canonical serialisation:
 * if two structurally identical records could serialise differently, the same
 * record would hash differently and the chain would break for innocent reasons.
 * These tests pin that property.
 */

const GENESIS = '0'.repeat(64);

function hash(prev: string, record: unknown): string {
  return createHash('sha256').update(`${prev}${canonicalize(record)}`).digest('hex');
}

describe('canonicalize', () => {
  it('is independent of key insertion order', () => {
    assert.equal(
      canonicalize({ b: 1, a: 2, c: 3 }),
      canonicalize({ c: 3, a: 2, b: 1 }),
    );
  });

  it('serialises bigint as a decimal string', () => {
    assert.equal(canonicalize({ amount: 123n }), '{"amount":"123"}');
  });

  it('serialises dates as ISO strings', () => {
    const date = new Date('2026-08-06T10:30:00.000Z');
    assert.equal(canonicalize({ at: date }), '{"at":"2026-08-06T10:30:00.000Z"}');
  });

  it('treats null and undefined identically', () => {
    assert.equal(canonicalize({ a: null }), canonicalize({ a: undefined }));
  });

  it('recurses into nested objects and arrays', () => {
    assert.equal(
      canonicalize({ outer: { z: 1, a: [{ y: 2, x: 1n }] } }),
      '{"outer":{"a":[{"x":"1","y":2}],"z":1}}',
    );
  });
});

describe('hash chain', () => {
  const records = [
    { id: 1, action: 'LOGIN', summary: 'signed in' },
    { id: 2, action: 'CREATE', summary: 'created TXN-1' },
    { id: 3, action: 'POST', summary: 'posted TXN-1' },
  ];

  function build() {
    let prev = GENESIS;
    return records.map((record) => {
      const entry = { prevHash: prev, record, hash: hash(prev, record) };
      prev = entry.hash;
      return entry;
    });
  }

  it('verifies an untouched chain', () => {
    const chain = build();
    let expected = GENESIS;

    for (const entry of chain) {
      assert.equal(entry.prevHash, expected);
      assert.equal(entry.hash, hash(entry.prevHash, entry.record));
      expected = entry.hash;
    }
  });

  it('detects a modified record', () => {
    const chain = build();
    // Someone edits the middle record's summary after the fact.
    const tampered = { ...chain[1]!, record: { ...chain[1]!.record, summary: 'posted TXN-999' } };

    assert.notEqual(tampered.hash, hash(tampered.prevHash, tampered.record));
  });

  it('detects a removed record', () => {
    const chain = build();
    const withoutMiddle = [chain[0]!, chain[2]!];

    // The third record still points at the second, which no longer exists.
    assert.notEqual(withoutMiddle[1]!.prevHash, withoutMiddle[0]!.hash);
  });

  it('detects reordering', () => {
    const chain = build();
    const reordered = [chain[0]!, chain[2]!, chain[1]!];

    assert.notEqual(reordered[1]!.prevHash, reordered[0]!.hash);
  });

  it('produces the same hash for the same record written twice', () => {
    const record = { id: 9, amount: 500n, at: new Date('2026-01-01T00:00:00.000Z') };
    assert.equal(hash(GENESIS, record), hash(GENESIS, { ...record }));
  });
});
