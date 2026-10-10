import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { MapsController } from '../src/maps/api/maps.controller';
import { MapLibraryService } from '../src/maps/application/map-library.service';
import { KernelMapService } from '../src/maps/application/kernel-map.service';
import { MapRecordEntity } from '../src/maps/infrastructure/entities/map-record.entity';
import { ZoneEntity } from '../src/zones/entities/zone.entity';
import { ZoneService } from '../src/zones/zone.service';
import { ActiveMapRecordService } from '../src/maps/infrastructure/active-map-record.service';
import { KernelApiService } from '../src/opentcs/kernel-api.service';
import { VehicleStateStore } from '../src/opentcs/vehicle-state.store';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import type { AuthUser } from '../src/auth/jwt-payload';

const VALID_XML = `<?xml version="1.0" encoding="UTF-8"?>
  <model name="factory-a">
    <point name="P1" positionX="100" positionY="200" positionZ="0" type="HALT_POSITION" />
    <visualLayout name="layout" scaleX="1" scaleY="1" />
  </model>`;

const record = (overrides: Partial<MapRecordEntity> = {}): MapRecordEntity => ({
  id: 'map-a',
  name: 'factory-a',
  originalFilename: 'factory-a.xml',
  pointCount: 1,
  pathCount: 0,
  vehicleCount: 0,
  locationCount: 0,
  blockCount: 0,
  xmlContent: VALID_XML,
  preview: { previewVersion: 1, points: [], paths: [] },
  uploadedAt: new Date('2026-09-14T00:00:00Z'),
  uploadedById: 'user-1',
  lastLoadedAt: null,
  deletedAt: null,
  ...overrides,
});

interface RequestWithUser {
  user?: Partial<AuthUser>;
}

function guardWithMapIds(mapIds: string[] | undefined) {
  return class AsUser {
    canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest<RequestWithUser>();
      req.user = {
        sub: 'user-1',
        username: 'test',
        role: 'actor',
        roles: ['actor'],
        perms: ['map.view', 'map.download', 'map.upload'],
        mapIds,
      };
      return true;
    }
  };
}

describe('Maps AUTH-3 map scope (e2e)', () => {
  let app: INestApplication<App>;
  let mapRepo: { find: jest.Mock; findOne: jest.Mock; update: jest.Mock };
  let zoneRepo: { find: jest.Mock };

  async function buildApp(
    mapIds: string[] | undefined,
    activeId: string | null = null,
  ) {
    mapRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    zoneRepo = { find: jest.fn().mockResolvedValue([]) };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [MapsController],
      providers: [
        MapLibraryService,
        {
          provide: KernelMapService,
          useValue: { getPlantModelXml: () => Promise.resolve('<model/>') },
        },
        { provide: VehicleStateStore, useValue: {} },
        {
          provide: KernelApiService,
          useValue: { getPlantModelName: jest.fn().mockResolvedValue(null) },
        },
        { provide: getRepositoryToken(MapRecordEntity), useValue: mapRepo },
        { provide: getRepositoryToken(ZoneEntity), useValue: zoneRepo },
        { provide: ZoneService, useValue: { sync: jest.fn() } },
        {
          provide: ActiveMapRecordService,
          useValue: { resolveId: jest.fn().mockResolvedValue(activeId) },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(guardWithMapIds(mapIds))
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  }

  afterEach(async () => {
    await app.close();
  });

  describe('a role with no scope rows (mapIds undefined) — unrestricted, identical to today', () => {
    it('GET /maps/library returns every record, unfiltered', async () => {
      await buildApp(undefined);
      mapRepo.find.mockResolvedValue([
        record({ id: 'map-a' }),
        record({ id: 'map-b' }),
      ]);

      const res = await request(app.getHttpServer())
        .get('/maps/library')
        .expect(200);
      expect(
        (res.body as unknown[]).map((m) => (m as { id: string }).id),
      ).toEqual(['map-a', 'map-b']);
    });

    it('GET /maps/library/:id succeeds for any id', async () => {
      await buildApp(undefined);
      mapRepo.findOne.mockResolvedValue(record({ id: 'map-b' }));

      await request(app.getHttpServer()).get('/maps/library/map-b').expect(200);
    });
  });

  describe('a role scoped to a specific map', () => {
    it('cannot bypass library scope through the live XML alias', async () => {
      await buildApp(['map-a'], 'map-b');
      await request(app.getHttpServer())
        .get('/maps/plant-model/xml')
        .expect(403);
    });

    it('can download the live XML when its active map is in scope', async () => {
      await buildApp(['map-a'], 'map-a');
      await request(app.getHttpServer())
        .get('/maps/plant-model/xml')
        .expect(200, '<model/>');
    });

    it('cannot download or load an out-of-scope library record', async () => {
      await buildApp(['map-a']);
      mapRepo.findOne.mockResolvedValue(record({ id: 'map-b' }));
      await request(app.getHttpServer())
        .get('/maps/library/map-b/xml')
        .expect(403);
      await request(app.getHttpServer())
        .post('/maps/library/map-b/load')
        .expect(403);
    });
    it('GET /maps/library is filtered to just the scoped map', async () => {
      await buildApp(['map-a']);
      mapRepo.find.mockResolvedValue([record({ id: 'map-a' })]);

      const res = await request(app.getHttpServer())
        .get('/maps/library')
        .expect(200);
      expect(
        (res.body as unknown[]).map((m) => (m as { id: string }).id),
      ).toEqual(['map-a']);
      expect(mapRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: expect.objectContaining({ _value: ['map-a'] }),
          }),
        }),
      );
    });

    it('GET /maps/library/:id 403s for a map outside the scope', async () => {
      await buildApp(['map-a']);
      mapRepo.findOne.mockResolvedValue(record({ id: 'map-b' }));

      const res = await request(app.getHttpServer())
        .get('/maps/library/map-b')
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        'Vai trò của bạn không được gán quyền thao tác trên bản đồ này.',
      );
    });

    it('GET /maps/library/:id succeeds for the in-scope map', async () => {
      await buildApp(['map-a']);
      mapRepo.findOne.mockResolvedValue(record({ id: 'map-a' }));

      await request(app.getHttpServer()).get('/maps/library/map-a').expect(200);
    });
  });
});
