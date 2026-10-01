// 应用服务层：令牌/主题写入与缓存失效、请求时解析、静态展开、
// 变更影响列表（别名闭包 + 继承作用域 + 组件引用）、设计版本、
// 截图任务（可中断/恢复）、设计师确认（绑定截图与令牌版，上游变更自动待复查）。

import { MemoryStore } from './storage/memory.js';
import { PgStore } from './storage/pg.js';
import {
  TokenResolver, validateTokenValue, expandRefs,
  buildAliasEdges, reverseAliasClosure, qid
} from './tokens.js';
import { makeReader, expandTheme, affectedScopes, ThemeCache, inheritancePath } from './themes.js';
import { generateReport } from './checker.js';

export async function createService({ databaseUrl } = {}) {
  const store = databaseUrl ? await PgStore.connect(databaseUrl) : new MemoryStore();
  return new DesignService(store);
}

export class DesignService {
  constructor(store) {
    this.store = store;
    this.cache = new ThemeCache();
  }

  reader() { return makeReader(this.store); }
  resolver() { return new TokenResolver(this.reader()); }

  // ---------- scopes ----------
  async createScope(input) {
    const existing = await this.store.getScope(input.id);
    if (existing) throw httpError(409, 'scope 已存在: ' + input.id);
    const kind = input.kind ?? 'brand';
    if (!['base', 'brand', 'theme'].includes(kind)) throw httpError(400, '非法 scope kind');
    if (input.parent) {
      const p = await this.store.getScope(input.parent);
      if (!p) throw httpError(400, '父 scope 不存在: ' + input.parent);
    }
    const scope = {
      id: input.id, kind, name: input.name ?? input.id,
      parent: input.parent ?? null, extends: input.extends ?? null,
      reference: input.reference ?? null, meta: input.meta ?? {}
    };
    if (input.extends) {
      const p = await this.store.getScope(input.extends);
      if (!p) throw httpError(400, 'extends 指向不存在: ' + input.extends);
    }
    await this.store.upsertScope(scope);
    this.#invalidate([scope.id]);
    return scope;
  }

  async listScopes() { return this.store.listScopes(); }

  // 已存在时用于修正 parent/extends/reference
  async updateScope(input) {
    const existing = await this.store.getScope(input.id);
    if (!existing) throw httpError(404, 'scope 不存在: ' + input.id);
    if (input.extends) {
      const p = await this.store.getScope(input.extends);
      if (!p) throw httpError(400, 'extends 指向不存在: ' + input.extends);
    }
    const scope = {
      ...existing,
      kind: input.kind ?? existing.kind,
      name: input.name ?? existing.name,
      parent: input.parent ?? existing.parent,
      extends: input.extends ?? existing.extends,
      reference: input.reference !== undefined ? input.reference : existing.reference,
      meta: input.meta ?? existing.meta
    };
    await this.store.upsertScope(scope);
    this.cache.invalidateAll();
    return scope;
  }

  // ---------- tokens ----------
  async putToken(input) {
    const scope = await this.store.getScope(input.scope);
    if (!scope) throw httpError(404, 'scope 不存在: ' + input.scope);
    const v = validateTokenValue(input.type, input.value);
    if (!v.ok) throw httpError(400, v.error);

    const impact = await this.computeImpact(input.scope, input.name);
    const def = {
      scope: input.scope, name: input.name, type: input.type,
      value: input.value, meta: input.meta ?? {}
    };
    await this.store.putToken(def);
    this.#invalidate(impact.scopes);
    await this.#invalidateConfirmations(impact);
    return { def, impact };
  }

  async deleteToken(scope, name) {
    const impact = await this.computeImpact(scope, name);
    await this.store.deleteToken(scope, name);
    this.#invalidate(impact.scopes);
    return { deleted: true, impact };
  }

  // 请求时解析：始终走解析器（结构化返回，含覆盖优先级 trace）
  resolveToken(scope, name) {
    return this.resolver().resolve(name, scope);
  }

  // 静态展开（带缓存，失效由写入驱动）
  expand(scopeId, { useCache = true } = {}) {
    const { path: deps, cycle } = inheritancePath(scopeId, this.store.scopes);
    if (cycle) throw httpError(422, '继承存在循环: ' + cycle.at, cycle);
    const compute = () => expandTheme(this.reader(), scopeId, this.store.scopes);
    const result = useCache
      ? this.cache.get(scopeId, compute, deps)
      : { data: compute(), cached: false };
    if (!result.data || result.data.ok === false) {
      throw httpError(422, '展开失败: ' + (result.data?.detail?.at ?? ''), result.data ?? undefined);
    }
    return { ...result.data, cached: result.cached };
  }

  /**
   * 变更影响（解析链感知）：
   *  1) 起点 seed：被改定义本身 + 继承路径上同名覆盖定义（改 base 等于语义上改动各层胜出值）
   *  2) 词法反向别名闭包：定义级传递引用者（解释别名链）
   *  3) 叠加感知闭包：在每个 scope 的请求视角下，凡解析链经过受影响定义的“胜出令牌定义”
   *     —— 解决“主题覆盖了别名目标（如 dark 覆盖 color.brand.primary）”纯词法边抓不到的情形
   *  4) 缓存失效 scope：解析链实际经过 seed 的 scope（精确），并保留继承路径扩散（删除/结构变更兜底）
   *  5) 组件/确认：在具体主题视角解析其使用令牌（含显式图标颜色令牌），链经过 seed 才算受影响
   */
  async computeImpact(changedScope, changedName) {
    const scopes = await this.store.listScopes();
    const scopeMap = new Map(scopes.map((s) => [s.id, s]));
    const scopeIds = scopes.map((s) => s.id);
    const reader = this.reader();
    const resolver = this.resolver();

    // 同 scope 定义 + 继承路径上覆盖它的下游定义
    const seedDefs = new Set([qid(changedScope, changedName)]);
    for (const id of scopeIds) {
      const { path } = inheritancePath(id, scopeMap);
      if (path.includes(changedScope) && reader.getDef(id, changedName)) {
        seedDefs.add(qid(id, changedName));
      }
    }

    // 词法别名闭包（定义级，跨 scope）
    const edges = buildAliasEdges(reader, scopeIds);
    const affectedDefs = reverseAliasClosure(seedDefs, edges);

    const visibleTokens = (scopeId) => {
      const { path, cycle } = inheritancePath(scopeId, scopeMap);
      if (cycle) return { path: null, visible: null };
      const visible = new Map(); // name -> 胜出 scope
      for (const sc of path) {
        for (const name of reader.namesAt(sc)) if (!visible.has(name)) visible.set(name, sc);
      }
      return { path, visible };
    };
    const chainHits = (res, set) => res.ok && res.chain.some((id) => set.has(id));

    // 叠加感知闭包：某 scope 视角下令牌解析链经过任何受影响定义 -> 其胜出定义也受影响
    let grew = true;
    while (grew) {
      grew = false;
      for (const scopeId of scopeIds) {
        const { visible } = visibleTokens(scopeId);
        if (!visible) continue;
        for (const [name, source] of visible) {
          const win = qid(source, name);
          if (affectedDefs.has(win)) continue;
          if (chainHits(resolver.resolve(name, scopeId), affectedDefs)) {
            affectedDefs.add(win);
            grew = true;
          }
        }
      }
    }

    // 精确缓存失效：该 scope 视角下确有解析链经过 seed（渲染值真的变了）；
    // 再并上继承路径扩散，覆盖令牌删除/结构变化导致解析提前改道的情形
    const scopeSet = new Set([changedScope, ...affectedScopes(changedScope, scopeIds, scopeMap)]);
    for (const scopeId of scopeIds) {
      const { visible } = visibleTokens(scopeId);
      if (!visible) { scopeSet.add(scopeId); continue; }
      for (const name of visible.keys()) {
        const res = resolver.resolve(name, scopeId);
        if (chainHits(res, seedDefs) || (!res.ok && name === changedName)) {
          scopeSet.add(scopeId);
          break;
        }
      }
    }

    const tokensOf = (c) => {
      const used = new Set();
      for (const u of c.usages ?? []) {
        for (const s of Object.values(u.slots ?? {})) used.add(s.token);
        // 显式图标颜色令牌与 checker / 说明一致性口径保持一致；currentColor 绑定的文本槽已在 slots 中
        if (u.icon && u.icon.color && u.icon.color !== 'currentColor') used.add(u.icon.color);
      }
      return used;
    };
    const themeIds = scopes.filter((s) => s.kind === 'theme').map((s) => s.id);
    // 某组件在某主题下的实际渲染是否受影响：解析其使用令牌，链经过 seed
    const usageAffected = (tokensUsed, themeId, hit) => {
      for (const t of tokensUsed) {
        const res = resolver.resolve(t, themeId);
        if (chainHits(res, seedDefs) || (!res.ok && t === changedName)) {
          hit.add(t);
          return true;
        }
      }
      return false;
    };

    const components = [];
    for (const c of await this.store.listComponents()) {
      const tokensUsed = tokensOf(c);
      const tokens = new Set();
      const themesHit = [];
      for (const themeId of themeIds) {
        if (usageAffected(tokensUsed, themeId, tokens)) themesHit.push(themeId);
      }
      if (themesHit.length) components.push({ componentId: c.id, name: c.name, tokens: [...tokens], themes: themesHit });
    }

    const confirms = [];
    for (const cf of await this.store.listConfirmations()) {
      const comp = await this.store.getComponent(cf.componentId);
      if (!comp) continue;
      const hit = new Set();
      if (usageAffected(tokensOf(comp), cf.theme, hit)) {
        confirms.push({ componentId: cf.componentId, theme: cf.theme, status: cf.status, tokens: [...hit] });
      }
    }

    return {
      changed: { scope: changedScope, name: changedName },
      tokenDefinitions: [...affectedDefs],
      scopes: [...scopeSet],
      components,
      confirmations: confirms
    };
  }

  async #invalidateConfirmations(impact) {
    // 直接以 impact 在“组件 × 主题”视角算出的结果为准（含显式图标颜色令牌），
    // 避免按令牌名反推造成的多失效/漏失效
    const pairs = new Set(impact.confirmations.map((c) => c.componentId + '::' + c.theme));
    const reason = `上游令牌变更，相关确认待复查: ${impact.changed.scope}/${impact.changed.name}`;
    await this.store.invalidateConfirmations(
      (c) => pairs.has(c.componentId + '::' + c.theme),
      reason
    );
  }

  #invalidate(scopeIds) {
    this.cache.invalidate(scopeIds);
  }

  // ---------- components ----------
  async putComponent(input) {
    const c = {
      id: input.id,
      name: input.name ?? input.id,
      usages: input.usages ?? [],
      description: input.description ?? '',
      supportedTokenVersion: input.supportedTokenVersion ?? 1,
      meta: input.meta ?? {}
    };
    await this.store.putComponent(c);
    return c;
  }

  async listComponents() { return this.store.listComponents(); }
  async getComponent(id) {
    const c = await this.store.getComponent(id);
    if (!c) throw httpError(404, '组件不存在: ' + id);
    return c;
  }

  // ---------- design versions ----------
  async createVersion({ label, createdBy } = {}) {
    const number = (await this.store.latestVersionNumber()) + 1;
    const tokens = [];
    for (const def of await this.store.listAllTokenDefs()) {
      tokens.push({ scope: def.scope, name: def.name, type: def.type, value: def.value });
    }
    const components = (await this.store.listComponents()).map((c) => ({
      id: c.id, supportedTokenVersion: c.supportedTokenVersion
    }));
    const v = { id: 'ver_' + number, number, label: label ?? 'v' + number, tokens, components, createdBy, createdAt: new Date().toISOString() };
    await this.store.addVersion(v);
    return v;
  }

  async listVersions() { return this.store.listVersions(); }

  // ---------- screenshot jobs ----------
  async startShot({ componentId, theme, framesTotal = 4 }, runner) {
    const component = await this.store.getComponent(componentId);
    if (!component) throw httpError(404, '组件不存在: ' + componentId);
    const tokenVersion = await this.store.latestVersionNumber();
    const job = {
      id: await this.store.id('shot'),
      componentId, theme, tokenVersion,
      status: 'running', framesTotal, framesDone: 0,
      source: { componentVersion: component.supportedTokenVersion, createdAt: new Date().toISOString() },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    await this.store.putShot(job);
    if (runner) await this.#runFrames(job, runner);
    return job;
  }

  // 可注入截帧器：抛错或 signal.interrupt() 时落为 interrupted，
  // 保留 framesDone 以支持从断点续跑
  async #runFrames(job, runner) {
    try {
      for (let i = job.framesDone; i < job.framesTotal; i += 1) {
        await runner(frameSignal(job, i));
        job.framesDone = i + 1;
        job.updatedAt = new Date().toISOString();
        if (job.status === 'interrupted') break;
        await this.store.putShot(job);
      }
      if (job.framesDone >= job.framesTotal && job.status !== 'interrupted') {
        job.status = 'completed';
        job.imageUrl = `/shots/${job.id}/image.svg`;
        job.error = null;
      }
    } catch (err) {
      job.status = 'interrupted';
      job.error = String((err && err.message) || err);
    }
    job.updatedAt = new Date().toISOString();
    await this.store.putShot(job);
  }

  async interruptShot(id) {
    const job = await this.store.getShot(id);
    if (!job) throw httpError(404, '截图任务不存在');
    if (job.status === 'running' || job.status === 'pending') {
      job.status = 'interrupted';
      job.updatedAt = new Date().toISOString();
      await this.store.putShot(job);
    }
    return job;
  }

  // 从中断帧继续（同一任务 id，从 framesDone 起继续）
  async resumeShot(id, runner) {
    const job = await this.store.getShot(id);
    if (!job) throw httpError(404, '截图任务不存在');
    if (job.status !== 'interrupted') throw httpError(409, '仅 interrupted 任务可续跑，当前: ' + job.status);
    job.status = 'running';
    await this.store.putShot(job);
    if (runner) await this.#runFrames(job, runner);
    return job;
  }

  async listShots() { return this.store.listShots(); }
  async getShot(id) {
    const j = await this.store.getShot(id);
    if (!j) throw httpError(404, '截图任务不存在');
    return j;
  }

  // ---------- designer confirmation ----------
  // 必须基于“具体组件截图 + 令牌版”：截图必须 completed 且版本一致
  async confirm({ componentId, theme, shotId, confirmedBy }) {
    const component = await this.store.getComponent(componentId);
    if (!component) throw httpError(404, '组件不存在');
    const shot = await this.store.getShot(shotId);
    if (!shot) throw httpError(400, '必须提供具体截图任务');
    if (shot.status !== 'completed') throw httpError(409, '截图未完成（' + shot.status + '），不能确认');
    if (shot.componentId !== componentId || shot.theme !== theme) {
      throw httpError(400, '截图与组件/主题不匹配');
    }
    const tokenVersion = await this.store.latestVersionNumber();
    if (shot.tokenVersion !== tokenVersion) {
      throw httpError(409, `截图基于令牌 v${shot.tokenVersion}，当前为 v${tokenVersion}，请重新截图`);
    }
    const c = {
      componentId, theme, status: 'confirmed',
      tokenVersion, shotId, confirmedBy: confirmedBy ?? 'designer',
      confirmedAt: new Date().toISOString(), invalidatedAt: null, reasons: []
    };
    await this.store.putConfirmation(c);
    return c;
  }

  async listConfirmations() { return this.store.listConfirmations(); }
  async getConfirmation(componentId, theme) {
    const c = await this.store.getConfirmation(componentId, theme);
    if (!c) throw httpError(404, '确认记录不存在');
    return c;
  }

  // ---------- report ----------
  async runReport({ themes, createdBy } = {}) {
    const report = await generateReport(this.store, this.reader(), { themes });
    report.id = await this.store.id('rpt');
    report.createdBy = createdBy ?? 'system';
    report.createdAt = new Date().toISOString();
    await this.store.addReport(report);
    return report;
  }

  async listReports() { return this.store.listReports(); }
  async getReport(id) {
    const r = await this.store.getReport(id);
    if (!r) throw httpError(404, '报告不存在');
    return r;
  }
}

function frameSignal(job, index) {
  return {
    index,
    interrupt() { job.status = 'interrupted'; },
    jobId: job.id
  };
}

export function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra;
  return e;
}
