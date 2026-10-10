import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppModule } from '../app.module';
import { UsersService } from '../users/users.service';
import { AgvEntity } from '../agvs/entities/agv.entity';
import { RoleEntity } from '../users/entities/role.entity';
import { PermissionCatalogueService } from '../auth/permission-catalogue.service';

const AGV_COUNT = 20;

async function seedRoles(
  roles: Repository<RoleEntity>,
  log: Logger,
): Promise<void> {
  const defaults: Array<
    Pick<RoleEntity, 'key' | 'name' | 'description' | 'isSystem'> &
      Partial<Pick<RoleEntity, 'fullAccess'>>
  > = [
    {
      key: 'admin',
      name: 'Quản trị viên',
      description: 'Toàn quyền hệ thống',
      isSystem: true,
      fullAccess: true,
    },
    {
      key: 'dev',
      name: 'Dev',
      description: 'Mọi chức năng và thông tin kỹ thuật, trừ phân quyền',
      isSystem: true,
    },
    {
      key: 'tester',
      name: 'Tester',
      description:
        'Quyền Điều phối viên + máy quét, tài liệu API, công cụ AGV, tạo hàng theo lịch',
      isSystem: true,
    },
    {
      key: 'dispatcher',
      name: 'Điều phối viên',
      description: 'Quyền Operator + tạo và quản lý nhiệm vụ',
      isSystem: true,
    },
    {
      key: 'operator',
      name: 'Operator',
      description:
        'Quyền Scanner + Mapper, quản lý xe, gửi xe tới điểm, điều khiển đội xe, quản lý hàng',
      isSystem: true,
    },
    {
      key: 'mapper',
      name: 'Mapper',
      description: 'Quyền Viewer + khu vực, bản đồ',
      isSystem: true,
    },
    {
      key: 'scanner',
      name: 'Scanner',
      description: 'Quyền Viewer + thêm / xoá hàng, API kiểm tra hàng',
      isSystem: true,
    },
    {
      key: 'viewer',
      name: 'Viewer',
      description: 'Chỉ xem màn Vận hành ở mức đơn giản',
      isSystem: true,
    },
  ];

  for (const role of defaults) {
    await roles.upsert(role, ['key']);
  }
  log.log(`Ensured roles: ${defaults.map((role) => role.key).join(', ')}`);
}

async function seedAdmin(users: UsersService, log: Logger): Promise<void> {
  const password = 'Wes@1234';

  const existing = await users.findByUsername('quan.tran');
  if (existing) {
    await users.setPassword(existing.id, password);
    await users.setRole(existing.id, 'admin');
    log.log('Admin "quan.tran" already exists — password reset to Wes@1234.');
    return;
  }

  await users.createUser({
    name: 'Trần Minh Quân',
    username: 'quan.tran',
    email: 'quan.tran@wes.vn',
    phone: '0901 234 567',
    shift: 'Hành chính · Điều phối',
    role: 'admin',
    sendInvite: false,
    password,
  });

  log.log('Seeded admin → username: quan.tran  password: Wes@1234');
}

async function seedAgvs(
  agvRepo: Repository<AgvEntity>,
  log: Logger,
): Promise<void> {
  let created = 0;
  for (let i = 1; i <= AGV_COUNT; i++) {
    const name = `Vehicle-${String(i).padStart(4, '0')}`;
    if (await agvRepo.findOne({ where: { name } })) continue;
    await agvRepo.save(agvRepo.create({ code: name, name }));
    created++;
  }
  log.log(
    `Seeded ${created} AGV(s) (Vehicle-0001 → Vehicle-${String(AGV_COUNT).padStart(4, '0')}); ${AGV_COUNT - created} already existed.`,
  );
}

/**
 * Seed an initial admin so the first login works, plus the AGV fleet registry.
 * Run after applying database/schema.sql:  npm run seed
 */
async function run() {
  const log = new Logger('Seed');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  await seedRoles(
    app.get<Repository<RoleEntity>>(getRepositoryToken(RoleEntity)),
    log,
  );

  const catalogue = app.get(PermissionCatalogueService);
  await catalogue.syncCatalogue();
  await catalogue.seedSystemGrants();
  log.log('Ensured permission catalogue + system role grants.');

  await seedAdmin(app.get(UsersService), log);
  await seedAgvs(
    app.get<Repository<AgvEntity>>(getRepositoryToken(AgvEntity)),
    log,
  );

  await app.close();
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
