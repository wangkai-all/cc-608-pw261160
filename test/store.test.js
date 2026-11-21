'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../lib/store');

test('archive pass refuses to run before the first follow-up', () => {
  const session = store.createSession('tray-2026');
  assert.throws(
    () => store.runArchivePass(session),
    (err) => err.code === 'FIRST_RUN_REQUIRED' && err.status === 409,
  );
});

test('denominators refuse to run before any follow-up', () => {
  const session = store.createSession('tray-2026');
  assert.throws(() => store.runDenominators(session), (err) => err.code === 'FIRST_RUN_REQUIRED');
});

test('first follow-up only ingests R1; R2 is out of scope until archive', () => {
  const session = store.createSession('tray-2026');
  const report = store.runFirstFollowup(session);
  assert.deepEqual(report.looks.map((l) => l.lookId), ['R1']);
  assert.equal(report.counts.observations, session.dataset.observations.filter((o) => o.lookId === 'R1').length);
  assert.equal(session.stage, 'first');
});

test('archive pass ingests R2 and produces a before/after change list', () => {
  const session = store.createSession('tray-2026');
  store.runFirstFollowup(session);
  const report = store.runArchivePass(session);
  assert.deepEqual(report.looks.map((l) => l.lookId), ['R1', 'R2']);
  assert.ok(report.changedCount > 0);
  assert.equal(session.stage, 'archive');
  // Re-running is idempotent: same report, no duplicated observations.
  const again = store.runArchivePass(session);
  assert.deepEqual(again.byLook, report.byLook);
});

test('denominator view separates not-observed from no-sprout', () => {
  const session = store.createSession('tray-2026');
  store.runFirstFollowup(session);
  store.runArchivePass(session);
  const view = store.runDenominators(session);
  assert.equal(view.stage, 'archive');
  assert.ok(view.notObserved.length > 0);
  assert.ok(view.cumulative.noSprout > 0);
  for (const item of view.notObserved) {
    assert.ok(item.specimenId);
    assert.ok(item.reason);
  }
  // Every not-observed entry must be a genuine not-observed cell.
  for (const item of view.notObserved) {
    const row = session.archiveReport.specimens.find((s) => s.specimenId === item.specimenId);
    assert.equal(row.looks[item.lookId].status, 'not-observed');
  }
});

test('denominators on the first version do not see R2 only findings', () => {
  const session = store.createSession('tray-2026');
  store.runFirstFollowup(session);
  const view = store.runDenominators(session);
  assert.equal(view.stage, 'first');
  assert.equal(view.firstSprouts.every((s) => s.lookId === 'R1'), true);
});

test('a different seed yields a different but valid report', () => {
  const a = store.createSession('tray-2026');
  store.runFirstFollowup(a);
  store.runArchivePass(a);
  const b = store.createSession('alpha');
  store.runFirstFollowup(b);
  store.runArchivePass(b);
  assert.notDeepEqual(a.archiveReport.byLook, b.archiveReport.byLook);
  for (const look of b.archiveReport.byLook) {
    assert.equal(look.evaluable, look.sprouted + look.noSprout);
  }
});

test('seed validation rejects bad input', () => {
  assert.equal(store.normalizeSeed(undefined), 'tray-2026');
  assert.equal(store.normalizeSeed('  abc  '), 'abc');
  assert.throws(() => store.normalizeSeed(42), (err) => err.code === 'INVALID_SEED');
  assert.throws(() => store.normalizeSeed('   '), (err) => err.code === 'INVALID_SEED');
  assert.throws(() => store.normalizeSeed('x'.repeat(65)), (err) => err.code === 'INVALID_SEED');
  assert.throws(() => store.normalizeSeed('bad\u0000seed'), (err) => err.code === 'INVALID_SEED');
});

test('reset clears stage and reports but keeps the chosen seed', () => {
  const session = store.createSession('tray-2026');
  store.runFirstFollowup(session);
  store.runArchivePass(session);
  assert.equal(session.stage, 'archive');
  store.resetSession(session, 'beta');
  assert.equal(session.stage, 'idle');
  assert.equal(session.seed, 'beta');
  assert.equal(session.firstReport, null);
  assert.equal(session.archiveReport, null);
  assert.throws(() => store.runArchivePass(session), (err) => err.code === 'FIRST_RUN_REQUIRED');
});

test('state snapshot exposes only the stage that has been run', () => {
  const session = store.createSession('tray-2026');
  let state = store.stateOf(session);
  assert.equal(state.stage, 'idle');
  assert.equal(state.counts, null);
  store.runFirstFollowup(session);
  state = store.stateOf(session);
  assert.equal(state.stage, 'first');
  assert.equal(state.reports.archive, null);
  store.runArchivePass(session);
  state = store.stateOf(session);
  assert.equal(state.stage, 'archive');
  assert.ok(state.reports.first);
  assert.ok(state.reports.archive);
});
