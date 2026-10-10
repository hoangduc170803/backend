import { MigrationInterface, QueryRunner } from 'typeorm';

/** New manual "stop charging" vehicle action — grant it to every role that already holds the
 *  sibling vehicle-control permissions (pause/withdraw/etc.), not just newly-seeded installs. */
export class AddVehicleStopChargingCapability1818000000000
  implements MigrationInterface
{
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`INSERT INTO permissions (key, cluster, is_dangerous, label_vi, label_en, label_ja) VALUES
      ('vehicle.stop_charging', 'vehicle', false, 'Dừng sạc xe ngay lập tức', 'Stop vehicle charging immediately', '車両の充電を即時停止') ON CONFLICT (key) DO NOTHING`);
    await queryRunner.query(`INSERT INTO role_permissions (role_id, permission_key)
      SELECT rp.role_id, 'vehicle.stop_charging'
      FROM role_permissions rp
      WHERE rp.permission_key = 'vehicle.pause'
      ON CONFLICT DO NOTHING`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM permissions WHERE key = 'vehicle.stop_charging'`,
    );
  }
}
