import { MigrationInterface, QueryRunner } from 'typeorm';

export class BackfillTransportRequestMapRecordId1824000000000 implements MigrationInterface {
  name = 'BackfillTransportRequestMapRecordId1824000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE transport_requests
      SET map_record_id = cargos.map_record_id
      FROM cargos
      WHERE transport_requests.cargo_id = cargos.id
        AND transport_requests.map_record_id IS NULL
        AND cargos.map_record_id IS NOT NULL
    `);

    const [{ count }] = (await queryRunner.query(
      `SELECT COUNT(*)::int AS count FROM transport_requests WHERE map_record_id IS NULL`,
    )) as { count: number }[];
    if (count > 0) {
      console.warn(
        `BackfillTransportRequestMapRecordId: ${count} task row(s) left with no map_record_id — ` +
          'their cargo has no resolved map record. They will never be dispatched again.',
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SELECT 1');
  }
}
