import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddZoneColor1793000000000 implements MigrationInterface {
  name = 'AddZoneColor1793000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE zones
      ADD COLUMN IF NOT EXISTS color VARCHAR(9)
    `);

    // Backfill existing zones with a random hue from the curated palette so they
    // render distinctly on the map straight away. New zones get a color assigned
    // by ZoneService (least-used palette hue); this only touches legacy rows.
    await queryRunner.query(`
      UPDATE zones
      SET color = (ARRAY[
        '#2563eb','#dc2626','#16a34a','#d97706','#7c3aed',
        '#0891b2','#db2777','#65a30d','#ea580c','#0d9488',
        '#9333ea','#ca8a04','#e11d48','#4f46e5','#059669',
        '#c026d3','#0284c7','#b45309','#15803d','#be123c'
      ])[floor(random() * 20) + 1]
      WHERE color IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE zones
      DROP COLUMN IF EXISTS color
    `);
  }
}
