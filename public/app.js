'use strict';

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  sprouted: '已出芽',
  'no-sprout': '未出芽',
  'not-observed': '未观察到',
  excluded: '不计入',
  contradictory: '记录矛盾',
};

const state = {
  stage: 'idle',
  first: null,
  archive: null,
};

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(rate) {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function showError(message) {
  const el = $('error');
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `请求失败（${res.status}）`);
    err.code = data.error && data.error.code;
    throw err;
  }
  return data;
}

// The evidence panel is what an operator diffs before/after a click.
function setEvidence(stage, report) {
  const el = $('evidence');
  const text = $('evidence-text');
  if (!report) {
    el.dataset.evidenceResult = 'stage=idle';
    text.textContent = '尚未运行。点击「生成第一版随访」开始。';
    return;
  }
  const look = report.byLook;
  const parts = look.map(
    (l) =>
      `${l.lookId} 已出芽=${l.sprouted} 未出芽=${l.noSprout} 未观察到=${l.notObserved} 不计入=${l.excluded} 矛盾=${l.contradictory} 分母=${l.evaluable} 出芽率=${pct(l.germRate)}`,
  );
  el.dataset.evidenceResult = `stage=${stage};looks=${look.length};${parts.join(' | ')}`;
  el.dataset.stage = stage;
  text.textContent = `${stage === 'archive' ? '补录后' : '第一版'}：${parts.join('；')}`;
}

function setStage(stage) {
  state.stage = stage;
  const badge = $('stage-badge');
  badge.dataset.stage = stage;
  badge.textContent =
    stage === 'idle' ? '尚未生成' : stage === 'first' ? '已生成第一版随访' : '已补录托盘清点';
  $('btn-archive').disabled = stage === 'idle';
}

function pill(status) {
  return `<span class="pill ${status}">${STATUS_TEXT[status] || status}</span>`;
}

function renderCards(report) {
  const last = report.byLook[report.byLook.length - 1];
  const cards = [
    ['随访轮次', String(report.byLook.length), report.byLook.map((l) => l.lookId).join(' → ')],
    ['已出芽', String(last.sprouted), `末轮 · 占可评估 ${last.evaluable}`],
    ['未出芽', String(last.noSprout), '确实看到该孔无芽'],
    ['未观察到', String(last.notObserved), '该轮无可用清点记录'],
    ['不计入', String(last.excluded), '换盘未回查 / 整盘废弃'],
    ['记录矛盾', String(last.contradictory), '同轮记录冲突，待复核'],
    ['末轮出芽率', pct(last.germRate), `分母 ${last.evaluable}（出芽+未出芽）`],
    ['补录后改变结论', String(report.changedCount), '第一版 → 补录'],
  ];
  $('summary-cards').innerHTML = cards
    .map(
      ([k, v, d]) => `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="d">${esc(d)}</div></div>`,
    )
    .join('');
}

function renderLookTable(report) {
  const head = `<thead><tr>
    <th>轮次</th><th>日期</th>
    <th class="num">已出芽</th><th class="num">未出芽</th><th class="num">未观察到</th>
    <th class="num">不计入</th><th class="num">矛盾</th>
    <th class="num">可评估分母</th><th class="num">出芽率</th>
  </tr></thead>`;
  const rows = report.byLook
    .map(
      (l) => `<tr>
      <td><strong>${esc(l.lookId)}</strong><div class="seg">${esc(l.label)}</div></td>
      <td class="mono">${esc(l.date)}</td>
      <td class="num">${l.sprouted}</td>
      <td class="num">${l.noSprout}</td>
      <td class="num">${l.notObserved}</td>
      <td class="num">${l.excluded}</td>
      <td class="num">${l.contradictory}</td>
      <td class="num"><strong>${l.evaluable}</strong></td>
      <td class="num">${pct(l.germRate)}</td>
    </tr>`,
    )
    .join('');
  $('look-table').innerHTML = head + `<tbody>${rows}</tbody>`;
}

function armCell(arm) {
  if (!arm) return '<span class="muted">—</span>';
  const rows = Object.entries(arm.perLook)
    .map(([lookId, cell]) => {
      const noRead = cell.notObserved + cell.excluded + cell.contradictory;
      return `<div class="seg"><strong>${esc(lookId)}</strong> ${cell.sprouted}/${cell.evaluable} · ${pct(
        cell.germRate,
      )}${noRead ? ` <span class="muted">（另有 ${cell.notObserved} 未观察到、${cell.excluded} 不计入、${cell.contradictory} 矛盾）</span>` : ''}</div>`;
    })
    .join('');
  return `<strong>${esc(arm.trayId)}</strong> <span class="muted">${esc(arm.trayLabel)}</span>${rows}`;
}

function renderPairTable(report) {
  const head = `<thead><tr><th>配对</th><th>对照盘</th><th>处理盘</th><th class="num">末轮差值（处理−对照）</th></tr></thead>`;
  const rows = report.byPair
    .map(
      (p) => `<tr>
      <td><strong>${esc(p.pairId)}</strong></td>
      <td>${armCell(p.control)}</td>
      <td>${armCell(p.treatment)}</td>
      <td class="num ${p.delta > 0 ? 'ok' : p.delta < 0 ? 'bad' : ''}">${
        p.delta === null ? '—' : `${(p.delta * 100).toFixed(1)} pt`
      }</td>
    </tr>`,
    )
    .join('');
  $('pair-table').innerHTML = head + `<tbody>${rows}</tbody>`;
}

function obsDetails(cell) {
  if (!cell.observations.length) return '<span class="muted">无记录</span>';
  const items = cell.observations
    .map(
      (o) =>
        `<li><span class="mono">${esc(o.obsId)}</span> ${o.result === 'sprouted' ? '出芽' : '未出芽'}${
          o.batchSeen ? ` · 记录批次 ${esc(o.batchSeen)}` : ''
        }${o.note ? ` · ${esc(o.note)}` : ''}${o.source === 'user' ? ' · 用户录入' : ''}</li>`,
    )
    .join('');
  return `<details class="obs"><summary>${cell.observations.length} 条记录</summary><ul>${items}</ul></details>`;
}

function renderSpecimenTable(report) {
  const looks = report.looks;
  const head = `<thead><tr>
    <th>样本</th><th>配对</th><th>批次</th>
    ${looks.map((l) => `<th>${esc(l.lookId)}<div class="seg">${esc(l.date)}</div></th>`).join('')}
    <th>首次出芽归属</th><th>位置 / 截断</th>
  </tr></thead>`;
  const rows = report.specimens
    .map((row) => {
      const cells = looks
        .map((l) => {
          const cell = row.looks[l.lookId];
          const batchMismatch = cell.observations.some((o) => o.batchSeen && cell.batchActive && o.batchSeen !== cell.batchActive);
          return `<td>
            ${pill(cell.status)}
            ${batchMismatch ? '<div class="seg warn">批次不符已纠正</div>' : ''}
            <div class="seg mono">${cell.trayId ? `${esc(cell.trayId)}/H${cell.hole}` : '—'}</div>
            ${cell.status === 'not-observed' && cell.reason ? `<div class="seg">${esc(cell.reason)}</div>` : ''}
            ${obsDetails(cell)}
          </td>`;
        })
        .join('');
      const sprout = row.firstSprout
        ? `<div class="mono">${esc(row.firstSprout.lookId)} · ${esc(row.firstSprout.batchId)}</div><div class="seg">${esc(
            row.firstSprout.batchLabel || '',
          )}</div>`
        : row.conclusionTo === 'contradictory'
          ? '<span class="warn">记录矛盾，待复核</span>'
          : row.conclusionTo === 'excluded'
            ? '<span class="muted">截断 / 废弃，不计入</span>'
            : '<span class="muted">未出芽</span>';
      const segs = row.segments
        .map(
          (s) =>
            `<div class="seg"><code>${esc(s.trayId)}/H${s.hole}</code> ${esc(s.start)} → ${s.end ? esc(s.end) : '现在'}${
              s.reason ? ` · ${esc(s.reason)}` : ''
            }</div>`,
        )
        .join('');
      const trunc = row.truncation
        ? `<div class="seg warn">${esc(row.truncation.message)}</div>`
        : '';
      return `<tr>
        <td><strong class="mono">${esc(row.specimenId)}</strong>${row.changed ? '<div class="seg ok">结论有变</div>' : ''}</td>
        <td>${esc(row.pair)}</td>
        <td class="mono">${esc(row.originalBatch)}</td>
        ${cells}
        <td>${sprout}</td>
        <td>${segs}${trunc}</td>
      </tr>`;
    })
    .join('');
  $('specimen-table').innerHTML = head + `<tbody>${rows}</tbody>`;
}

function renderChanges(report, stage) {
  const box = $('changes');
  const title = $('changes-title');
  if (stage !== 'archive') {
    title.hidden = true;
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  title.hidden = false;
  box.hidden = false;
  title.textContent = `补录后改变结论的样本（${report.changedCount}）`;
  if (!report.changeList.length) {
    box.innerHTML = '<p class="hint">本轮补录没有样本改变结论。</p>';
    return;
  }
  box.innerHTML = report.changeList
    .map(
      (c) => `<div class="change-item">
        <div class="top">
          <strong class="mono">${esc(c.specimenId)}</strong>
          <span class="muted">${esc(c.pair)}</span>
          ${pill(c.from)} <span class="arrow">→</span> ${pill(c.to)}
        </div>
        <p>${esc(c.note || '')}</p>
      </div>`,
    )
    .join('');
}

function renderDenominators(denom) {
  const root = $('denominator-root');
  root.hidden = false;

  const lookRows = denom.looks
    .map(
      (l) =>
        `<tr><td>${esc(l.lookId)}</td><td class="mono">${esc(l.date)}</td><td class="num">${l.sprouted}</td><td class="num">${l.noSprout}</td>
         <td class="num">${l.evaluable}</td><td class="num">${pct(l.germRate)}</td>
         <td class="num">${l.notObserved}</td><td class="num">${l.excluded}</td><td class="num">${l.contradictory}</td></tr>`,
    )
    .join('');

  const c = denom.cumulative;
  const cumRow = `<tr>
    <td><strong>累计</strong><div class="seg">每孔一次结论</div></td>
    <td class="mono">全部轮次</td>
    <td class="num">${c.sprouted}</td>
    <td class="num">${c.noSprout}</td>
    <td class="num"><strong>${c.evaluable}</strong></td>
    <td class="num">${pct(c.germRate)}</td>
    <td class="num">${c.notObserved}</td>
    <td class="num">${c.excluded}</td>
    <td class="num">${c.contradictory}</td>
  </tr>`;

  const list = (title, items, fmt) => {
    const body = items.length
      ? `<ul>${items.map((i) => `<li>${fmt(i)}</li>`).join('')}</ul>`
      : '<p class="hint">无</p>';
    return `<div class="denom-box"><h3>${esc(title)}（${items.length}）</h3>${body}</div>`;
  };

  $('denominator-body').innerHTML = `
    <p class="hint">${denom.stage === 'archive' ? '补录后口径' : '第一版口径（仅首轮）'}</p>
    <div class="table-wrap"><table>
      <thead><tr><th>轮次</th><th>日期</th><th class="num">已出芽</th><th class="num">未出芽</th>
      <th class="num">可评估分母</th><th class="num">出芽率</th>
      <th class="num">未观察到</th><th class="num">不计入</th><th class="num">矛盾</th></tr></thead>
      <tbody>${lookRows}${cumRow}</tbody>
    </table></div>
    <p class="hint" style="margin-top:8px">累计口径：出芽不可逆，一次出芽读数即定论；在出芽窗口关闭前被截断的孔退出分母，不按未出芽计。</p>
    <div class="denom-grid" style="margin-top:14px">
      ${list('未观察到（不进分母）', denom.notObserved, (i) => `<span class="mono">${esc(i.specimenId)}</span> · ${esc(i.lookId)} · ${esc(i.reason)}`)}
      ${list('不计入（换盘未回查 / 废弃）', denom.excluded, (i) => `<span class="mono">${esc(i.specimenId)}</span> · ${esc(i.lookId)} · ${esc(i.reason)}`)}
      ${list('记录矛盾（不进分子分母）', denom.contradictory, (i) => `<span class="mono">${esc(i.specimenId)}</span> · ${esc(i.lookId)} · ${esc(i.reason)}`)}
      ${list('首次出芽归属当时批次', denom.firstSprouts, (i) => `<span class="mono">${esc(i.specimenId)}</span> · ${esc(i.lookId)} · ${esc(i.batchId)}（${esc(i.batchLabel || '')}）`)}
      ${list('批次不符已纠正', denom.batchCorrections, (i) => `<span class="mono">${esc(i.specimenId)}</span> · ${esc(i.lookId)} · ${esc(i.message)}`)}
    </div>
    <h2>口径说明</h2>
    <ul>${denom.explanation.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
  `;
}

function renderAnomalies(report) {
  const root = $('anomaly-root');
  root.hidden = false;
  const head = `<thead><tr><th>代码</th><th>级别</th><th>涉及</th><th>说明</th></tr></thead>`;
  const rows = report.anomalies
    .map(
      (a) => `<tr>
      <td class="mono">${esc(a.code)}</td>
      <td class="${a.severity === 'error' ? 'bad' : a.severity === 'warning' ? 'warn' : 'muted'}">${esc(a.severity)}</td>
      <td class="mono">${esc(a.ref || '')}</td>
      <td>${esc(a.message)}</td>
    </tr>`,
    )
    .join('');
  $('anomaly-table').innerHTML = head + `<tbody>${rows || '<tr><td colspan="4" class="muted">无</td></tr>'}</tbody>`;
}

function renderReport(report, stage) {
  state.stage = stage;
  if (stage === 'first') state.first = report;
  else state.archive = report;

  $('report-root').hidden = false;
  renderCards(report);
  renderLookTable(report);
  renderPairTable(report);
  renderSpecimenTable(report);
  renderChanges(report, stage);
  renderAnomalies(report);
  setEvidence(stage, report);

  if (stage === 'archive' && state.first) {
    const before = state.first.byLook[0];
    const after = report.byLook[report.byLook.length - 1];
    $('changes-title').textContent = `补录后改变结论的样本（${report.changedCount}）· 首轮可评估 ${before.evaluable} → 补录后可评估 ${after.evaluable}`;
  }
}

async function onFirst() {
  showError('');
  setBusy(true);
  try {
    const data = await call('POST', '/api/followup/first', { seed: $('seed').value });
    setStage(data.stage);
    renderReport(data.report, data.stage);
    $('denominator-root').hidden = true;
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

async function onArchive() {
  showError('');
  setBusy(true);
  try {
    const data = await call('POST', '/api/archive', {});
    setStage(data.stage);
    renderReport(data.report, data.stage);
    $('denominator-root').hidden = true;
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

async function onDenominators() {
  showError('');
  setBusy(true);
  try {
    const data = await call('POST', '/api/denominators', {});
    renderDenominators(data.denominators);
    const current = data.stage === 'archive' ? state.archive : state.first;
    if (current) setEvidence(data.stage, current);
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

async function onReset() {
  showError('');
  setBusy(true);
  try {
    const data = await call('POST', '/api/session/reset', { seed: $('seed').value });
    state.first = null;
    state.archive = null;
    setStage('idle');
    setEvidence('idle', null);
    $('report-root').hidden = true;
    $('denominator-root').hidden = true;
    $('anomaly-root').hidden = true;
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  for (const id of ['btn-first', 'btn-archive', 'btn-denominators', 'reset']) {
    const el = $(id);
    if (el) el.disabled = busy || (id === 'btn-archive' && state.stage === 'idle');
  }
}

$('btn-first').addEventListener('click', onFirst);
$('btn-archive').addEventListener('click', onArchive);
$('btn-denominators').addEventListener('click', onDenominators);
$('reset').addEventListener('click', onReset);

setStage('idle');
setEvidence('idle', null);
