// 设计规范手册前端：交互比较颜色/字号/图标/表单状态，展示解析链/覆盖优先级/报告/确认
const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'request failed'), { data, status: res.status });
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let scopes = [], themes = [], expansions = {}, components = [];

const isColor = (v) => /^(#|rgb)/.test(String(v));
const isPx = (v) => /px$/.test(String(v));
const refCount = (t) => (t.trace || []).filter((x) => x.value.includes('{')).length;

function swatch(t) {
  if (!t || t.value == null) return '<span class="diff-miss">无法解析</span>';
  if (t.type === 'color' || isColor(t.value)) {
    return `<span class="swatch" title="${esc(t.source)}｜原始: ${esc(t.trace?.[0]?.value)}">
      <span class="chip" style="background:${esc(t.value)}"></span>${esc(t.value)}
      ${t.source && t.source !== t.name ? `<span class="alias" title="定义来源">@${esc(t.source)}</span>` : ''}
    </span>`;
  }
  return esc(t.value) + (t.source ? ` <span class="alias">@${esc(t.source)}</span>` : '');
}

async function loadAll() {
  scopes = await api('/api/scopes');
  themes = scopes.filter((s) => s.kind === 'theme');
  components = await api('/api/components');

  for (const id of ['themeA', 'themeB', 'resolveScope', 'shotTheme']) {
    const sel = $('#' + id);
    sel.innerHTML = scopes.filter((s) => id === 'resolveScope' || s.kind === 'theme')
      .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  }
  $('#themeA').value = 'theme/light';
  $('#themeB').value = 'theme/dark';
  $('#resolveScope').value = 'theme/dark';
  $('#shotTheme').value = 'theme/dark';
  $('#shotComponent').innerHTML = components.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');

  await refreshExpansions();
  renderTypes();
  renderCompare();
  renderComponents();
  renderShots();
  renderConfirmations();
  renderVersions();
}

async function refreshExpansions() {
  const a = $('#themeA').value, b = $('#themeB').value;
  expansions = {};
  for (const id of [...new Set([a, b])]) {
    expansions[id] = await api('/api/expand/' + encodeURIComponent(id));
  }
  $('#cacheHint').textContent = `A cached=${expansions[a]?.cached} · B cached=${expansions[b]?.cached}`;
}

function renderTypes() {
  const types = new Set();
  for (const e of Object.values(expansions)) for (const t of e.tokens) types.add(t.type);
  $('#typeFilter').innerHTML = '<option value="">全部类型</option>' +
    [...types].sort().map((t) => `<option>${t}</option>`).join('');
}

function tokenMap(exp) {
  const m = new Map();
  for (const t of exp.tokens) m.set(t.name, t);
  return m;
}

function diffKind(a, b) {
  if (!a || !b) return { cls: 'diff-miss', text: !a && !b ? '两边缺失' : (!a ? 'A 缺失（覆盖漏项线索）' : 'B 缺失（覆盖漏项线索）') };
  if (a.value === b.value) return { cls: 'diff-same', text: '相同' };
  let extra = '';
  if (a.type === 'color') {
    const r = contrastForPair(a.value, b.value);
    extra = ` · 互相作为前景/背景时对比 ${r.toFixed(2)}:1`;
  }
  return { cls: 'diff-val', text: '值不同' + extra };
}

function contrastForPair(fg, bg) {
  // 与后端同口径的简化版，仅用于提示；权威以后端报告为准
  const lum = (hex) => {
    const c = hex.replace('#', '');
    const v = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
    const chan = (i) => {
      let n = parseInt(v.slice(i, i + 2), 16) / 255;
      return n <= 0.03928 ? n / 12.92 : Math.pow((n + .055) / 1.055, 2.4);
    };
    return .2126 * chan(0) + .7152 * chan(2) + .0722 * chan(4);
  };
  try {
    const l1 = lum(fg), l2 = lum(bg);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + .05) / (lo + .05);
  } catch { return 0; }
}

async function renderCompare() {
  const q = $('#filter').value.trim().toLowerCase();
  const type = $('#typeFilter').value;
  const ma = tokenMap(expansions[$('#themeA').value]);
  const mb = tokenMap(expansions[$('#themeB').value]);
  const names = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  const rows = names.filter((n) => (!q || n.includes(q)) && (!type || ma.get(n)?.type === type || mb.get(n)?.type === type));
  $('#compareBody').innerHTML = rows.map((name) => {
    const a = ma.get(name), b = mb.get(name);
    const d = diffKind(a, b);
    const typ = a?.type || b?.type || '';
    const chain = a?.trace || b?.trace || [];
    return `<tr>
      <td><strong>${esc(name)}</strong>${chain.some((x) => x.value.includes('{')) ? ' 🔗' : ''}
        <div class="kv">${esc((a ?? b).source)}${(a ?? b).overrides?.length ? ' · 覆盖 ' + (a ?? b).overrides.length + ' 层' : ''}</div>
      </td>
      <td>${esc(typ)}</td>
      <td>${swatch(a)}</td>
      <td>${swatch(b)}</td>
      <td class="${d.cls}">${esc(d.text)}</td>
    </tr>`;
  }).join('');
}

// ---------- 组件 × 状态 ----------
function renderComponents() {
  const themeId = $('#themeB').value; // 预览以 B 为准
  const exp = expansions[themeId];
  if (!exp) return;
  const byName = tokenMap(exp);
  $('#componentList').innerHTML = components.map((c) => {
    const usages = (c.usages || []).map((u) => {
      const text = byName.get(u.slots.text?.token);
      const bg = byName.get(u.slots.background?.token);
      const fontSize = byName.get(u.slots.fontSize?.token);
      const disabled = u.state === 'disabled';
      const ratio = (text && bg) ? contrastForPair(text.value, bg.value) : null;
      const iconTok = u.icon
        ? (u.icon.color === 'currentColor' ? text : byName.get(u.icon.color))
        : null;
      return `<div class="card" style="background:#0b1220">
        <div class="demo" style="background:${esc(bg?.value || '#1f2937')}; color:${esc(text?.value || '#e5e7eb')};
             font-size:${esc(fontSize?.value || '14px')}; ${disabled ? 'opacity:.55' : ''}">
          ${u.icon ? iconGlyph(u.icon.name, iconTok?.value || text?.value) : ''}
          <span style="margin-left:6px">${esc(u.label || u.id)}</span>
        </div>
        <div class="states">
          <span class="state-tag">state=${esc(u.state)}</span>
          ${fontSize ? `<span class="state-tag">${esc(fontSize.value)}</span>` : ''}
          ${ratio != null && !disabled ? `<span class="state-tag ${ratio >= 4.5 ? 'diff-same' : 'diff-miss'}">对比 ${ratio.toFixed(2)}:1 ${ratio >= 4.5 ? 'AA✓' : 'AA✗'}</span>` : ''}
          ${disabled ? '<span class="state-tag hint">disabled 豁免·不计合格</span>' : ''}
        </div>
        <div class="kv" style="margin-top:6px">
          text=${esc(u.slots.text?.token || '—')} · bg=${esc(u.slots.background?.token || '—')}
          ${u.icon ? ` · icon=${esc(u.icon.color)}` : ''}
        </div>
      </div>`;
    }).join('');
    const legacy = c.supportedTokenVersion;
    return `<div class="card">
      <h4>${esc(c.name)} <span class="badge info">支持令牌 v${legacy}</span></h4>
      <p class="kv">${esc(c.description).replace(/\{([^}]+)\}/g, '<span class="pill" style="background:#0b1220">$1</span>')}</p>
      <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">${usages}</div>
    </div>`;
  }).join('');
}

function iconGlyph(name, color) {
  const map = {
    'chevron-down': 'M4 6l8 8 8-8',
    x: 'M6 6l12 12 M18 6L6 18',
    circle: 'M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0'
  };
  const d = map[name] || map.circle;
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${esc(color || 'currentColor')}"
    stroke-width="2" stroke-linecap="round"><path d="${d}"/></svg>`;
}

// ---------- 解析解释 ----------
async function doResolve() {
  const scope = $('#resolveScope').value;
  const name = $('#resolveName').value.trim();
  const res = await api(`/api/resolve?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`);
  if (!res.ok) {
    $('#resolveOut').textContent = `❌ ${res.error}: ${res.detail}`;
    return;
  }
  const lines = [];
  lines.push(`解析值: ${res.value} (${res.type})`);
  lines.push(`请求 scope: ${scope}`);
  lines.push('');
  lines.push('解析链（近→远，含覆盖优先级解释）:');
  res.trace.forEach((t, i) => {
    lines.push(`  ${i + 1}. ${t.name}`);
    lines.push(`     命中 scope : ${t.scope}  ← 胜出处`);
    lines.push(`     原始定义   : ${t.value}`);
    lines.push(`     解析结果   : ${t.resolved}`);
    if (t.shadows?.length) {
      lines.push(`     被遮蔽候选 :`);
      t.shadows.forEach((s) => lines.push(`        · ${s.scope} = ${s.value}（优先级更低，仅当上层未覆盖时生效）`));
    }
  });
  $('#resolveOut').textContent = lines.join('\n');
}

// ---------- 报告 ----------
async function runReport() {
  const r = await api('/api/reports', { method: 'POST', body: {} });
  renderReport(r);
}
function renderReport(r) {
  const s = r.summary;
  $('#reportSummary').innerHTML = `<div class="card">
    <h4>报告 ${esc(r.id)} · ${esc(s.generatedAt)}</h4>
    <p class="kv">主题 ${s.themesChecked} · 组件 ${s.componentsChecked} · 令牌版 v${s.tokenVersion}</p>
    <p>
      <span class="badge error">error ${s.errors}</span>
      <span class="badge warning">warning ${s.warnings}</span>
      <span class="badge info">info ${s.infos}</span>
    </p>
    <p class="kv">实际检查状态（不含禁用）: ${s.usageChecked}，通过 ${s.usagePass}
      （通过率 ${s.usagePassRate ?? '—'}）；禁用示例已排除 ${s.usageDisabledExcluded} 个，未计入合格演示。</p>
    <p class="kv">合格 组件×主题: ${s.compliantComponentThemePairs}/${s.componentThemePairs}
      （只在全部非禁用状态通过时计合格）</p>
  </div>`;
  const order = { error: 0, warning: 1, info: 2 };
  const fs = [...r.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  $('#reportFindings').innerHTML = fs.map((f) => `
    <div class="finding ${f.severity}">
      <span class="badge ${f.severity}">${esc(f.code)}</span>
      ${esc(f.message)}
      <div class="kv">${esc([f.component, f.theme, f.state, f.target, f.token].filter(Boolean).join(' · '))}</div>
      ${f.ratio != null ? `<div class="kv">实测对比 ${Number(f.ratio).toFixed(2)}:1，要求 ≥ ${f.required}:1
        （fg=${esc(f.fg)} bg=${esc(f.bg)}；胜出来源 ${esc(f.source)}）</div>` : ''}
    </div>`).join('');
}

// ---------- 截图 ----------
async function startShot(failAtFrame) {
  const body = { componentId: $('#shotComponent').value, theme: $('#shotTheme').value };
  if (failAtFrame !== undefined) body.failAtFrame = failAtFrame;
  try {
    await api('/api/shots', { method: 'POST', body });
  } catch (e) { alert(e.message); }
  renderShots();
}

async function renderShots() {
  const shots = await api('/api/shots');
  $('#shots').innerHTML = shots.map((j) => {
    const done = j.status === 'completed';
    return `<div class="card">
      <h4>${esc(j.id)} <span class="badge ${done ? 'ok' : j.status === 'interrupted' ? 'error' : 'warning'}">${esc(j.status)}</span></h4>
      <p class="kv">${esc(j.componentId)} · ${esc(j.theme)} · 令牌 v${j.tokenVersion} · 帧 ${j.framesDone}/${j.framesTotal}</p>
      ${done ? `<img class="shot" src="/api/shots/${encodeURIComponent(j.id)}/image.svg?x=${Date.now()}" />` : ''}
      ${j.error ? `<p class="kv diff-miss">${esc(j.error)}</p>` : ''}
      <div class="row-actions">
        ${j.status === 'running' ? `<button onclick="actShot('${esc(j.id)}','interrupt')">中断</button>` : ''}
        ${j.status === 'interrupted' ? `<button onclick="actShot('${esc(j.id)}','resume')">从第 ${j.framesDone} 帧续跑</button>` : ''}
        ${done ? `<button onclick="confirmShot('${esc(j.id)}','${esc(j.componentId)}','${esc(j.theme)}')">设计师确认</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

window.actShot = async (id, action) => {
  await api(`/api/shots/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
  renderShots();
};
window.confirmShot = async (shotId, componentId, theme) => {
  try {
    await api('/api/confirmations', { method: 'POST', body: { shotId, componentId, theme } });
    alert('已确认（绑定截图 ' + shotId + ' 与当前令牌版）');
  } catch (e) { alert('确认被拒绝: ' + e.message); }
  renderConfirmations();
};

async function renderConfirmations() {
  const list = await api('/api/confirmations');
  $('#confirmations').innerHTML = list.map((c) => `
    <div class="card">
      <h4>${esc(c.componentId)} · ${esc(c.theme)}
        <span class="badge ${c.status === 'confirmed' ? 'ok' : 'warning'}">${c.status === 'confirmed' ? '已确认' : '待复查'}</span></h4>
      <p class="kv">截图 ${esc(c.shotId)} · 令牌 v${c.tokenVersion} · 确认人 ${esc(c.confirmedBy)}</p>
      ${c.invalidatedAt ? `<p class="kv diff-val">上游令牌于 ${esc(c.invalidatedAt)} 变更，确认自动失效，需基于新截图复查</p>` : ''}
    </div>`).join('') || '<p class="hint">暂无确认</p>';
}

// ---------- 版本 ----------
async function renderVersions() {
  const list = await api('/api/versions');
  $('#versions').innerHTML = list.map((v) => `
    <div class="card">
      <h4>${esc(v.label)} <span class="badge info">#${v.number}</span></h4>
      <p class="kv">${v.tokens.length} 个令牌定义 · ${v.components.length} 个组件依赖 · ${esc(v.createdAt)}</p>
    </div>`).join('') || '<p class="hint">尚未固化版本</p>';
}

// ---------- events ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $('#tab-' + b.dataset.tab).classList.add('active');
}));
$('#themeA').addEventListener('change', async () => { await refreshExpansions(); renderTypes(); renderCompare(); renderComponents(); });
$('#themeB').addEventListener('change', same);
async function same() { await refreshExpansions(); renderTypes(); renderCompare(); renderComponents(); }
$('#filter').addEventListener('input', renderCompare);
$('#typeFilter').addEventListener('change', renderCompare);
$('#btnReport').addEventListener('click', runReport);
$('#btnResolve').addEventListener('click', doResolve);
$('#btnShot').addEventListener('click', () => startShot());
$('#btnShotFail').addEventListener('click', () => startShot(2));
$('#btnVersion').addEventListener('click', async () => {
  await api('/api/versions', { method: 'POST', body: { label: $('#versionLabel').value || undefined } });
  renderVersions();
});

loadAll().catch((e) => alert('初始化失败: ' + e.message));
