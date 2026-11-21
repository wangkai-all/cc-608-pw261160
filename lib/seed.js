'use strict';

// ---------------------------------------------------------------------------
// Deterministic fictional trial generator.
//
// The demo is a tray germination trial:
//   8 trays x 6 holes, arranged in 4 paired trays (control / treatment).
//   Round 1 (R1) is the first follow-up. Round 2 (R2) is the archive recount.
//
// A seed string changes the results of *unpinned* holes only. The teaching
// cases (resow / tray change / discard / missed census / contradictory record)
// are pinned, so the demo story is identical for every seed while the bulk of
// the observations stays reproducible.
// ---------------------------------------------------------------------------

const LOOKS = [
  { lookId: 'R1', date: '2026-10-07', label: '第一版随访（首轮）' },
  { lookId: 'R2', date: '2026-10-18', label: '补录托盘清点' },
];

const BATCHES = [
  { id: 'Batch-A', label: '甲批种子（对照）' },
  { id: 'Batch-B', label: '乙批种子' },
  { id: 'Batch-C', label: '丙批种子' },
];

const TRAYS = [
  { id: 'T-01', pair: 'P-1', role: 'control', batch: 'Batch-A', label: '穴盘 P1-左' },
  { id: 'T-02', pair: 'P-1', role: 'treatment', batch: 'Batch-A', label: '穴盘 P1-右' },
  { id: 'T-03', pair: 'P-2', role: 'control', batch: 'Batch-A', label: '穴盘 P2-左' },
  { id: 'T-04', pair: 'P-2', role: 'treatment', batch: 'Batch-B', label: '穴盘 P2-右' },
  { id: 'T-05', pair: 'P-3', role: 'control', batch: 'Batch-A', label: '穴盘 P3-左' },
  { id: 'T-06', pair: 'P-3', role: 'treatment', batch: 'Batch-B', label: '穴盘 P3-右' },
  { id: 'T-07', pair: 'P-4', role: 'control', batch: 'Batch-C', label: '穴盘 P4-左' },
  { id: 'T-08', pair: 'P-4', role: 'treatment', batch: 'Batch-C', label: '穴盘 P4-右' },
];

const HOLES_PER_TRAY = 6;
const INITIAL_DATE = '2026-10-01';

// Holes deliberately left unsown (physical gaps in the bench).
const EMPTY_HOLES = new Set(['T-07-H03', 'T-06-H03']);

// Per-hole batch override (batch is tracked per hole, not per tray).
const BATCH_OVERRIDE = {
  'T-05-H03': 'Batch-C',
  'T-05-H04': 'Batch-C',
};

// Resow events. A resow starts a new planting attempt in the same hole; the
// newest planting before a sprout is the batch that owns that sprout.
const RESOWS = {
  'T-01-H02': [{ date: '2026-10-10', batch: 'Batch-B' }],
  'T-03-H01': [{ date: '2026-10-12', batch: 'Batch-A' }],
  'T-06-H05': [
    { date: '2026-10-10', batch: 'Batch-C' },
    { date: '2026-10-14', batch: 'Batch-A' },
  ],
};

// A specimen changing tray mid-follow-up. The old tray series is truncated on
// the transfer date; the new tray starts a fresh series.
const TRANSFERS = [
  {
    specimen: 'T-04-H03',
    date: '2026-10-11',
    toTrayId: 'T-07',
    toHole: 3,
    reason: '补光架调整，移入空位 T-07/H03',
  },
  {
    specimen: 'T-05-H06',
    date: '2026-10-13',
    toTrayId: 'T-06',
    toHole: 3,
    reason: '整盘挪位到 T-06/H03，之后未再回查',
  },
];

const DISCARD = {
  trayId: 'T-08',
  date: '2026-10-14',
  reason: '立枯病，整盘废弃',
};

// Pinned observation plan. r1/r2 null = not observed; arrays = repeated
// records in the same look (duplicates / contradictions).
// R2 is a full recount of the bench, so the only holes it cannot read are the
// ones that physically left (transfer destination not rechecked) or that were
// unreadable in both rounds.
const PINNED = {
  'T-01-H02': { r1: 'no-sprout', r2: ['sprouted'], batchSeen: { R2: 'Batch-A' } },
  'T-02-H03': { r1: 'no-sprout', r2: ['sprouted', 'no-sprout'] },
  'T-02-H06': { r1: null, r2: null },
  'T-03-H01': { r1: 'no-sprout', r2: ['sprouted'] },
  'T-03-H06': { r1: null, r2: ['sprouted'] },
  'T-04-H01': { r1: null, r2: ['sprouted'] },
  'T-04-H02': { r1: null, r2: ['no-sprout'] },
  'T-04-H03': { r1: null, r2: null }, // moved to T-07/H03 before R2
  'T-04-H04': { r1: null, r2: ['sprouted'] },
  'T-04-H05': { r1: null, r2: ['no-sprout'] },
  'T-04-H06': { r1: null, r2: ['sprouted'] },
  'T-05-H02': { r1: null, r2: ['no-sprout', 'no-sprout'] },
  'T-05-H04': { r1: 'no-sprout', r2: ['sprouted'] },
  'T-05-H06': { r1: 'no-sprout', r2: null }, // moved, destination never checked
  'T-06-H05': { r1: 'no-sprout', r2: ['sprouted'], batchSeen: { R2: 'Batch-B' } },
  'T-07-H05': { r1: 'sprouted', r2: ['no-sprout'] },
  'T-08-H01': { r1: 'no-sprout', r2: ['sprouted'] }, // stale: after discard
  'T-08-H02': { r1: null, r2: null },
  'T-08-H03': { r1: 'sprouted', r2: null },
  'T-08-H04': { r1: 'no-sprout', r2: null },
  'T-08-H05': { r1: 'sprouted', r2: null },
  'T-08-H06': { r1: 'no-sprout', r2: null },
};

// Observations written against a physical location rather than a specimen.
// They exercise the orphan / vacated-location branches of the ingest.
const EXTRA_OBS = [
  {
    lookId: 'R1',
    trayId: 'T-07',
    hole: 3,
    result: 'no-sprout',
    note: '空孔位上误录的观察（无对应种植）',
  },
  {
    lookId: 'R2',
    trayId: 'T-04',
    hole: 3,
    result: 'no-sprout',
    note: '换盘后旧盘号仍被抄录（孔位已迁走）',
  },
  {
    lookId: 'R2',
    trayId: 'T-09',
    hole: 2,
    result: 'sprouted',
    note: '不存在的托盘编号',
  },
];

// R2 observation on the destination tray of a transfer.
const MOVE_IN_OBS = [{ trayId: 'T-07', hole: 3, lookId: 'R2', result: 'sprouted' }];

// --- tiny deterministic PRNG ------------------------------------------------

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h === 0 ? 1 : h;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function holeKey(trayId, hole) {
  return `${trayId}-H${String(hole).padStart(2, '0')}`;
}

function buildDemo(seed = 'tray-2026') {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new TypeError('seed must be a non-empty string');
  }
  const rng = mulberry32(hashSeed(seed));
  const lookById = new Map(LOOKS.map((l) => [l.lookId, l]));

  const trays = TRAYS.map((t) => ({
    id: t.id,
    label: t.label,
    pair: t.pair,
    role: t.role,
    batch: t.batch,
    note:
      t.id === DISCARD.trayId
        ? `10-14 ${DISCARD.reason}`
        : t.id === 'T-07' || t.id === 'T-06'
          ? '10-13 起接收换盘样本'
          : '',
  }));

  const specimens = [];
  const plantings = [];
  const transfers = [];
  const observations = [];
  let plantingSeq = 0;
  let obsSeq = 0;

  const batchOf = (trayId, hole) =>
    BATCH_OVERRIDE[holeKey(trayId, hole)] || TRAYS.find((t) => t.id === trayId).batch;

  const addPlanting = (specimenId, trayId, hole, batchId, kind, date, note = '') => {
    plantingSeq += 1;
    plantings.push({
      plantingId: `PL-${String(plantingSeq).padStart(3, '0')}`,
      specimenId,
      trayId,
      hole,
      batchId,
      kind,
      date,
      note,
    });
  };

  const addObservation = (lookId, trayId, hole, result, batchSeen, note = '') => {
    obsSeq += 1;
    const look = lookById.get(lookId);
    observations.push({
      obsId: `OB-${String(obsSeq).padStart(3, '0')}`,
      lookId,
      date: look.date,
      trayId,
      hole,
      result,
      batchSeen: batchSeen || null,
      note,
    });
  };

  // --- register specimens + initial plantings ------------------------------
  for (const tray of trays) {
    for (let hole = 1; hole <= HOLES_PER_TRAY; hole++) {
      const key = holeKey(tray.id, hole);
      if (EMPTY_HOLES.has(key)) continue;
      const specimen = {
        specimenId: key,
        originalTrayId: tray.id,
        hole,
        originalBatch: batchOf(tray.id, hole),
        note: '',
      };
      if (key === 'T-01-H02') {
        specimen.note = '首轮未出芽，10-10 补种乙批；R2 出芽应记在乙批。';
      }
      if (key === 'T-06-H05') {
        specimen.note = '共补种两次（丙批、甲批），R2 出芽归最后一次补种的甲批。';
      }
      if (key === 'T-04-H03') {
        specimen.note = '10-11 换盘至 T-07/H03；旧盘观察序列在换盘日截断。';
      }
      if (key === 'T-05-H06') {
        specimen.note = '10-13 换盘至 T-06/H03，新盘未回查，随访截断。';
      }
      specimens.push(specimen);
      addPlanting(key, tray.id, hole, specimen.originalBatch, 'initial', INITIAL_DATE);
    }
  }

  // --- resows ---------------------------------------------------------------
  for (const [key, events] of Object.entries(RESOWS)) {
    const specimen = specimens.find((s) => s.specimenId === key);
    for (const ev of events) {
      addPlanting(key, specimen.originalTrayId, specimen.hole, ev.batch, 'resow', ev.date);
    }
  }

  // --- transfers ------------------------------------------------------------
  let transferSeq = 0;
  for (const t of TRANSFERS) {
    transferSeq += 1;
    const from = specimens.find((s) => s.specimenId === t.specimen);
    transfers.push({
      transferId: `TR-${String(transferSeq).padStart(2, '0')}`,
      specimenId: t.specimen,
      date: t.date,
      fromTrayId: from.originalTrayId,
      fromHole: from.hole,
      toTrayId: t.toTrayId,
      toHole: t.toHole,
      reason: t.reason,
    });
    addPlanting(t.specimen, t.toTrayId, t.toHole, from.originalBatch, 'transfer', t.date, t.reason);
  }

  // --- observations ---------------------------------------------------------
  for (const specimen of specimens) {
    const key = specimen.specimenId;
    const plan = PINNED[key] || null;
    // Unpinned holes: the first census may have skipped a few (first-round
    // gaps). The archive pass rereads the whole bench, so unpinned holes get
    // an R2 reading; only pinned holes leave deliberate blank cells.
    const r1 = plan
      ? plan.r1
      : rng() < 0.12
        ? null
        : rng() < 0.62
          ? 'sprouted'
          : 'no-sprout';
    const r2 = plan
      ? plan.r2
      : r1 !== null
        ? [r1]
        : [rng() < 0.6 ? 'sprouted' : 'no-sprout'];
    const seen = (lookId) => plan && plan.batchSeen && plan.batchSeen[lookId];

    if (r1) {
      // Resowed holes are observed under their pre-resow batch in R1.
      const initialBatch = specimen.originalBatch;
      addObservation('R1', specimen.originalTrayId, specimen.hole, r1, seen('R1') || initialBatch);
    }
    if (r2) {
      const list = Array.isArray(r2) ? r2 : [r2];
      for (const result of list) {
        addObservation('R2', specimen.originalTrayId, specimen.hole, result, seen('R2'));
      }
    }
  }

  // Destination-tray readings after a transfer.
  for (const mv of MOVE_IN_OBS) {
    const owner = specimens.find(
      (s) =>
        (s.specimenId === 'T-04-H03' && mv.trayId === 'T-07' && mv.hole === 3) ||
        (s.specimenId === 'T-05-H06' && mv.trayId === 'T-06' && mv.hole === 3),
    );
    if (owner) {
      const moved = transfers.find((t) => t.specimenId === owner.specimenId);
      addObservation(mv.lookId, mv.trayId, mv.hole, mv.result, owner.originalBatch, moved ? moved.reason : '');
    }
  }

  for (const extra of EXTRA_OBS) {
    addObservation(extra.lookId, extra.trayId, extra.hole, extra.result, null, extra.note);
  }

  // Stable ordering makes the generated record easy to diff / eyeball.
  observations.sort((a, b) =>
    a.lookId === b.lookId
      ? a.trayId === b.trayId
        ? a.hole - b.hole
        : a.trayId < b.trayId
          ? -1
          : 1
      : a.lookId < b.lookId
        ? -1
        : 1,
  );

  return {
    meta: {
      seed,
      site: '屏东育种站 3 号温室',
      generatedAt: '2026-11-21',
      description: '虚构的穴盘出芽随访记录，用于演示种植/换盘/观察的接入与统计。',
    },
    batches: BATCHES.map((b) => ({ ...b })),
    trays,
    looks: LOOKS.map((l) => ({ ...l })),
    specimens,
    plantings,
    transfers,
    discards: [
      {
        discardId: 'DC-01',
        trayId: DISCARD.trayId,
        date: DISCARD.date,
        reason: DISCARD.reason,
      },
    ],
    observations,
  };
}

module.exports = { buildDemo, LOOKS, HOLES_PER_TRAY, hashSeed, mulberry32 };
