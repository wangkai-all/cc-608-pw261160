'use strict';

const { buildDemo } = require('./seed');
const { reconcile, STATUS_LABELS } = require('./reconcile');
const { fail } = require('./errors');

const MAX_SEED_LENGTH = 64;
const DEFAULT_SEED = 'tray-2026';

function normalizeSeed(seed) {
  if (seed === undefined || seed === null || seed === '') return DEFAULT_SEED;
  if (typeof seed !== 'string') fail('INVALID_SEED', 'seed 必须是字符串', 400, { field: 'seed' });
  const value = seed.trim();
  if (!value) fail('INVALID_SEED', 'seed 不能为空', 400, { field: 'seed' });
  if (value.length > MAX_SEED_LENGTH) {
    fail('INVALID_SEED', `seed 长度不能超过 ${MAX_SEED_LENGTH} 个字符`, 400, { field: 'seed' });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_SEED', 'seed 不能包含控制字符', 400, { field: 'seed' });
  }
  return value;
}

function createSession(seed = DEFAULT_SEED) {
  const normalized = normalizeSeed(seed);
  return {
    seed: normalized,
    dataset: buildDemo(normalized),
    stage: 'idle',
    firstReport: null,
    archiveReport: null,
    denominatorsView: null,
  };
}

function resetSession(session, seed) {
  const next = createSession(seed === undefined ? session.seed : seed);
  session.dataset = next.dataset;
  session.seed = next.seed;
  session.stage = 'idle';
  session.firstReport = null;
  session.archiveReport = null;
  session.denominatorsView = null;
  return session;
}

// First-version follow-up: only the baseline census (R1) is ingested. Later
// looks stay out of scope until the archive pass is explicitly run, so the
// first report stays frozen even after the archive pass has been applied.
function restrictToLooks(dataset, lookIds) {
  const keep = new Set(lookIds);
  return {
    ...dataset,
    meta: { ...dataset.meta, ingestedLooks: lookIds.slice() },
    looks: dataset.looks.filter((l) => keep.has(l.lookId)),
    observations: dataset.observations.filter((o) => keep.has(o.lookId)),
  };
}

function runFirstFollowup(session) {
  session.firstReport = reconcile(restrictToLooks(session.dataset, ['R1']));
  session.archiveReport = null;
  session.denominatorsView = null;
  session.stage = 'first';
  return session.firstReport;
}

// Archive tray recount: ingest R2 (the supplemental physical count) and rebuild
// the whole record. Requires the first version to exist, because the point of
// the pass is to compare against a frozen first reading.
function runArchivePass(session) {
  if (session.stage === 'idle' || !session.firstReport) {
    fail('FIRST_RUN_REQUIRED', '请先生成第一版随访，再补录托盘清点', 409);
  }
  session.archiveReport = reconcile(session.dataset);
  session.stage = 'archive';
  session.denominatorsView = null;
  return session.archiveReport;
}

function currentReport(session) {
  if (session.stage === 'archive') return session.archiveReport;
  if (session.stage === 'first') return session.firstReport;
  return null;
}

function buildDenominators(report) {
  if (!report) fail('FIRST_RUN_REQUIRED', '请先生成随访，再查看出芽分母', 409);

  const notObserved = [];
  const excluded = [];
  const contradictory = [];
  for (const row of report.specimens) {
    for (const look of report.looks) {
      const cell = row.looks[look.lookId];
      const item = {
        specimenId: row.specimenId,
        lookId: look.lookId,
        pair: row.pair,
        reason: cell.reason || '',
      };
      if (cell.status === 'not-observed') notObserved.push(item);
      else if (cell.status === 'excluded') excluded.push(item);
      else if (cell.status === 'contradictory') contradictory.push(item);
    }
  }

  const batchCorrections = report.anomalies
    .filter((a) => a.code === 'batch-mismatch')
    .map((a) => ({ specimenId: a.specimenId, lookId: a.lookId, message: a.message }));

  const firstSprouts = report.specimens
    .filter((s) => s.firstSprout)
    .map((s) => ({
      specimenId: s.specimenId,
      pair: s.pair,
      lookId: s.firstSprout.lookId,
      date: s.firstSprout.date,
      batchId: s.firstSprout.batchId,
      batchLabel: s.firstSprout.batchLabel,
    }));

  return {
    stage: report.looks.length > 1 ? 'archive' : 'first',
    looks: report.byLook,
    cumulative: report.cumulative,
    pairs: report.byPair,
    notObserved,
    excluded,
    contradictory,
    firstSprouts,
    batchCorrections,
    labels: STATUS_LABELS,
    explanation: [
      '分母只统计“可评估孔位”：出芽 + 未出芽。未观察到、不可观察、记录矛盾都不进分母。',
      '“未出芽”表示该轮确实看到了这个孔并且没有芽；“未观察到”表示该轮没有可用清点记录，两者不可合并。',
      '中途换盘时，旧盘孔位的观察序列在换盘日截断；新盘孔位从换盘日起重新计数，未回查则记为未观察到。',
      '整盘废弃后，该盘孔位退出分母，废弃之后抄录的观察作废。',
      '每个孔的第一次出芽归属于出芽当时该孔最新的种植批次；批次不符的记录会标注纠正，但统计按当时批次。',
      '累计口径按“每孔一次结论”：出芽不可逆，一次出芽读数即定论；在出芽窗口关闭前被截断（换盘后未回查、整盘废弃）的孔退出分母，不按未出芽计。',
      '同一轮记录互相矛盾的孔不产生首次出芽归属，也不进出芽分子，先人工复核。',
    ],
  };
}

function runDenominators(session) {
  session.denominatorsView = buildDenominators(currentReport(session));
  return session.denominatorsView;
}

function stateOf(session) {
  const report = currentReport(session);
  return {
    seed: session.seed,
    stage: session.stage,
    counts: report ? report.counts : null,
    reports: {
      first: session.firstReport,
      archive: session.archiveReport,
    },
    denominators: session.denominatorsView,
  };
}

module.exports = {
  DEFAULT_SEED,
  MAX_SEED_LENGTH,
  normalizeSeed,
  createSession,
  resetSession,
  runFirstFollowup,
  runArchivePass,
  runDenominators,
  buildDenominators,
  currentReport,
  stateOf,
};
