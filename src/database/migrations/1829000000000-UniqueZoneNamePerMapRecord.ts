import { MigrationInterface, QueryRunner } from 'typeorm';

const NAME_MAX_LENGTH = 255;
const ID_SUFFIX_LENGTH = '-'.length + 36;

export class UniqueZoneNamePerMapRecord1829000000000 implements MigrationInterface {
  name = 'UniqueZoneNamePerMapRecord1829000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY map_record_id, name
                 ORDER BY created_at, id
               ) AS occurrence
          FROM zones
         WHERE map_record_id IS NOT NULL
           AND deleted_at IS NULL
      )
      UPDATE zones
         SET name = LEFT(zones.name, ${NAME_MAX_LENGTH - ID_SUFFIX_LENGTH}) || '-' || zones.id::text,
             updated_at = now()
        FROM ranked
       WHERE zones.id = ranked.id
         AND ranked.occurrence > 1
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_zones_name_map_record
        ON zones (map_record_id, name)
        WHERE map_record_id IS NOT NULL AND deleted_at IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_zones_name_map_record`);
  }
}
