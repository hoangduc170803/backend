import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `roles.full_access` marks a role as admin: it always holds the whole permission catalogue,
 * including keys added later. The operator role loses the engineering screens (Map, Obstacles,
 * Transport orders, Scanner, Tools) and the minimap; an admin can tick them back in the role
 * editor.
 */
export class AddRoleFullAccessAndSimplifyOperator1839000000000 implements MigrationInterface {
  name = 'AddRoleFullAccessAndSimplifyOperator1839000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE roles
        ADD COLUMN IF NOT EXISTS full_access boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(
      `UPDATE roles SET full_access = true WHERE key = 'admin'`,
    );
    await queryRunner.query(`
      DELETE FROM role_permissions rp
      USING roles r, permissions p
      WHERE rp.role_id = r.id
        AND p.key = rp.permission_key
        AND r.key = 'operator'
        AND (
          p.screen IN ('map', 'obstacles', 'transport_orders', 'scanner', 'tools')
          OR p.key = 'op.map.minimap'
        )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE roles DROP COLUMN IF EXISTS full_access`,
    );
  }
}
