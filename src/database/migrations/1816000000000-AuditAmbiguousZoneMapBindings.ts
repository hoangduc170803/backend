import { MigrationInterface, QueryRunner } from 'typeorm';

/** Existing deployments may already have run the original backfill. Preserve the
 * evidence for operator review; never overwrite a potentially manual assignment. */
export class AuditAmbiguousZoneMapBindings1816000000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE zone_map_binding_audit (
      zone_id uuid PRIMARY KEY,
      assigned_map_record_id uuid,
      candidate_record_ids jsonb NOT NULL,
      reason text NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`
      WITH latest AS (
        SELECT name, max(last_loaded_at) AS loaded_at FROM map_records GROUP BY name
      ), ambiguous AS (
        SELECT m.name, jsonb_agg(m.id ORDER BY m.id) AS candidates
        FROM map_records m JOIN latest l ON m.name = l.name AND m.last_loaded_at = l.loaded_at
        GROUP BY m.name HAVING count(*) > 1
      )
      INSERT INTO zone_map_binding_audit (zone_id, assigned_map_record_id, candidate_record_ids, reason)
      SELECT z.id, z.map_record_id, a.candidates, 'Equal latest load timestamps; verify legacy/manual binding'
      FROM zones z JOIN ambiguous a ON a.name = z.plant_model_name
      WHERE z.deleted_at IS NULL
    `);
    const rows = (await runner.query(
      'SELECT zone_id FROM zone_map_binding_audit',
    )) as { zone_id: string }[];
    if (rows.length)
      console.warn(
        `Map binding audit: ${rows.length} zone(s) require review in zone_map_binding_audit; original assignments preserved.`,
      );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE zone_map_binding_audit');
  }
}
