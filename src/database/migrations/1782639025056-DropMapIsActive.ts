import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropMapIsActive1782639025056 implements MigrationInterface {
  name = 'DropMapIsActive1782639025056';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "map_records" DROP COLUMN "is_active"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "map_records" ADD "is_active" boolean NOT NULL DEFAULT true`,
    );
  }
}
