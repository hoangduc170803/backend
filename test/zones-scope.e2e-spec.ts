import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { Server } from 'node:http';
import { ZoneController } from '../src/zones/zone.controller';
import { ZoneService } from '../src/zones/zone.service';
import { ZoneEntity } from '../src/zones/entities/zone.entity';
import { ZoneMemberEntity } from '../src/zones/entities/zone-member.entity';
import { ZoneLocationWriter } from '../src/zones/zone-location.writer';
import { ZoneUsageQuery } from '../src/zones/zone-usage.query';
import { KernelApiService } from '../src/opentcs/kernel-api.service';
import { ActiveMapRecordService } from '../src/maps/infrastructure/active-map-record.service';
import { PermissionsService } from '../src/auth/permissions.service';

describe('legacy Zones API resource authorization', () => {
  let app: INestApplication<Server>;
  const zoneRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    softDelete: jest.fn(),
  };
  const user = {
    sub: 'user',
    perms: ['area.edit', 'area.delete', 'area.create', 'area.sync_kernel'],
    mapIds: ['map-a'],
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    zoneRepo.find.mockResolvedValue([]);
    zoneRepo.findOne.mockResolvedValue({
      id: 'zone-b',
      mapRecordId: 'map-b',
      members: [],
    });
    const module = await Test.createTestingModule({
      controllers: [ZoneController],
      providers: [
        ZoneService,
        {
          provide: PermissionsService,
          useValue: {
            resolveAuthUserForApiKey: (token: string) =>
              Promise.resolve(token === 'test-api-key' ? user : null),
          },
        },
        { provide: DataSource, useValue: {} },
        { provide: getRepositoryToken(ZoneEntity), useValue: zoneRepo },
        { provide: getRepositoryToken(ZoneMemberEntity), useValue: {} },
        {
          provide: ActiveMapRecordService,
          useValue: { resolveId: () => Promise.resolve('map-a') },
        },
        { provide: ZoneLocationWriter, useValue: {} },
        { provide: ZoneUsageQuery, useValue: {} },
        { provide: KernelApiService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects out-of-scope edits and deletes before mutating repositories', async () => {
    await request(app.getHttpServer())
      .patch('/zones/zone-b')
      .auth('test-api-key', { type: 'bearer' })
      .send({ color: '#ff0000' })
      .expect(403);
    await request(app.getHttpServer())
      .delete('/zones/zone-b')
      .auth('test-api-key', { type: 'bearer' })
      .expect(403);
    expect(zoneRepo.save).not.toHaveBeenCalled();
    expect(zoneRepo.softDelete).not.toHaveBeenCalled();
  });

  it('scopes allMaps at the repository query', async () => {
    await request(app.getHttpServer())
      .get('/zones?allMaps=true')
      .auth('test-api-key', { type: 'bearer' })
      .expect(200, []);
    expect(zoneRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          mapRecordId: expect.objectContaining({
            _type: 'in',
            _value: ['map-a'],
          }),
        },
      }),
    );
  });

  it('keeps authentication and capabilities enforced by real guards', async () => {
    await request(app.getHttpServer())
      .delete('/zones/zone-b')
      .auth('revoked-key', { type: 'bearer' })
      .expect(401);
    const perms = user.perms;
    user.perms = [];
    try {
      await request(app.getHttpServer())
        .delete('/zones/zone-b')
        .auth('test-api-key', { type: 'bearer' })
        .expect(403);
      expect(zoneRepo.findOne).not.toHaveBeenCalled();
    } finally {
      user.perms = perms;
    }
  });
});
