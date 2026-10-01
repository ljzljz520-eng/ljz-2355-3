/* Interactive design guide: every figure, swatch and description shown here is
   derived from API responses (resolved tokens / real state contrast), so the
   explanatory text always matches the running example. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.detail?.message || res.statusText),
    { detail: data.detail, status: res.status });
  return data;
};
const post = (path, body) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (path, body) => api(path, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const state = { themes: [], components: [], currentTheme: 'light', expansions: {}, reportId: null };

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.className = '', 4200);
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isColor = v => /^(#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\()/i.test(String(v ?? ''));

/* ---------------- tabs ---------------- */
$$('#tabs button').forEach(b => b.addEventListener('click', () => {
  $$('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.tab === b.dataset.tab));
  if (b.dataset.tab === 'report') loadReport();
  if (b.dataset.tab === 'colors') loadMatrix();
  if (b.dataset.tab === 'typography') loadTypography();
  if (b.dataset.tab === 'components') loadComponents();
  if (b.dataset.tab === 'screenshots') loadScreenshots();
}));

/* ---------------- boot ---------------- */
async function boot() {
  const [themes, comps] = await Promise.all([api('/api/themes'), api('/api/components')]);
  state.themes = themes; state.components = comps;
  const opts = themes.map(t => `<option value="${t.slug}">${esc(t.name)} (${t.slug})</option>`).join('');
  $('#themeSelect').innerHTML = opts;
  $('#updTheme').innerHTML = themes.map(t => `<option value="${t.slug}">${t.slug}</option>`).join('');
  $('#exTheme').innerHTML = themes.map(t => `<option value="${t.slug}">${t.slug}</option>`).join('');
  $('#exComp').innerHTML = comps.map(c => `<option value="${c.slug}">${esc(c.name)}</option>`).join('');
  $('#themeSelect').value = state.currentTheme;
  $('#themeSelect').addEventListener('change', e => { state.currentTheme = e.target.value; loadTokens(); });
  $('#updTheme').value = 'base';
  $('#exComp').value = 'input-field';
  bindStatic();
  await Promise.all([loadTokens(), loadInheritance(), refreshCache(), fillExportStates()]);
}

function bindStatic() {
  $('#tokenSearch').addEventListener('input', renderTokens);
  $('#showCyclesOnly').addEventListener('change', renderTokens);
  $('#closeTokenDetail').addEventListener('click', () => $('#tokenDetailCard').hidden = true);
  $('#invalidateBtn').addEventListener('click', async () => {
    await post('/api/cache/invalidate', {}); await refreshCache(); toast('缓存已全部失效');
  });
  $('#updBtn').addEventListener('click', doUpdate);
  $('#runReportBtn').addEventListener('click', () => { switchTab('report'); runReport(); });
  $('#addPair').addEventListener('click', () => addPair('#1d4ed8', '#ffffff'));
  $('#cmpScale').addEventListener('change', () => $$('#compareRows .pair-row').forEach(r => evaluatePair(r)));
  $('#exportBtn').addEventListener('click', doExport);
  $('#exComp').addEventListener('change', fillExportStates);
}
function switchTab(name) { $(`#tabs button[data-tab="${name}"]`).click(); }

/* ---------------- inheritance ---------------- */
async function loadInheritance() {
  const g = await api('/api/inheritance');
  const parentMap = Object.fromEntries(g.edges.map(e => [e.to, e.from]));
  const children = {};
  g.nodes.forEach(n => { if (n.parent) (children[n.parent] ||= []).push(n.slug); });
  const cyclic = new Set(state.themes.filter(t => (t.cycles || []).length).map(t => t.slug));
  const roots = g.nodes.filter(n => !n.parent).map(n => n.slug);
  const renderNode = (slug, depth) => {
    const node = g.nodes.find(n => n.slug === slug);
    const isCycle = cyclic.has(slug);
    const leaf = !children[slug]?.length;
    return `<div style="margin-left:${depth * 24}px">
      ${depth ? '<div class="edge">↳ 继承 / 覆盖</div>' : ''}
      <span class="node ${isCycle ? 'cycle' : ''}">
        <b>${esc(node.name)}</b> <span class="mono">${slug}</span>
        ${isCycle ? '<span class="badge cycle">别名环</span>' : ''}
        ${leaf ? '<span class="badge leaf">叶子主题</span>' : ''}
      </span>
      ${(children[slug] || []).map(c => renderNode(c, depth + 1)).join('')}
    </div>`;
  };
  $('#inheritanceGraph').innerHTML = roots.map(r => renderNode(r, 0)).join('');
}

/* ---------------- tokens ---------------- */
async function loadTokens() {
  $('#tokenTitle').textContent = `令牌（静态展开）· ${state.currentTheme}`;
  const exp = await api(`/api/themes/${state.currentTheme}/expand`);
  state.expansions[state.currentTheme] = exp;
  renderTokens();
  refreshCache();
}
function renderTokens() {
  const exp = state.expansions[state.currentTheme];
  if (!exp) return;
  const q = $('#tokenSearch').value.trim().toLowerCase();
  const onlyCycle = $('#showCyclesOnly').checked;
  const rows = Object.values(exp.tokens)
    .filter(n => !q || n.path.toLowerCase().includes(q))
    .filter(n => !onlyCycle || n.in_cycle)
    .sort((a, b) => a.path.localeCompare(b.path));
  $('#tokenList').innerHTML = rows.map(n => {
    const kind = n.in_cycle ? 'cycle' : (n.references.length ? 'alias'
      : (n.resolved ? 'literal' : 'unresolved'));
    const swatch = isColor(n.value) ? `<span class="swatch" style="background:${esc(n.value)}"></span>` : '';
    return `<div class="token-row" data-path="${esc(n.path)}">
      <span class="tpath">${esc(n.path)}</span>
      <span>${swatch}<span class="tval">${esc(n.in_cycle ? '⟳ ' + n.raw_value : n.value)}</span></span>
      <span class="win">${esc((n.winner || {}).theme_slug || '-')}${n.overridden_in.length ? ' ⇐ ' + n.overridden_in.join(',') : ''}</span>
      <span class="pill ${kind}">${{ literal: '字面值', alias: '别名', cycle: '环', unresolved: '未解析' }[kind]}</span>
    </div>`;
  }).join('') || '<p style="padding:12px">无匹配令牌</p>';
  $$('#tokenList .token-row').forEach(r =>
    r.addEventListener('click', () => showTokenDetail(r.dataset.path)));
}
async function showTokenDetail(path) {
  const d = await api(`/api/themes/${state.currentTheme}/tokens/${path}`);
  const chain = d.override_priority.map(s => {
    const isWinner = s === d.winner?.theme_slug;
    return `<span class="layer ${isWinner ? 'winner' : 'shadowed'}" title="${isWinner ? '最终生效层' : '被覆盖层'}">
      ${s}${isWinner ? ' ✓ 生效' : ''}</span>`;
  }).join('<span class="mono">→</span>');
  const trace = d.resolution_trace.map(t => `
    <div class="trace-step ${t.status === 'cycle' ? 'cycle' : ''}">
      <code>${esc(t.path)}</code>
      <span class="pill ${t.status === 'cycle' ? 'cycle' : t.status}">${t.status === 'literal' ? '字面值' : t.status === 'alias' ? `别名 → ${t.references.join(',')}` : '环'}</span>
      <div class="meta mono">raw: ${esc(t.raw_value)} ⇒ resolved: ${esc(t.resolved_value)}</div>
    </div>`).join('');
  $('#tokenDetail').innerHTML = `
    <div class="row wrap" style="gap:14px">
      <div><div class="hint">路径</div><code class="mono">${esc(d.path)}</code></div>
      <div><div class="hint">最终值</div><b class="mono" style="font-size:16px">${esc(d.value)}</b></div>
      ${isColor(d.value) ? `<span class="swatch" style="width:30px;height:30px;background:${esc(d.value)}"></span>` : ''}
      <div><div class="hint">签名 / 版本</div><span class="mono">${d.signature}</span></div>
      <div><div class="hint">来源缓存</div><span class="mono">${d.cached ? '命中缓存' : '新鲜解析'}</span></div>
    </div>
    <p style="margin-top:10px"><b>覆盖优先级</b>（根 → 叶子，越后优先级越高，划掉的层被覆盖）：</p>
    <div class="prio-chain">${chain}</div>
    <p><b>引用解析链</b>（令牌可引用其他令牌）：</p>${trace}
    ${d.in_cycle ? '<p class="flag error" style="display:inline-block;margin-top:6px">该令牌位于别名环中，无法解析；请打断引用环。</p>' : ''}`;
  $('#tokenDetailCard').hidden = false;
  $('#tokenDetailCard').scrollIntoView({ behavior: 'smooth' });
}

/* ---------------- token update ---------------- */
async function doUpdate() {
  const body = {
    theme_slug: $('#updTheme').value, path: $('#updPath').value.trim(),
    value: $('#updValue').value.trim(), type: 'color',
    designer: $('#updDesigner').value.trim(), note: '上游令牌更新'
  };
  $('#updResult').textContent = '更新中…';
  try {
    const d = await put('/api/tokens', body);
    $('#updResult').textContent = JSON.stringify({
      new_version: d.new_version, new_signature: d.new_signature,
      invalidated_cache_scopes: d.cache_invalidated_scopes,
      affected_components: d.impact.affected_components,
      affected_themes: d.impact.affected_themes,
      confirmations_needs_rereview: d.confirmations_needs_rereview
    }, null, 2);
    toast(`已更新 ${body.path}：${d.confirmations_needs_rereview.length} 个确认待复查`);
    await bootRefresh();
  } catch (e) {
    $('#updResult').textContent = '更新被拒绝（防止引入别名环）：\n' +
      JSON.stringify(e.detail, null, 2);
    toast('更新失败：' + (e.detail?.message || e.message), true);
  }
}
async function bootRefresh() {
  state.themes = await api('/api/themes');
  await Promise.all([loadTokens(), loadInheritance(), refreshCache()]);
}
async function refreshCache() {
  const c = await api('/api/cache');
  const entries = Object.entries(c.expansion_entries || {});
  $('#cacheState').textContent = entries.length
    ? entries.map(([k, v]) => `${k}@${v.signature.slice(0, 6)}(${v.age_seconds}s)`).join('  ')
    : '（空）';
}

/* ---------------- color compare ---------------- */
function addPair(fg = '#1d4ed8', bg = '#ffffff') {
  const row = document.createElement('div');
  row.className = 'pair-row';
  row.innerHTML = `
    <input class="small-input fg" value="${fg}"/>
    <input class="small-input bg" value="${bg}"/>
    <div class="preview-chip">示例文字 Aa</div>
    <div class="ratio mono">-</div>
    <div class="verdict hint">输入合法颜色后自动计算</div>
    <button class="ghost small del">✕</button>`;
  $('#compareRows').appendChild(row);
  row.querySelector('.del').addEventListener('click', () => { row.remove(); });
  row.querySelectorAll('input').forEach(i => i.addEventListener('input', () => evaluatePair(row)));
  evaluatePair(row);
}
async function evaluatePair(row) {
  const fg = row.querySelector('.fg').value.trim();
  const bg = row.querySelector('.bg').value.trim();
  const purpose = $('#cmpScale').value === 'ui' ? 'ui' : 'text';
  const scale = $('#cmpScale').value === 'large' ? 'large' : 'normal';
  try {
    const d = await post('/api/compare', { pairs: [[fg, bg]], scale, purpose });
    const r = d.results[0];
    const chip = row.querySelector('.preview-chip');
    chip.style.background = bg; chip.style.color = fg;
    const ratioEl = row.querySelector('.ratio');
    const verdict = row.querySelector('.verdict');
    if (!r.legal) {
      ratioEl.textContent = 'N/A'; ratioEl.className = 'ratio mono fail';
      verdict.innerHTML = `<span class="fail">颜色值不合法</span> — ${esc(r.reason)}`;
      return;
    }
    ratioEl.textContent = r.ratio.toFixed(2) + ':1';
    ratioEl.className = 'ratio mono ' + (r.passes ? 'pass' : 'fail');
    verdict.innerHTML = r.passes
      ? `<span class="pass">达标</span> ≥ ${r.threshold}:1（${scale === 'large' ? '大字' : purpose === 'ui' ? 'UI' : '正文'} AA）`
      : `<span class="fail">不达标</span>，需要 ≥ ${r.threshold}:1；颜色值虽合法，但该前景×背景组合不可读`;
  } catch (e) { /* leave row pending */ }
}
async function loadMatrix() {
  const rows = [];
  for (const c of state.components) {
    const d = await api(`/api/components/${c.slug}/rendered`);
    for (const p of d.previews) {
      const fg = p.values.foreground?.value, bg = p.values.background?.value;
      const icon = p.values.icon_color?.value;
      rows.push({ c, p, fg, bg, icon });
    }
  }
  $('#contrastMatrix').innerHTML = `<table class="table">
    <thead><tr><th>组件</th><th>状态</th><th>主题</th><th>实际前景/图标</th><th>实际背景</th>
      <th>比例</th><th>判定（绑定真实状态）</th></tr></thead><tbody>
    ${rows.map(({ c, p, fg, bg }) => {
      const disabled = p.disabled;
      let judge;
      if (disabled) judge = '<span class="exempt">禁用态：对比度豁免，且不计入合格演示</span>';
      else if (p.contrast) {
        const r = p.contrast;
        judge = r.passes ? `<span class="pass">通过 ${r.ratio}:1 ≥ ${r.threshold}:1</span>`
          : `<span class="fail">失败 ${r.ratio}:1 &lt; ${r.threshold}:1</span>`;
      } else judge = '<span class="hint">无文本（纯图标组件）</span>';
      const fgCell = fg ? `<span class="swatch" style="background:${esc(fg)}"></span>${esc(fg)}`
        : (p.values.icon_color ? `<span class="swatch" style="background:${esc(p.values.icon_color.value)}"></span>${esc(p.values.icon_color.value)} ${p.values.icon_color.winner === '<hard-coded>' ? '<span class="flag error">硬编码</span>' : ''}` : '-');
      return `<tr>
        <td>${esc(c.name)}</td>
        <td><span class="state-chip ${disabled ? 'disabled' : ''}">${esc(p.state)}${disabled ? ' · disabled' : ''}</span></td>
        <td class="mono">${p.theme_slug}</td>
        <td class="mono">${fgCell}</td>
        <td class="mono"><span class="swatch" style="background:${esc(bg || '')}"></span>${esc(bg || '-')}</td>
        <td class="mono">${p.contrast ? p.contrast.ratio + ':1' : '—'}</td>
        <td>${judge}</td></tr>`;
    }).join('')}
  </tbody></table>`;
}

/* ---------------- typography ---------------- */
async function loadTypography() {
  const theme = state.currentTheme;
  const exp = state.expansions[theme] || await api(`/api/themes/${theme}/expand`);
  const weights = Object.entries(exp.tokens).filter(([p]) => p.startsWith('font.weight.'));
  const nodes = Object.values(exp.tokens).filter(n => n.path.startsWith('font.size.'))
    .sort((a, b) => parseFloat(a.value) - parseFloat(b.value));
  $('#typeScale').innerHTML = nodes.map(n => `
    <div class="type-row">
      <div><code class="mono">${esc(n.path)}</code><div class="hint">来源 ${esc(n.winner.theme_slug)}</div></div>
      <div class="type-spec">${esc(n.value)}</div>
      <div style="font-size:${esc(n.value)}">设计规范 · Design Spec 中文标题 AaBbCc 0123</div>
    </div>`).join('') +
    `<div class="hint" style="margin-top:10px">字重令牌：${weights.map(([p, n]) =>
      `<code class="mono">${p}=${esc(n.value)}</code>`).join('，')}</div>`;
}

/* ---------------- components / icons / form states ---------------- */
async function loadComponents() {
  const deps = await api('/api/dependencies');
  $('#componentList').innerHTML = state.components.map(c => {
    const states = Object.entries(c.states).map(([s, u]) => ({ s, u }));
    const previews = [];
    return `<div class="comp-card">
      <div class="comp-head">
        <div><b>${esc(c.name)}</b> <span class="mono">${c.slug}</span>
          <span class="badge">${c.kind}</span></div>
        <div class="hint">依赖：${c.depends_on.join(', ') || '无'} ｜ 被依赖：${c.dependents.join(', ') || '无'}
          ｜ 契约令牌 ${c.supported_tokens.length} 个</div>
      </div>
      <div class="comp-body" data-comp="${c.slug}">
        ${states.map(({ s, u }) => demoBox(c, s, u)).join('')}
      </div></div>`;
  }).join('');
  // fill each demo with resolved values for the selected theme
  for (const c of state.components) {
    const d = await api(`/api/components/${c.slug}/rendered`);
    $$(`.comp-body[data-comp="${c.slug}"] .demo`).forEach(box => {
      const st = box.dataset.state;
      const pv = d.previews.find(x => x.state === st && x.theme_slug === state.currentTheme);
      if (!pv) return;
      decorateDemo(box, c, st, pv);
    });
  }
  // dependency graph
  const all = new Set();
  deps.edges.forEach(e => { all.add(e.from); all.add(e.to); });
  $('#depGraph').innerHTML = deps.edges.map(e =>
    `<div><span class="node">${esc(e.from)}</span> <span class="mono">→</span>
     <span class="node">${esc(e.to)}</span> <span class="badge">bound ${esc(e.version_bound || '')}</span></div>`).join('');
}
function demoBox(c, state, u) {
  const disabled = u.disabled || state === 'disabled';
  return `<div class="demo" data-state="${esc(state)}">
    <span class="ratio-tag"></span>
    <div class="render"></div>
    <div class="meta"></div>
    <div class="flags" style="margin-top:6px"></div>
    ${disabled ? '<span class="flag exempt">禁用示例（不计为合格演示）</span>' : ''}
  </div>`;
}
function decorateDemo(box, c, state, pv) {
  const v = pv.values, disabled = pv.disabled;
  const bg = v.background?.value || '#ffffff';
  const fg = v.foreground?.value || '#111111';
  const fs = v.font_size?.value || '14px';
  const icon = v.icon_color?.value;
  const hardcoded = v.icon_color?.winner === '<hard-coded>';
  box.style.background = '#0b1424';
  const render = box.querySelector('.render');
  const iconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${esc(icon || fg)}" stroke-width="2.4"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>`;
  let widget = '';
  if (c.kind === 'button') {
    widget = `<span class="mock-btn" style="background:${esc(bg)};color:${esc(fg)};font-size:${esc(fs)};${disabled ? 'opacity:.55;cursor:not-allowed' : ''}">${iconSvg}${esc(c.name)}</span>`;
  } else if (c.kind === 'form') {
    const border = state === 'error' ? v.foreground?.value : '#64748b';
    widget = `<input class="mock-input" style="background:${esc(bg)};color:${esc(fg)};font-size:${esc(fs)};border-color:${esc(border)};${disabled ? 'opacity:.55' : ''}" value="${esc(state === 'error' ? '错误的输入' : '请输入内容')}" ${disabled ? 'disabled' : ''}/>`;
    if (state === 'helper' || state === 'error')
      widget += `<div class="helper" style="color:${esc(fg)};font-size:12px">${state === 'error' ? '请修正该字段' : '辅助说明：此处使用 color.text.subtle'}</div>`;
  } else if (c.kind === 'icon') {
    widget = `<span class="mock-btn" style="background:${esc(bg)};color:${esc(icon || fg)};${disabled ? 'opacity:.5' : ''}">${iconSvg}</span>`;
  } else {
    widget = `<div style="background:${esc(bg)};color:${esc(fg)};font-size:${esc(fs)};padding:10px;border-radius:8px">卡片内容 · ${esc(c.name)}</div>`;
  }
  render.innerHTML = `<div style="background:${esc(bg)};padding:12px;border-radius:8px;border:1px solid var(--border)">
      <div class="hint" style="margin-bottom:6px">${esc(state)} · ${pv.theme_slug}</div>${widget}</div>`;
  const sources = Object.entries(v).map(([role, x]) =>
    `${role}: ${x.path || '<hard-coded>'}=${esc(x.value)} ←${esc(x.winner)}`).join('\n');
  box.querySelector('.meta').textContent = sources;
  const flags = box.querySelector('.flags');
  if (hardcoded && !disabled)
    flags.innerHTML += '<span class="flag error">动态图标颜色被硬编码，无法随主题切换</span>';
  if (pv.contrast) {
    const r = pv.contrast;
    box.querySelector('.ratio-tag').textContent = r.ratio + ':1';
    box.querySelector('.ratio-tag').className = 'ratio-tag ' + (r.passes ? 'pass' : 'fail');
    flags.innerHTML += r.passes
      ? `<span class="flag ok">文本对比通过 ${r.ratio}:1</span>`
      : `<span class="flag error">文本对比不足 ${r.ratio}:1 &lt; ${r.threshold}:1</span>`;
  } else if (!disabled) {
    box.querySelector('.ratio-tag').textContent = 'UI 3:1';
  }
}

/* ---------------- screenshots & confirmations ---------------- */
async function loadScreenshots() {
  const [shots, confs] = await Promise.all([api('/api/screenshots'), api('/api/confirmations')]);
  $('#shotTasks').innerHTML = shots.map(t => `
    <div class="shot ${t.status}">
      <div class="row" style="justify-content:space-between">
        <div><b>${esc(t.component_slug)}</b> <span class="mono">${t.theme_slug}/${t.state}</span></div>
        <span class="status ${t.status}">${t.status}</span>
      </div>
      <div class="hint" style="margin:6px 0">
        ${t.fail_step ? `中断步骤 <code>${esc(t.fail_step)}</code>：${esc(t.error || '')}<br/>` : ''}
        令牌版 <code>${esc((t.token_version_hash || '—').slice(0, 12))}</code>
        · 设计版 <code>${esc(t.design_version || '—')}</code>
        ${t.artifact_path ? `· <a href="/screenshots/${encodeURIComponent(t.artifact_path)}" target="_blank">查看 SVG</a>` : ''}
      </div>
      <div class="row">
        ${t.status !== 'completed' ? `<button class="small primary" data-resume="${t.id}">${t.status === 'pending' ? '执行任务' : '恢复任务'}</button>` : ''}
        ${t.status === 'completed' ? `<button class="small ghost" data-confirm="${t.id}">设计师确认</button>` : ''}
      </div>
    </div>`).join('');
  $$('#shotTasks [data-resume]').forEach(b => b.addEventListener('click', async () => {
    const t = shots.find(x => String(x.id) === b.dataset.resume);
    await post('/api/screenshots', { component_slug: t.component_slug, theme_slug: t.theme_slug,
      state: t.state, resume: true });
    toast('截图任务已恢复并完成'); loadScreenshots();
  }));
  $$('#shotTasks [data-confirm]').forEach(b => b.addEventListener('click', async () => {
    const t = shots.find(x => String(x.id) === b.dataset.confirm);
    const res = await post('/api/confirmations', { component_slug: t.component_slug, theme_slug: t.theme_slug,
      state: t.state, designer: 'mina' });
    toast(res.confirmed ? '已基于当前令牌版本的截图完成确认'
                        : '截图来自旧令牌版本，仍需重新截图后复查', !res.confirmed);
    loadScreenshots();
  }));

  $('#confirmations').innerHTML = confs.map(c => `
    <div class="shot ${c.status === 'confirmed' ? 'completed' : 'pending'}">
      <div class="row" style="justify-content:space-between">
        <div><b>${esc(c.designer)}</b> 确认 <b>${esc(c.component_slug)}</b>
          <span class="mono">${c.theme_slug}/${c.state}</span></div>
        <span class="status ${c.status}">${{ confirmed: '已确认', needs_rereview: '待复查', superseded: '已过期' }[c.status]}</span>
      </div>
      <div class="hint" style="margin-top:6px">
        基于截图 #${c.screenshot_id} ｜ 确认时令牌版 <code>${esc((c.confirmed_token_hash || '').slice(0, 12))}</code>
        ｜ 当前 <code>${esc((c.current_token_hash || '').slice(0, 12))}</code>
        ${c.status === 'needs_rereview' ? '<br/><b class="fail">上游令牌已更新，该确认需要基于新截图复查</b>' : ''}
        ${c.note ? `<br/>${esc(c.note)}` : ''}
      </div>
    </div>`).join('');
}
function fillExportStates() {
  const c = state.components.find(x => x.slug === $('#exComp').value);
  $('#exState').innerHTML = Object.keys(c?.states || {}).map(s => `<option>${s}</option>`).join('');
}
async function doExport() {
  const [comp, theme, st] = [$('#exComp').value, $('#exTheme').value, $('#exState').value];
  try {
    const d = await api(`/api/export/${comp}/${theme}/${st}`);
    $('#exportResult').innerHTML = `
      <div>
        <div class="hint" style="margin-bottom:6px">运行示例（SVG，内含 &lt;metadata&gt; 来源）</div>
        <div style="background:#0b1424;border:1px solid var(--border);border-radius:10px;padding:8px">${d.svg}</div>
        <a class="btn" href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(d.svg)}"
           download="${comp}-${theme}-${st}.svg"><button class="small primary" style="margin-top:8px">下载 SVG</button></a>
      </div>
      <div>
        <div class="hint" style="margin-bottom:6px">标注 / 可追溯来源（令牌签名 <code>${d.signature}</code>）</div>
        <ul class="anno">${d.annotations.map(a => `<li><code>${esc(a.role)}</code> ← <b>${esc(a.token_path)}</b>
          = <span class="swatch" style="background:${esc(a.resolved_value)}"></span><code>${esc(a.resolved_value)}</code>
          <div class="hint">生效层 ${esc(a.winner_theme)}；覆盖链 ${(a.override_priority || []).join(' → ')}</div></li>`).join('')}</ul>
        <pre class="result">${esc(d.svg.match(/<metadata[\s\S]*?<\/metadata>/)?.[0] || '')}</pre>
      </div>`;
  } catch (e) { toast('导出失败：' + e.message, true); }
}

/* ---------------- report ---------------- */
async function runReport() {
  $('#reportFindings').innerHTML = '<p class="hint">后台生成中…</p>';
  const d = await post('/api/reports', {});
  state.reportId = d.report_id;
  pollReport();
}
async function pollReport() {
  for (let i = 0; i < 20; i++) {
    const r = await api(`/api/reports/${state.reportId}`);
    if (r.status === 'completed' || r.status === 'failed') { renderReport(r); return; }
    await new Promise(res => setTimeout(res, 400));
  }
}
async function loadReport() {
  if (state.reportId) { const r = await api(`/api/reports/${state.reportId}`); renderReport(r); }
  else $('#reportFindings').innerHTML = '<p class="hint">点击右上角“生成检查报告”。</p>';
}
const RULE_LABEL = {
  alias_cycle: '别名环', theme_override_gap: '主题覆盖漏项', contrast_state: '真实状态对比',
  disabled_demo: '禁用示例规则', dynamic_icon_color: '动态图标颜色',
  legacy_component_token: '旧组件未支持新令牌', screenshot_interrupted: '截图任务中断',
  traceability: '来源可追溯', stale_confirmation: '确认待复查'
};
function renderReport(r) {
  $('#reportMeta').textContent = `报告 #${r.id} · 设计版 ${r.design_version} · ${r.status}`;
  const s = r.summary || {};
  $('#reportSummary').innerHTML = `
    <div class="sum ${s.pass ? 'pass' : 'error'}"><b>${s.pass ? '通过' : '不通过'}</b><span class="hint">总体门禁</span></div>
    <div class="sum error"><b>${s.by_severity?.error || 0}</b><span class="hint">错误</span></div>
    <div class="sum warning"><b>${s.by_severity?.warning || 0}</b><span class="hint">警告</span></div>
    <div class="sum info"><b>${s.by_severity?.info || 0}</b><span class="hint">提示</span></div>
    ${Object.entries(s.by_rule || {}).map(([k, n]) =>
      `<div class="sum"><b>${n}</b><span class="hint">${RULE_LABEL[k] || k}</span></div>`).join('')}`;
  $('#reportFindings').innerHTML = (r.findings || []).map(f => `
    <div class="finding ${f.severity}">
      <span class="flag ${f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warn' : 'exempt'}">${RULE_LABEL[f.rule] || f.rule}</span>
      <code>${esc(f.subject)}</code> ${esc(f.message)}
      <details><summary class="hint">证据</summary><pre class="result" style="margin-top:6px">${esc(JSON.stringify(f.evidence, null, 2))}</pre></details>
    </div>`).join('');
}

/* ---------------- seed initial compare pairs ---------------- */
addPair('#9ca3af', '#ffffff'); // legal color, fails text contrast (helper text)
addPair('#1d4ed8', '#ffffff'); // passing
addPair('#999999', '#ffffff'); // icon-ish 3:1 check - choose ui scale manually

boot().catch(e => toast('初始化失败：' + e.message, true));
