import { MigrationInterface, QueryRunner } from 'typeorm';

const NAME_MAX_LENGTH = 255;
const SHORT_ID_LENGTH = 8;
const SHORT_SUFFIX_LENGTH = '-'.length + SHORT_ID_LENGTH;

export class SuffixDuplicateZoneNamesAcrossMaps1830000000000 implements MigrationInterface {
  name = 'SuffixDuplicateZoneNamesAcrossMaps1830000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE zones
         SET name = LEFT(zones.name, LENGTH(zones.name) - 36) || LEFT(zones.id::text, ${SHORT_ID_LENGTH}),
             updated_at = now()
       WHERE zones.deleted_at IS NULL
         AND zones.name LIKE '%-' || zones.id::text
    `);
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at, id) AS occurrence
          FROM zones
         WHERE deleted_at IS NULL
      )
      UPDATE zones
         SET name = LEFT(zones.name, ${NAME_MAX_LENGTH - SHORT_SUFFIX_LENGTH}) || '-' || LEFT(zones.id::text, ${SHORT_ID_LENGTH}),
             updated_at = now()
        FROM ranked
       WHERE zones.id = ranked.id
         AND ranked.occurrence > 1
    `);
  }

  async down(): Promise<void> {}
}
