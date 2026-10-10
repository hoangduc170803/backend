import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAdministrationCapabilities1812000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Preserve the existing admin-only endpoints now that they're gated by these capabilities instead of a hardcoded role.
    await queryRunner.query(`INSERT INTO permissions (key, cluster, is_dangerous, label_vi, label_en, label_ja) VALUES
      ('agvs.manage', 'admin', true, 'Quản lý đăng ký AGV', 'Manage AGV registry', 'AGV登録管理'),
      ('dispatch.manage', 'admin', true, 'Quản lý chính sách điều phối', 'Manage dispatch policies', '配車ポリシー管理') ON CONFLICT (key) DO NOTHING`);
    await queryRunner.query(`INSERT INTO role_permissions (role_id, permission_key)
      SELECT id, p.key FROM roles CROSS JOIN (VALUES ('agvs.manage'), ('dispatch.manage')) p(key)
      WHERE roles.key = 'admin' ON CONFLICT DO NOTHING`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM permissions WHERE key IN ('agvs.manage', 'dispatch.manage')`,
    );
  }
}
