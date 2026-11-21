'use strict';

// ---------------------------------------------------------------------------
// reconcile(dataset) -> report
//
// Joins three independent streams:
//   plantings    what went into a hole, when, and under which seed batch
//   transfers    when a specimen physically changed tray/hole
//   observations what a census look saw at a tray/hole
//
// and produces, per specimen and per look:
//   - the derived status (sprouted / no-sprout / not-observed / excluded /
//     contradictory),
//   - the batch that a first sprout must belong to ("当时批次"),
//   - the point where a mid-follow-up tray change truncates the series.
//
// Statistics are then computed from those derived statuses, keeping
// "no-sprout" (observed, did not germinate) separate from "not-observed"
// (no usable census record) so the two never collapse into one another.
// ---------------------------------------------------------------------------

const SPROUTED = 'sprouted';
const NO_SPROUT = 'no-sprout';
const NOT_OBSERVED = 'not-observed';
const EXCLUDED = 'excluded';
const CONTRADICTORY = 'contradictory';

const STATUS_LABELS = {
  [SPROUTED]: '已出芽',
  [NO_SPROUT]: '未出芽',
  [NOT_OBSERVED]: '未观察到',
  [EXCLUDED]: '不计入（不可观察）',
  [CONTRADICTORY]: '记录互相矛盾',
};

function round4(n) {
  return n === null || n === undefined ? null : Math.round(n * 10000) / 10000;
}

function rate(n, d) {
  return d > 0 ? round4(n / d) : null;
}

function byDateThenId(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return suffix(a.obsId || a.plantingId || a.transferId) - suffix(b.obsId || b.plantingId || b.transferId);
}

function suffix(id) {
  const m = /(\d+)\s*$/.exec(String(id || ''));
  return m ? Number(m[1]) : 0;
}

function classifyStatus(results) {
  if (!results.length) return NOT_OBSERVED;
  const set = new Set(results);
  if (set.size > 1) return CONTRADICTORY;
  return set.has(SPROUTED) ? SPROUTED : NO_SPROUT;
}

// A specimen's verdict across a set of look cells, using one row per hole.
// Germination is irreversible, so one sprout reading settles the hole for good;
// a later no-sprout reading is a data reversal to review, not a new verdict.
// Censoring (tray discarded, or moved out and never rechecked) outranks
// no-sprout: the hole left observation before its germination window closed, so
// calling it "did not germinate" would understate it. It exits the denominator.
function verdictOf(cells, { censored = false } = {}) {
  if (cells.some((c) => c.status === SPROUTED)) return SPROUTED;
  if (cells.some((c) => c.status === CONTRADICTORY)) return CONTRADICTORY;
  if (censored) return EXCLUDED;
  if (cells.some((c) => c.status === NO_SPROUT)) return NO_SPROUT;
  return NOT_OBSERVED;
}

function reconcile(dataset) {
  const traysById = new Map(dataset.trays.map((t) => [t.id, t]));
  const batchesById = new Map(dataset.batches.map((b) => [b.id, b]));
  const looks = dataset.looks.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const observations = dataset.observations.slice().sort(byDateThenId);
  const transfers = dataset.transfers.slice().sort(byDateThenId);
  const plantings = dataset.plantings.slice().sort(byDateThenId);
  const discards = (dataset.discards || []).slice().sort(byDateThenId);
  const anomalies = [];
  const anomalySeen = new Set();
  const pushAnomaly = (a) => {
    const key = `${a.code}|${a.ref || ''}|${a.message}`;
    if (anomalySeen.has(key)) return;
    anomalySeen.add(key);
    anomalies.push(a);
  };

  // --- per-specimen location segments -------------------------------------
  const model = new Map();
  for (const specimen of dataset.specimens) {
    const moves = transfers.filter((t) => t.specimenId === specimen.specimenId);
    const segs = [];
    let cursor = {
      trayId: specimen.originalTrayId,
      hole: specimen.hole,
      start: '0000-00-00',
      startLabel: '初始',
      end: null,
      reason: null,
    };
    for (const mv of moves) {
      if (mv.fromTrayId !== cursor.trayId || mv.fromHole !== cursor.hole) {
        pushAnomaly({
          code: 'transfer-chain-mismatch',
          severity: 'error',
          ref: mv.transferId,
          specimenId: specimen.specimenId,
          message: `换盘记录 ${mv.transferId} 的起点 ${mv.fromTrayId}/H${mv.fromHole} 与当前所在 ${cursor.trayId}/H${cursor.hole} 不一致`,
        });
      }
      cursor.end = mv.date;
      cursor.reason = `换盘至 ${mv.toTrayId}/H${mv.toHole}`;
      segs.push(cursor);
      cursor = {
        trayId: mv.toTrayId,
        hole: mv.toHole,
        start: mv.date,
        startLabel: `换入 ${mv.toTrayId}/H${mv.toHole}`,
        end: null,
        reason: null,
        transferId: mv.transferId,
      };
    }
    const discard = discards.find((d) => d.trayId === cursor.trayId);
    if (discard) {
      cursor.end = discard.date;
      cursor.reason = `整盘废弃：${discard.reason}`;
    }
    segs.push(cursor);

    model.set(specimen.specimenId, {
      specimen,
      segments: segs,
      discard: discard || null,
      transfers: moves,
    });

    if (specimen.originalTrayId !== (moves[0] ? moves[0].fromTrayId : specimen.originalTrayId)) {
      pushAnomaly({
        code: 'transfer-origin-mismatch',
        severity: 'warning',
        ref: specimen.specimenId,
        specimenId: specimen.specimenId,
        message: `首个换盘记录的起点不是初始托盘 ${specimen.originalTrayId}`,
      });
    }
  }

  // Location on a date; transfer dates belong to the new tray.
  const locationAt = (specimenId, date, { ignoreDiscard = false } = {}) => {
    const m = model.get(specimenId);
    if (!m) return null;
    if (!ignoreDiscard && m.discard && m.discard.date <= date) return null;
    let current = null;
    for (const seg of m.segments) {
      if (seg.start <= date) current = seg;
    }
    return current ? { trayId: current.trayId, hole: current.hole } : null;
  };

  // Which batch is active in a hole on a date ("当时批次").
  const activeBatch = (specimenId, date) => {
    const list = plantings.filter((p) => p.specimenId === specimenId && p.date <= date);
    if (!list.length) return null;
    // Later date wins; ties are broken by stream order (the newest planting).
    return list[list.length - 1].batchId;
  };

  // --- attribute every observation to a specimen --------------------------
  const attributed = new Map(); // specimenId -> lookId -> [obs]
  const orphanObservations = [];
  for (const obs of observations) {
    const look = looks.find((l) => l.lookId === obs.lookId);
    const date = look ? look.date : obs.date;
    const matches = [];
    for (const [specimenId, m] of model) {
      const loc = locationAt(specimenId, date, { ignoreDiscard: true });
      if (loc && loc.trayId === obs.trayId && loc.hole === obs.hole) {
        matches.push({ specimenId, m });
      }
    }
    if (matches.length === 0) {
      const trayKnown = traysById.has(obs.trayId);
      const everThere = [...model.values()].some((m) =>
        m.segments.some((s) => s.trayId === obs.trayId && s.hole === obs.hole),
      );
      let subtype = 'unknown-location';
      let message = `观察 ${obs.obsId} 指向 ${obs.trayId}/H${obs.hole}，但该位置当日没有对应样本`;
      if (!trayKnown) {
        subtype = 'unknown-tray';
        message = `观察 ${obs.obsId} 指向不存在的托盘 ${obs.trayId}/H${obs.hole}`;
      } else if (!everThere) {
        subtype = 'empty-hole';
        message = `观察 ${obs.obsId} 指向空孔 ${obs.trayId}/H${obs.hole}（该孔从未登记种植）`;
      } else {
        const vacated = [...model.values()].find((m) =>
          m.transfers.some((t) => t.fromTrayId === obs.trayId && t.fromHole === obs.hole && t.date <= date),
        );
        const notYetOccupied = [...model.values()].find((m) =>
          m.transfers.some((t) => t.toTrayId === obs.trayId && t.toHole === obs.hole && t.date > date),
        );
        if (vacated) {
          subtype = 'vacated-location';
          message = `观察 ${obs.obsId} 抄在 ${obs.trayId}/H${obs.hole}，但该样本已于换盘日之后迁走`;
        } else if (notYetOccupied) {
          subtype = 'not-yet-occupied';
          message = `观察 ${obs.obsId} 抄在 ${obs.trayId}/H${obs.hole}，但该样本在清点日之后才换入这个孔位（当日为空孔）`;
        }
      }
      orphanObservations.push({ obs, subtype, message });
      pushAnomaly({
        code: 'orphan-observation',
        subtype,
        severity: 'warning',
        ref: obs.obsId,
        lookId: obs.lookId,
        trayId: obs.trayId,
        hole: obs.hole,
        message,
      });
      continue;
    }
    if (matches.length > 1) {
      pushAnomaly({
        code: 'ambiguous-location',
        severity: 'error',
        ref: obs.obsId,
        message: `观察 ${obs.obsId} 同时匹配多个样本：${matches.map((m) => m.specimenId).join(', ')}`,
      });
      continue;
    }
    const { specimenId, m } = matches[0];
    // An observation after the tray was discarded is stale, not evidence.
    if (m.discard && m.discard.date <= date) {
      pushAnomaly({
        code: 'after-discard',
        severity: 'warning',
        ref: obs.obsId,
        specimenId,
        lookId: obs.lookId,
        message: `观察 ${obs.obsId} 在 ${m.discard.date} 整盘废弃之后录入，已作废（${obs.trayId}/H${obs.hole}）`,
      });
      continue;
    }
    if (!attributed.has(specimenId)) attributed.set(specimenId, new Map());
    const byLook = attributed.get(specimenId);
    if (!byLook.has(obs.lookId)) byLook.set(obs.lookId, []);
    byLook.get(obs.lookId).push(obs);
  }

  // --- derive per-specimen / per-look status ------------------------------
  const specimenRows = [];
  for (const specimen of dataset.specimens) {
    const m = model.get(specimen.specimenId);
    const obsByLook = attributed.get(specimen.specimenId) || new Map();
    const looksOut = {};
    let firstSprout = null;

    for (const look of looks) {
      const date = look.date;
      const loc = locationAt(specimen.specimenId, date, { ignoreDiscard: true });
      const discarded = Boolean(m.discard && m.discard.date <= date);
      const list = (obsByLook.get(look.lookId) || []).slice().sort(byDateThenId);
      const results = list.map((o) => o.result);

      // Duplicates are explicit: report consistent repeats, flag conflicts.
      if (results.length > 1) {
        const distinct = new Set(results);
        pushAnomaly({
          code: distinct.size > 1 ? 'contradictory-observation' : 'duplicate-observation',
          severity: distinct.size > 1 ? 'warning' : 'info',
          ref: specimen.specimenId,
          specimenId: specimen.specimenId,
          lookId: look.lookId,
          message:
            distinct.size > 1
              ? `${specimen.specimenId} 在 ${look.lookId} 出现 ${results.length} 条互相矛盾的记录（${results.join(' / ')}）`
              : `${specimen.specimenId} 在 ${look.lookId} 有 ${results.length} 条重复记录，按一条计`,
        });
      }

      let status;
      let reason = null;
      if (discarded) {
        status = EXCLUDED;
        reason = `${m.discard.date} ${m.discard.reason}`;
      } else if (!loc) {
        status = EXCLUDED;
        reason = '当日没有可用位置';
      } else {
        status = classifyStatus(results);
        if (status === NOT_OBSERVED) {
          reason =
            list.length === 0
              ? `该轮没有 ${specimen.specimenId} 在 ${loc.trayId}/H${loc.hole} 的清点记录`
              : '观察记录无法归入该样本';
        } else if (status === CONTRADICTORY) {
          reason = `同一轮出现 ${results.length} 条互相矛盾的记录（${results.join(' / ')}）`;
        }
      }

      const batchActive = activeBatch(specimen.specimenId, date);
      let sproutBatch = null;
      if (status === SPROUTED || (status === CONTRADICTORY && results.includes(SPROUTED))) {
        sproutBatch = batchActive;
        for (const obs of list) {
          if (obs.result !== SPROUTED) continue;
          if (obs.batchSeen && batchActive && obs.batchSeen !== batchActive) {
            pushAnomaly({
              code: 'batch-mismatch',
              severity: 'warning',
              ref: obs.obsId,
              specimenId: specimen.specimenId,
              lookId: look.lookId,
              message: `${specimen.specimenId} 在 ${look.lookId} 记录为 ${obs.batchSeen} 出芽，但该时点种植批次是 ${batchActive}；出芽应归 ${batchActive}`,
            });
          }
        }
      }

      // A contradictory cell is unresolved: it may not create a first-sprout
      // attribution, because that would silently pick one of the two records.
      if (status === SPROUTED && !firstSprout) {
        firstSprout = {
          lookId: look.lookId,
          date,
          observedAt: loc ? `${loc.trayId}/H${loc.hole}` : null,
          batchId: sproutBatch,
          batchLabel: sproutBatch && batchesById.has(sproutBatch) ? batchesById.get(sproutBatch).label : null,
        };
      }

      looksOut[look.lookId] = {
        lookId: look.lookId,
        date,
        label: look.label,
        trayId: loc ? loc.trayId : null,
        hole: loc ? loc.hole : null,
        discarded,
        status,
        reason,
        statusLabel: discarded ? `不计入（${m.discard.date} 废弃）` : STATUS_LABELS[status],
        observations: list.map((o) => ({
          obsId: o.obsId,
          result: o.result,
          batchSeen: o.batchSeen,
          note: o.note || '',
          source: o.source || 'demo',
        })),
        batchActive,
        batchActiveLabel: batchActive && batchesById.has(batchActive) ? batchesById.get(batchActive).label : null,
        sproutBatch,
      };
    }

    // Censoring: where the follow-up series stops being reliable.
    let truncation = null;
    if (m.discard) {
      truncation = {
        kind: 'discard',
        date: m.discard.date,
        message: `${m.discard.date} ${m.discard.reason}，该托盘此后的孔位不再进入观察分母。`,
      };
    } else if (m.transfers.length) {
      const last = m.transfers[m.transfers.length - 1];
      const afterLooks = looks.filter((l) => l.date > last.date);
      const rechecked = afterLooks.some((l) => looksOut[l.lookId].status !== NOT_OBSERVED);
      truncation = {
        kind: 'transfer',
        date: last.date,
        message: `${last.date} 由 ${last.fromTrayId}/H${last.fromHole} 换到 ${last.toTrayId}/H${last.toHole}；旧盘孔位的观察序列在换盘日截断${
          rechecked ? '，之后按新盘孔位续接' : '，新盘尚未回查，随访在此中断'
        }。`,
        rechecked,
      };
    }

    // A truncated series cannot be judged as "did not germinate". Censoring
    // only applies to looks on or after the truncation date: the first version,
    // read before the move/discard, is allowed to keep its original reading.
    const censors = (onDate) =>
      Boolean(
        truncation &&
          truncation.date <= onDate &&
          (truncation.kind === 'discard' || !truncation.rechecked),
      );

    const order = looks.map((l) => l.lookId);
    const lookDates = looks.map((l) => l.date);
    // Conclusion at each point in time, using only the looks up to then.
    const conclusionAt = order.map((_, i) =>
      verdictOf(
        order.slice(0, i + 1).map((lookId) => looksOut[lookId]),
        { censored: censors(lookDates[i]) },
      ),
    );
    const conclusionFrom = order.length ? conclusionAt[0] : null;
    const conclusionTo = order.length ? conclusionAt[conclusionAt.length - 1] : null;
    const changed = Boolean(order.length > 1 && conclusionFrom !== conclusionTo);

    specimenRows.push({
      specimenId: specimen.specimenId,
      pair: traysById.get(specimen.originalTrayId).pair,
      originalTrayId: specimen.originalTrayId,
      hole: specimen.hole,
      originalBatch: specimen.originalBatch,
      batchLabel: batchesById.get(specimen.originalBatch).label,
      segments: m.segments.map((s) => ({
        trayId: s.trayId,
        hole: s.hole,
        start: s.start === '0000-00-00' ? '初始' : s.start,
        end: s.end,
        reason: s.reason,
      })),
      truncation,
      looks: looksOut,
      conclusionFrom,
      conclusionTo,
      changed,
      changeNote: changed ? describeChange(conclusionFrom, conclusionTo, truncation, looksOut[order[order.length - 1]]) : null,
      firstSprout,
    });
  }

  // --- statistics ---------------------------------------------------------
  const byLook = looks.map((look) => {
    const bucket = {
      lookId: look.lookId,
      date: look.date,
      label: look.label,
      sprouted: 0,
      noSprout: 0,
      notObserved: 0,
      excluded: 0,
      contradictory: 0,
    };
    for (const row of specimenRows) {
      const cell = row.looks[look.lookId];
      if (cell.status === SPROUTED) bucket.sprouted += 1;
      else if (cell.status === NO_SPROUT) bucket.noSprout += 1;
      else if (cell.status === NOT_OBSERVED) bucket.notObserved += 1;
      else if (cell.status === EXCLUDED) bucket.excluded += 1;
      else if (cell.status === CONTRADICTORY) bucket.contradictory += 1;
    }
    bucket.evaluable = bucket.sprouted + bucket.noSprout;
    bucket.germRate = rate(bucket.sprouted, bucket.evaluable);
    return bucket;
  });

  // One row per hole across all looks. Germination is irreversible, so a sprout
  // reading settles the hole; a hole that left observation before closing its
  // germination window exits the denominator instead of counting as no-sprout.
  const cumulative = {
    sown: specimenRows.length,
    sprouted: 0,
    noSprout: 0,
    notObserved: 0,
    excluded: 0,
    contradictory: 0,
  };
  for (const row of specimenRows) {
    const cells = Object.values(row.looks);
    const censored = Boolean(row.truncation && (row.truncation.kind === 'discard' || !row.truncation.rechecked));
    const verdict = verdictOf(cells, { censored });
    if (verdict === SPROUTED) cumulative.sprouted += 1;
    else if (verdict === CONTRADICTORY) cumulative.contradictory += 1;
    else if (verdict === NO_SPROUT) cumulative.noSprout += 1;
    else if (verdict === EXCLUDED) cumulative.excluded += 1;
    else cumulative.notObserved += 1;
  }
  cumulative.evaluable = cumulative.sprouted + cumulative.noSprout;
  cumulative.germRate = rate(cumulative.sprouted, cumulative.evaluable);

  const pairIds = [...new Set(dataset.trays.map((t) => t.pair))].sort();
  const byPair = pairIds.map((pairId) => {
    const pairTrays = dataset.trays.filter((t) => t.pair === pairId);
    const control = pairTrays.find((t) => t.role === 'control') || pairTrays[0];
    const treatment = pairTrays.find((t) => t.role === 'treatment') || pairTrays[1];
    const arm = (tray) => {
      if (!tray) return null;
      const rows = specimenRows.filter((r) => r.originalTrayId === tray.id);
      const perLook = {};
      for (const look of looks) {
        let sprouted = 0;
        let noSprout = 0;
        let notObserved = 0;
        let excluded = 0;
        let contradictory = 0;
        for (const row of rows) {
          const cell = row.looks[look.lookId];
          if (cell.status === SPROUTED) sprouted += 1;
          else if (cell.status === NO_SPROUT) noSprout += 1;
          else if (cell.status === NOT_OBSERVED) notObserved += 1;
          else if (cell.status === EXCLUDED) excluded += 1;
          else if (cell.status === CONTRADICTORY) contradictory += 1;
        }
        const evaluable = sprouted + noSprout;
        perLook[look.lookId] = {
          sprouted,
          noSprout,
          notObserved,
          excluded,
          contradictory,
          evaluable,
          germRate: rate(sprouted, evaluable),
        };
      }
      const final = perLook[looks[looks.length - 1].lookId];
      return {
        trayId: tray.id,
        trayLabel: tray.label,
        batch: tray.batch,
        holes: rows.length,
        perLook,
        final,
      };
    };
    const c = arm(control);
    const t = arm(treatment);
    const delta =
      c && t && c.final.germRate !== null && t.final.germRate !== null
        ? round4(t.final.germRate - c.final.germRate)
        : null;
    return { pairId, control: c, treatment: t, delta };
  });

  const changeList = specimenRows
    .filter((r) => r.changed)
    .map((r) => ({
      specimenId: r.specimenId,
      pair: r.pair,
      from: r.conclusionFrom,
      to: r.conclusionTo,
      fromLabel: STATUS_LABELS[r.conclusionFrom],
      toLabel: STATUS_LABELS[r.conclusionTo],
      note: r.changeNote,
    }));

  const anomalyCounts = {};
  for (const a of anomalies) anomalyCounts[a.code] = (anomalyCounts[a.code] || 0) + 1;

  return {
    meta: dataset.meta,
    looks,
    batches: dataset.batches,
    trays: dataset.trays,
    counts: {
      specimens: dataset.specimens.length,
      plantings: dataset.plantings.length,
      transfers: dataset.transfers.length,
      observations: dataset.observations.length,
      discards: dataset.discards.length,
    },
    byLook,
    byPair,
    cumulative,
    changeList,
    changedCount: changeList.length,
    specimens: specimenRows,
    anomalies,
    anomalyCounts,
    orphans: orphanObservations.map((o) => ({ obsId: o.obs.obsId, subtype: o.subtype, message: o.message })),
    labels: STATUS_LABELS,
  };
}

function describeChange(from, to, truncation, lastCell) {
  if (from === NOT_OBSERVED && to === SPROUTED) {
    return '首轮没有可用观察；补录清点后确认出芽，该样本从“未观察到”变为“已出芽”。';
  }
  if (from === NOT_OBSERVED && to === NO_SPROUT) {
    return '首轮没有可用观察；补录清点确认未出芽。';
  }
  if (from === NO_SPROUT && to === SPROUTED) {
    return lastCell && lastCell.observations.some((o) => o.batchSeen)
      ? '补录后观察到出芽，按出芽当时的种植批次归属。'
      : '补录后观察到出芽。';
  }
  if (from === SPROUTED && to === NO_SPROUT) {
    return '首轮记为出芽，补录记录为未出芽，需要人工复核。';
  }
  if (to === CONTRADICTORY) {
    return '同一轮出现互相矛盾的记录，人工复核前不计入出芽分子。';
  }
  if (to === EXCLUDED) {
    return truncation ? truncation.message : '该样本在补录时已不可观察，退出分母。';
  }
  return '结论在首轮与补录之间发生变化。';
}

module.exports = {
  reconcile,
  STATUS_LABELS,
  SPROUTED,
  NO_SPROUT,
  NOT_OBSERVED,
  EXCLUDED,
  CONTRADICTORY,
};
