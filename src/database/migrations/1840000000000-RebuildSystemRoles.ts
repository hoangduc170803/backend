import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The system roles become a ladder — viewer, scanner, mapper, operator, dispatcher, tester, dev —
 * each holding everything of the tier before it (admin stays the full-access role). The missing
 * roles are created and every ladder role loses its grants, so `PermissionCatalogueService`
 * re-seeds it from `SYSTEM_ROLE_GRANTS` at the next boot.
 */
export class RebuildSystemRoles1840000000000 implements MigrationInterface {
  name = 'RebuildSystemRoles1840000000000';

  private readonly roles: [key: string, name: string, description: string][] = [
    ['dev', 'Dev', 'Mọi chức năng và thông tin kỹ thuật, trừ phân quyền'],
    [
      'tester',
      'Tester',
      'Quyền Điều phối viên + máy quét, tài liệu API, công cụ AGV, tạo hàng theo lịch',
    ],
    [
      'dispatcher',
      'Điều phối viên',
      'Quyền Operator + tạo và quản lý nhiệm vụ',
    ],
    [
      'operator',
      'Operator',
      'Quyền Scanner + Mapper, quản lý xe, gửi xe tới điểm, điều khiển đội xe, quản lý hàng',
    ],
    ['mapper', 'Mapper', 'Quyền Viewer + khu vực, bản đồ'],
    ['scanner', 'Scanner', 'Quyền Viewer + thêm / xoá hàng, API kiểm tra hàng'],
    ['viewer', 'Viewer', 'Chỉ xem màn Vận hành ở mức đơn giản'],
  ];

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const [key, name, description] of this.roles) {
      await queryRunner.query(
        `INSERT INTO roles (key, name, description, is_system)
         SELECT $1::varchar, $2::varchar, $3::text, true
         WHERE NOT EXISTS (SELECT 1 FROM roles WHERE key = $1::varchar)`,
        [key, name, description],
      );
      await queryRunner.query(
        `UPDATE roles
         SET name = $2::varchar, description = $3::text, is_system = true, full_access = false
         WHERE key = $1::varchar`,
        [key, name, description],
      );
    }
    await queryRunner.query(
      `DELETE FROM role_permissions
       WHERE role_id IN (SELECT id FROM roles WHERE key = ANY($1::varchar[]))`,
      [this.roles.map(([key]) => key)],
    );
  }

  async down(): Promise<void> {}
}
