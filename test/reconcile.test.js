'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDemo } = require('../lib/seed');
const { reconcile } = require('../lib/reconcile');
const store = require('../lib/store');

const byId = (report, id) => report.specimens.find((s) => s.specimenId === id);
const cell = (report, id, lookId) => byId(report, id).looks[lookId];

test('demo is reproducible for the same seed', () => {
  const a = buildDemo('tray-2026');
  const b = buildDemo('tray-2026');
  const c = buildDemo('other-seed');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.observations, c.observations);
});

test('different seeds keep the pinned teaching cases stable', () => {
  for (const seed of ['tray-2026', 'alpha', 'x']) {
    const data = buildDemo(seed);
    const find = (id) => data.specimens.find((s) => s.specimenId === id);
    assert.ok(find('T-04-H03'), 'transfer specimen should always exist');
    assert.ok(data.transfers.some((t) => t.specimenId === 'T-04-H03'));
    assert.ok(data.discards.some((d) => d.trayId === 'T-08'));
  }
});

test('rejects an empty seed', () => {
  assert.throws(() => buildDemo(''), /seed must be a non-empty string/);
  assert.throws(() => buildDemo(null), /seed must be a non-empty string/);
});

test('a hole is not planted in trays that were left empty', () => {
  const data = buildDemo('tray-2026');
  assert.ok(!data.specimens.some((s) => s.specimenId === 'T-07-H03'));
  assert.ok(!data.specimens.some((s) => s.specimenId === 'T-06-H03'));
});

test('resow: first sprout belongs to the batch in the hole at that look', () => {
  const report = reconcile(buildDemo('tray-2026'));
  const row = byId(report, 'T-01-H02');
  assert.equal(cell(report, 'T-01-H02', 'R1').status, 'no-sprout');
  assert.equal(cell(report, 'T-01-H02', 'R2').status, 'sprouted');
  assert.equal(row.firstSprout.batchId, 'Batch-B', 'R2 sprout must belong to the resowed batch, not Batch-A');
  assert.equal(cell(report, 'T-01-H02', 'R2').batchActive, 'Batch-B');
});

test('resow twice: sprout belongs to the latest planting, not the first', () => {
  const report = reconcile(buildDemo('tray-2026'));
  const row = byId(report, 'T-06-H05');
  assert.equal(cell(report, 'T-06-H05', 'R1').batchActive, 'Batch-B');
  assert.equal(cell(report, 'T-06-H05', 'R2').batchActive, 'Batch-A');
  assert.equal(row.firstSprout.batchId, 'Batch-A');
});

test('a sprout recorded against the wrong batch is flagged, stats use the real batch', () => {
  const report = reconcile(buildDemo('tray-2026'));
  const flags = report.anomalies.filter((a) => a.code === 'batch-mismatch');
  assert.ok(flags.some((a) => a.specimenId === 'T-01-H02'));
  assert.ok(flags.some((a) => a.specimenId === 'T-06-H05'));
  // Attribution still follows the planting log.
  assert.equal(byId(report, 'T-01-H02').firstSprout.batchId, 'Batch-B');
});

test('mid-follow-up tray change truncates the old series and re-anchors the new one', () => {
  const report = reconcile(buildDemo('tray-2026'));
  const row = byId(report, 'T-04-H03');
  assert.equal(row.truncation.kind, 'transfer');
  assert.equal(row.truncation.date, '2026-10-11');
  assert.equal(cell(report, 'T-04-H03', 'R1').status, 'not-observed');
  assert.equal(cell(report, 'T-04-H03', 'R2').trayId, 'T-07');
  assert.equal(cell(report, 'T-04-H03', 'R2').status, 'sprouted');
  // The observation written against the old address is an orphan, not a reading.
  assert.ok(report.anomalies.some((a) => a.code === 'orphan-observation' && a.subtype === 'vacated-location'));
});

test('a transfer whose destination was never rechecked ends as not-observed', () => {
  const report = reconcile(buildDemo('tray-2026'));
  const row = byId(report, 'T-05-H06');
  assert.equal(row.truncation.kind, 'transfer');
  assert.equal(row.truncation.rechecked, false);
  assert.equal(cell(report, 'T-05-H06', 'R2').status, 'not-observed');
  assert.equal(cell(report, 'T-05-H06', 'R2').trayId, 'T-06');
});

test('discarded tray leaves the denominator and later readings are voided', () => {
  const report = reconcile(buildDemo('tray-2026'));
  for (let h = 1; h <= 6; h++) {
    const id = `T-08-H${String(h).padStart(2, '0')}`;
    assert.equal(cell(report, id, 'R2').status, 'excluded', `${id} should be excluded after discard`);
  }
  assert.ok(report.anomalies.some((a) => a.code === 'after-discard'));
});

test('no-sprout and not-observed are counted separately and not merged', () => {
  const report = reconcile(buildDemo('tray-2026'));
  const r2 = report.byLook.find((l) => l.lookId === 'R2');
  assert.ok(r2.noSprout > 0);
  assert.ok(r2.notObserved > 0);
  assert.equal(r2.evaluable, r2.sprouted + r2.noSprout);
  assert.notEqual(r2.evaluable, r2.sprouted + r2.noSprout + r2.notObserved);
  // Explicitly different holes are responsible for the two buckets.
  const noSproutIds = report.specimens
    .filter((s) => s.looks.R2.status === 'no-sprout')
    .map((s) => s.specimenId);
  const notObservedIds = report.specimens
    .filter((s) => s.looks.R2.status === 'not-observed')
    .map((s) => s.specimenId);
  assert.equal(notObservedIds.length, r2.notObserved);
  assert.equal(noSproutIds.length, r2.noSprout);
  assert.equal(noSproutIds.filter((id) => notObservedIds.includes(id)).length, 0);
  assert.equal(r2.evaluable, r2.sprouted + r2.noSprout);
});

test('contradictory records in one look are not silently resolved', () => {
  const report = reconcile(buildDemo('tray-2026'));
  assert.equal(cell(report, 'T-02-H03', 'R2').status, 'contradictory');
  assert.ok(report.anomalies.some((a) => a.code === 'contradictory-observation'));
  const r2 = report.byLook.find((l) => l.lookId === 'R2');
  assert.equal(r2.contradictory, 1);
  assert.equal(r2.evaluable, r2.sprouted + r2.noSprout);
});

test('duplicate identical records are counted once', () => {
  const report = reconcile(buildDemo('tray-2026'));
  assert.equal(cell(report, 'T-05-H02', 'R2').status, 'no-sprout');
  const dup = report.anomalies.find((a) => a.code === 'duplicate-observation');
  assert.ok(dup);
  assert.equal(dup.severity, 'info');
});

test('observations with no matching specimen are reported, not counted', () => {
  const report = reconcile(buildDemo('tray-2026'));
  const subtypes = report.anomalies
    .filter((a) => a.code === 'orphan-observation')
    .map((a) => a.subtype);
  assert.ok(subtypes.includes('unknown-tray'), 'T-09 should be reported as unknown tray');
  assert.ok(subtypes.includes('not-yet-occupied'), 'pre-move reading of a future hole');
  assert.ok(report.orphans.length >= 3);
  const total = report.byLook.reduce((n, l) => n + l.sprouted + l.noSprout + l.notObserved + l.excluded + l.contradictory, 0);
  assert.ok(total <= report.specimens.length * report.looks.length);
});

test('statistics are internally consistent for every look', () => {
  const report = reconcile(buildDemo('tray-2026'));
  for (const look of report.byLook) {
    assert.equal(look.evaluable, look.sprouted + look.noSprout);
    const cells = report.specimens.map((s) => s.looks[look.lookId]);
    assert.equal(cells.length, report.counts.specimens);
    assert.equal(cells.filter((c) => c.status === 'sprouted').length, look.sprouted);
    assert.equal(cells.filter((c) => c.status === 'no-sprout').length, look.noSprout);
    assert.equal(cells.filter((c) => c.status === 'not-observed').length, look.notObserved);
    assert.equal(cells.filter((c) => c.status === 'excluded').length, look.excluded);
    assert.equal(cells.filter((c) => c.status === 'contradictory').length, look.contradictory);
    if (look.evaluable > 0) {
      assert.equal(look.germRate, Math.round((look.sprouted / look.evaluable) * 10000) / 10000);
    } else {
      assert.equal(look.germRate, null);
    }
  }
});

test('pairwise comparison reuses the same denominator rule per arm', () => {
  const report = reconcile(buildDemo('tray-2026'));
  assert.equal(report.byPair.length, 4);
  for (const pair of report.byPair) {
    for (const arm of [pair.control, pair.treatment]) {
      if (!arm) continue;
      assert.equal(arm.final.evaluable, arm.final.sprouted + arm.final.noSprout);
    }
    if (pair.control && pair.treatment && pair.delta !== null) {
      assert.equal(pair.delta, Math.round((pair.treatment.final.germRate - pair.control.final.germRate) * 10000) / 10000);
    }
  }
  // P-4's treatment tray is the discarded one: no evaluable holes, delta null.
  const p4 = report.byPair.find((p) => p.pairId === 'P-4');
  assert.equal(p4.treatment.final.evaluable, 0);
  assert.equal(p4.delta, null);
});

test('archive pass lists the specimens whose conclusion changed', () => {
  const report = reconcile(buildDemo('tray-2026'));
  assert.ok(report.changedCount > 0);
  for (const change of report.changeList) {
    assert.notEqual(change.from, change.to);
    const row = byId(report, change.specimenId);
    assert.equal(row.conclusionFrom, change.from);
    assert.equal(row.conclusionTo, change.to);
    assert.ok(change.note.length > 0);
  }
});

test('cumulative verdict: a hole censored before its window closed exits the denominator', () => {
  const report = reconcile(buildDemo('tray-2026'));
  // T-05-H06 was read as no-sprout once, then moved out and never rechecked.
  // Counting it as "did not germinate" would understate the rate.
  const row = byId(report, 'T-05-H06');
  assert.equal(row.conclusionTo, 'excluded');
  assert.equal(row.truncation.rechecked, false);
  // Its per-look cells keep the actual readings; only the cumulative view censors.
  assert.equal(cell(report, 'T-05-H06', 'R1').status, 'no-sprout');
  assert.equal(cell(report, 'T-05-H06', 'R2').status, 'not-observed');

  // T-08 holes were no-sprout before the tray was discarded, same treatment.
  assert.equal(byId(report, 'T-08-H01').conclusionTo, 'excluded');
  assert.equal(report.cumulative.excluded, 5);
  assert.equal(report.cumulative.sprouted + report.cumulative.noSprout, report.cumulative.evaluable);
  assert.equal(
    report.cumulative.sprouted +
      report.cumulative.noSprout +
      report.cumulative.notObserved +
      report.cumulative.excluded +
      report.cumulative.contradictory,
    report.cumulative.sown,
  );
});

test('cumulative verdict: a sprout reading is never reversed by a later no-sprout', () => {
  const report = reconcile(buildDemo('tray-2026'));
  // T-07-H05 sprouted in R1 and was re-read as no-sprout in R2. The first
  // sprout still settles the hole; the reversal stays visible as a data issue.
  const row = byId(report, 'T-07-H05');
  assert.equal(row.looks.R1.status, 'sprouted');
  assert.equal(row.looks.R2.status, 'no-sprout');
  assert.equal(row.conclusionTo, 'sprouted');
  assert.equal(row.changed, false);
  assert.equal(row.firstSprout.batchId, 'Batch-C');
});

test('cumulative verdict: a contradictory cell never invents a first sprout', () => {
  const report = reconcile(buildDemo('tray-2026'));
  const row = byId(report, 'T-02-H03');
  assert.equal(row.conclusionTo, 'contradictory');
  assert.equal(row.firstSprout, null);
  const r2 = report.byLook.find((l) => l.lookId === 'R2');
  assert.equal(r2.evaluable, r2.sprouted + r2.noSprout, 'contradictory must stay out of the denominator');
});

test('censoring after the first version shows up as a conclusion change', () => {
  const report = reconcile(buildDemo('tray-2026'));
  // T-05-H06 was read in R1, then moved out and never rechecked.
  const moved = report.changeList.find((c) => c.specimenId === 'T-05-H06');
  assert.ok(moved, 'a hole that leaves observation must surface in the change list');
  assert.equal(moved.from, 'no-sprout');
  assert.equal(moved.to, 'excluded');
  assert.match(moved.note, /中断|截断|废弃/);

  // T-08 was discarded on 10-14, after R1: its non-sprouted holes leave the
  // denominator. Its sprouted holes keep their verdict (germination is final),
  // so they are not changes.
  const t8 = report.changeList.filter((c) => c.specimenId.startsWith('T-08-'));
  assert.ok(t8.length > 0);
  assert.ok(t8.every((c) => c.to === 'excluded'));
  assert.ok(!t8.some((c) => c.specimenId === 'T-08-H03' || c.specimenId === 'T-08-H05'));
});

test('reconcile is pure: repeated runs do not mutate the input', () => {
  const data = buildDemo('tray-2026');
  const snapshot = JSON.parse(JSON.stringify(data));
  const first = reconcile(data);
  const second = reconcile(data);
  assert.deepEqual(data, snapshot);
  assert.deepEqual(first, second);
});
