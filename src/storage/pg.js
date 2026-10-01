// PostgreSQL 适配器：启动时全量载入到内存读模型（scope/token 解析是热路径，
// 需要同步接口），写操作双写 PG 与读模型。PG 是持久化真源，重启后重新装载。
// 依赖 `pg`（optionalDependency 语义：仅在设置 DATABASE_URL 时动态 import）。

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from './memory.js';

export class PgStore extends MemoryStore {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  static async connect(connectionString) {
    let pg;
    try {
      pg = await import('pg');
    } catch {
      throw new Error('设置了 DATABASE_URL 但未安装 pg，请执行: npm install pg');
    }
    const pool = new pg.default.Pool({ connectionString });
    const store = new PgStore(pool);
    await store.#init();
    return store;
  }

  async #init() {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(join(here, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
    const [scopes, tokens, comps, versions, shots, confs, reports] = await Promise.all([
      this.pool.query('SELECT * FROM scopes'),
      this.pool.query('SELECT * FROM tokens'),
      this.pool.query('SELECT * FROM components'),
      this.pool.query('SELECT * FROM design_versions ORDER BY number'),
      this.pool.query('SELECT * FROM screenshot_jobs'),
      this.pool.query('SELECT * FROM confirmations'),
      this.pool.query('SELECT * FROM reports')
    ]);
    for (const r of scopes.rows) {
      this.scopes.set(r.id, { id: r.id, kind: r.kind, name: r.name, parent: r.parent, extends: r.extends, reference: r.reference, meta: r.meta });
    }
    for (const r of tokens.rows) {
      this.tokens.set(r.scope + '::' + r.name, { scope: r.scope, name: r.name, type: r.type, value: r.value, meta: r.meta, updatedAt: r.updated_at?.toISOString() });
    }
    for (const r of comps.rows) {
      this.components.set(r.id, { id: r.id, name: r.name, usages: r.usages, description: r.description, supportedTokenVersion: r.supported_token_version, meta: r.meta });
    }
    for (const r of versions.rows) this.versions.push({ id: r.id, number: r.number, label: r.label, tokens: r.tokens, components: r.components, createdBy: r.created_by, createdAt: r.created_at?.toISOString() });
    for (const r of shots.rows) {
      this.shots.set(r.id, { id: r.id, componentId: r.component_id, theme: r.theme, tokenVersion: r.token_version, status: r.status, framesTotal: r.frames_total, framesDone: r.frames_done, imageUrl: r.image_url, source: r.source, error: r.error, createdAt: r.created_at?.toISOString(), updatedAt: r.updated_at?.toISOString() });
    }
    for (const r of confs.rows) {
      this.confirmations.set(r.component_id + '::' + r.theme, { componentId: r.component_id, theme: r.theme, status: r.status, tokenVersion: r.token_version, shotId: r.shot_id, confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at?.toISOString(), invalidatedAt: r.invalidated_at?.toISOString(), reasons: r.reasons });
    }
    for (const r of reports.rows) this.reports.push({ id: r.id, summary: r.summary, findings: r.findings, createdBy: r.created_by, createdAt: r.created_at?.toISOString() });
  }

  async upsertScope(s) {
    await this.pool.query(
      `INSERT INTO scopes (id, kind, name, parent, extends, reference, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind, name=EXCLUDED.name,
         parent=EXCLUDED.parent, extends=EXCLUDED.extends, reference=EXCLUDED.reference, meta=EXCLUDED.meta`,
      [s.id, s.kind, s.name, s.parent ?? null, s.extends ?? null, s.reference ?? null, JSON.stringify(s.meta ?? {})]
    );
    return super.upsertScope(s);
  }

  async putToken(def) {
    await this.pool.query(
      `INSERT INTO tokens (scope, name, type, value, meta, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (scope, name) DO UPDATE SET type=EXCLUDED.type, value=EXCLUDED.value,
         meta=EXCLUDED.meta, updated_at=now()`,
      [def.scope, def.name, def.type, def.value, JSON.stringify(def.meta ?? {})]
    );
    return super.putToken(def);
  }

  async deleteToken(scope, name) {
    await this.pool.query('DELETE FROM tokens WHERE scope=$1 AND name=$2', [scope, name]);
    return super.deleteToken(scope, name);
  }

  async putComponent(c) {
    await this.pool.query(
      `INSERT INTO components (id, name, usages, description, supported_token_version, meta, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, usages=EXCLUDED.usages,
         description=EXCLUDED.description, supported_token_version=EXCLUDED.supported_token_version,
         meta=EXCLUDED.meta, updated_at=now()`,
      [c.id, c.name, JSON.stringify(c.usages ?? []), c.description ?? '', c.supportedTokenVersion ?? 1, JSON.stringify(c.meta ?? {})]
    );
    return super.putComponent(c);
  }

  async addVersion(v) {
    await this.pool.query(
      `INSERT INTO design_versions (id, number, label, tokens, components, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
      [v.id, v.number, v.label ?? null, JSON.stringify(v.tokens), JSON.stringify(v.components), v.createdBy ?? null]
    );
    return super.addVersion(v);
  }

  async putShot(s) {
    await this.pool.query(
      `INSERT INTO screenshot_jobs (id, component_id, theme, token_version, status,
         frames_total, frames_done, image_url, source, error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, frames_total=EXCLUDED.frames_total,
         frames_done=EXCLUDED.frames_done, image_url=EXCLUDED.image_url, source=EXCLUDED.source,
         error=EXCLUDED.error, updated_at=now()`,
      [s.id, s.componentId, s.theme, s.tokenVersion, s.status, s.framesTotal ?? 0,
       s.framesDone ?? 0, s.imageUrl ?? null, JSON.stringify(s.source ?? {}), s.error ?? null]
    );
    return super.putShot(s);
  }

  async putConfirmation(c) {
    await this.pool.query(
      `INSERT INTO confirmations (component_id, theme, status, token_version, shot_id,
         confirmed_by, confirmed_at, invalidated_at, reasons)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (component_id, theme) DO UPDATE SET status=EXCLUDED.status,
         token_version=EXCLUDED.token_version, shot_id=EXCLUDED.shot_id,
         confirmed_by=EXCLUDED.confirmed_by, confirmed_at=EXCLUDED.confirmed_at,
         invalidated_at=EXCLUDED.invalidated_at, reasons=EXCLUDED.reasons`,
      [c.componentId, c.theme, c.status, c.tokenVersion, c.shotId ?? null,
       c.confirmedBy ?? null, c.confirmedAt ? new Date(c.confirmedAt) : null,
       c.invalidatedAt ? new Date(c.invalidatedAt) : null, JSON.stringify(c.reasons ?? [])]
    );
    return super.putConfirmation(c);
  }

  async invalidateConfirmations(predicate, reason = null) {
    // 先在内存读模型上判定（与 MemoryStore 同口径），再把状态变化持久化到 PG
    const targets = [];
    for (const c of this.confirmations.values()) {
      if (c.status === 'confirmed' && (await predicate(c))) targets.push(c);
    }
    const at = new Date().toISOString();
    for (const c of targets) {
      c.status = 'needs_review';
      c.invalidatedAt = at;
      if (reason) c.reasons = [...(c.reasons ?? []), { at, reason }];
      await this.pool.query(
        `UPDATE confirmations SET status='needs_review', invalidated_at=$3, reasons=$4
         WHERE component_id=$1 AND theme=$2`,
        [c.componentId, c.theme, at, JSON.stringify(c.reasons)]
      );
    }
    return targets.length;
  }

  async addReport(r) {
    await this.pool.query(
      `INSERT INTO reports (id, summary, findings, created_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET summary=EXCLUDED.summary, findings=EXCLUDED.findings`,
      [r.id, JSON.stringify(r.summary), JSON.stringify(r.findings), r.createdBy ?? null]
    );
    return super.addReport(r);
  }
}
