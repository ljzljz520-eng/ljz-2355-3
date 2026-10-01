// 内存存储：与 PG 适配器同一接口，用于本地演示与测试。
// 单进程、异步签名（方便无缝替换为 PG 实现）。

export class MemoryStore {
  constructor() {
    this.scopes = new Map();   // id -> scope
    this.tokens = new Map();   // scope::name -> def
    this.components = new Map(); // id -> component
    this.versions = [];        // design versions (append-only)
    this.shots = new Map();    // id -> screenshot job
    this.confirmations = new Map(); // componentId::theme -> confirmation
    this.reports = [];
    this._id = 0;
  }

  async id(prefix) {
    this._id += 1;
    return prefix + '_' + Date.now().toString(36) + '_' + this._id;
  }

  // ---- scopes ----
  async upsertScope(s) { this.scopes.set(s.id, s); return s; }
  async getScope(id) { return this.scopes.get(id) ?? null; }
  async listScopes() { return [...this.scopes.values()]; }

  // ---- tokens ----
  key(scope, name) { return scope + '::' + name; }
  namesAt(scope) {
    const out = [];
    for (const [k, t] of this.tokens) if (k.startsWith(scope + '::')) out.push(t.name);
    return out.sort();
  }
  getTokenDef(scope, name) { return this.tokens.get(this.key(scope, name)) ?? null; }
  async listTokenDefs(scope) { return this.namesAt(scope).map((n) => this.tokens.get(this.key(scope, n))); }
  async listAllTokenDefs() { return [...this.tokens.values()]; }
  async putToken(def) {
    const key = this.key(def.scope, def.name);
    const prev = this.tokens.get(key) ?? null;
    const next = { ...def, updatedAt: new Date().toISOString() };
    this.tokens.set(key, next);
    return { prev, next };
  }
  async deleteToken(scope, name) {
    return this.tokens.delete(this.key(scope, name));
  }

  // ---- components ----
  async putComponent(c) { this.components.set(c.id, c); return c; }
  async getComponent(id) { return this.components.get(id) ?? null; }
  async listComponents() { return [...this.components.values()]; }

  // ---- versions ----
  async addVersion(v) { this.versions.push(v); return v; }
  async listVersions(limit = 50) { return [...this.versions].sort((a, b) => b.number - a.number).slice(0, limit); }
  async getVersion(id) { return this.versions.find((v) => v.id === id) ?? null; }
  async latestVersionNumber() { return this.versions.reduce((m, v) => Math.max(m, v.number), 0); }

  // ---- screenshot jobs ----
  async putShot(s) { this.shots.set(s.id, s); return s; }
  async getShot(id) { return this.shots.get(id) ?? null; }
  async listShots() { return [...this.shots.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async shotsFor(componentId) {
    return (await this.listShots()).filter((s) => s.componentId === componentId);
  }

  // ---- confirmations ----
  confKey(componentId, theme) { return componentId + '::' + theme; }
  async putConfirmation(c) { this.confirmations.set(this.confKey(c.componentId, c.theme), c); return c; }
  async getConfirmation(componentId, theme) {
    return this.confirmations.get(this.confKey(componentId, theme)) ?? null;
  }
  async listConfirmations() { return [...this.confirmations.values()]; }
  async invalidateConfirmations(predicate, reason = null) {
    let n = 0;
    for (const c of this.confirmations.values()) {
      if (c.status === 'confirmed' && (await predicate(c))) {
        c.status = 'needs_review';
        c.invalidatedAt = new Date().toISOString();
        if (reason) c.reasons = [...(c.reasons ?? []), { at: c.invalidatedAt, reason }];
        n += 1;
      }
    }
    return n;
  }

  // ---- reports ----
  async addReport(r) { this.reports.push(r); return r; }
  async listReports() { return [...this.reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async getReport(id) { return this.reports.find((r) => r.id === id) ?? null; }
}
