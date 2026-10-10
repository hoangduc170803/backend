import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time backfill of `cargos.map_record_id`, unlike the AGV/Zone backfills this one needs no
 * name-matching guess — a cargo's `destination_zone_id` already points at the exact zone it was
 * created against, and that zone's own `map_record_id` (see `1814000000000-BackfillZoneMapRecordId`)
 * is the authoritative answer. Only left NULL where the destination zone itself has no resolved
 * map record yet, or no longer exists.
 */
export class BackfillCargoMapRecordId1822000000000
  implements MigrationInterface
{
  name = 'BackfillCargoMapRecordId1822000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const result = (await queryRunner.query(`
      UPDATE cargos
      SET map_record_id = zones.map_record_id
      FROM zones
      WHERE cargos.destination_zone_id = zones.id
        AND cargos.map_record_id IS NULL
        AND zones.map_record_id IS NOT NULL
    `)) as unknown;
    const updated = Array.isArray(result) ? undefined : result;
    console.log(
      `BackfillCargoMapRecordId: backfilled cargo rows via destination zone` +
        (updated ? ` (${JSON.stringify(updated)})` : '.'),
    );

    const [{ count }] = (await queryRunner.query(
      `SELECT COUNT(*)::int AS count FROM cargos WHERE map_record_id IS NULL`,
    )) as { count: number }[];
    if (count > 0) {
      console.warn(
        `BackfillCargoMapRecordId: ${count} cargo row(s) left with no map_record_id — their ` +
          'destination zone was deleted or itself unresolved. Review manually if needed.',
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Backfill is a best-effort data repair, not a schema change — reverting it would throw away
    // a manual re-run's chance to redo the same (idempotent) matching, so this is a no-op.
    await queryRunner.query('SELECT 1');
  }
}
