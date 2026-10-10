import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameLegOrderNamesInTaskMetadata1801000000000 implements MigrationInterface {
  name = 'RenameLegOrderNamesInTaskMetadata1801000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE transport_requests
      SET metadata = (metadata - 'to1Name')
        || jsonb_build_object('pickupOrderName', metadata -> 'to1Name')
      WHERE metadata ? 'to1Name'
    `);
    await queryRunner.query(`
      UPDATE transport_requests
      SET metadata = (metadata - 'to3Name')
        || jsonb_build_object('dropoffOrderName', metadata -> 'to3Name')
      WHERE metadata ? 'to3Name'
    `);
    await queryRunner.query(`
      UPDATE transport_requests
      SET metadata = metadata - 'to2Name'
      WHERE metadata ? 'to2Name'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE transport_requests
      SET metadata = (metadata - 'pickupOrderName')
        || jsonb_build_object('to1Name', metadata -> 'pickupOrderName')
      WHERE metadata ? 'pickupOrderName'
    `);
    await queryRunner.query(`
      UPDATE transport_requests
      SET metadata = (metadata - 'dropoffOrderName')
        || jsonb_build_object('to3Name', metadata -> 'dropoffOrderName')
      WHERE metadata ? 'dropoffOrderName'
    `);
  }
}
