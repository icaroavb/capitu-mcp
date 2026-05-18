import type { Database } from 'better-sqlite3';
import type { TenantCatalogEntry } from './types.js';

export function upsertCatalog(db: Database, entries: TenantCatalogEntry[]): void {
  const stmt = db.prepare(`
    INSERT INTO tenant_catalog (type, name, release_contract, metadata, refreshed_at)
    VALUES (@type, @name, @releaseContract, @metadata, CURRENT_TIMESTAMP)
    ON CONFLICT(type, name) DO UPDATE SET
      release_contract = excluded.release_contract,
      metadata = excluded.metadata,
      refreshed_at = CURRENT_TIMESTAMP
  `);
  const tx = db.transaction((rows: TenantCatalogEntry[]) => {
    for (const r of rows) {
      stmt.run({
        type: r.type,
        name: r.name,
        releaseContract: r.releaseContract ?? null,
        metadata: r.metadata ? JSON.stringify(r.metadata) : null,
      });
    }
  });
  tx(entries);
}

export function listCatalog(
  db: Database,
  type?: string,
): Array<TenantCatalogEntry & { refreshedAt: string }> {
  const sql = type
    ? 'SELECT * FROM tenant_catalog WHERE type = ? ORDER BY name'
    : 'SELECT * FROM tenant_catalog ORDER BY type, name';
  const rows = (type ? db.prepare(sql).all(type) : db.prepare(sql).all()) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    type: r.type as TenantCatalogEntry['type'],
    name: r.name as string,
    releaseContract: (r.release_contract as TenantCatalogEntry['releaseContract']) ?? undefined,
    metadata: r.metadata ? JSON.parse(r.metadata as string) : undefined,
    refreshedAt: r.refreshed_at as string,
  }));
}
