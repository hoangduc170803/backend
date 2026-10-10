import { ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { CargoService } from '../cargo/cargo.service';
import { CargoStatus } from '../cargo/entities/cargo.entity';
import { TaskStatus } from '../cargo/entities/transport-task.entity';
import type { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import {
  ZoneEntity,
  ZoneStatus,
  ZoneType,
} from '../zones/entities/zone.entity';
import { LegacyFmsCargoService } from './legacy-fms-cargo.service';

const MAP_ID = 'map-1';
const BODY = { name: 'abc', position: '0110', destination: 'Kho-A' };

const store = {
  id: 'zone-a',
  name: 'Kho-A',
  type: ZoneType.DROPOFF,
  status: ZoneStatus.ACTIVE,
  members: [],
} as unknown as ZoneEntity;

function setup(zone: ZoneEntity | null = store) {
  const cargo = {
    inspectSource: jest.fn().mockResolvedValue('AVAILABLE'),
    hasRoomIn: jest.fn().mockResolvedValue(true),
    create: jest.fn().mockResolvedValue({ id: 'cargo-1' }),
    findOne: jest.fn().mockResolvedValue({
      id: 'cargo-1',
      itemCode: 'abc',
      sourcePointName: '0110',
      reservedLocationName: null,
      status: CargoStatus.ACTIVE,
      taskStatus: TaskStatus.CREATED,
      visual: { state: 'AT_SOURCE', pointName: '0110', vehicleName: null },
      createdAt: new Date('2026-09-28T00:00:00Z'),
      updatedAt: new Date('2026-09-28T00:00:00Z'),
      deletedAt: null,
    }),
  };
  const activeMap = { id: jest.fn().mockResolvedValue(MAP_ID) };
  const zoneRepo = { findOne: jest.fn().mockResolvedValue(zone) };
  const service = new LegacyFmsCargoService(
    cargo as unknown as CargoService,
    activeMap as unknown as ActiveMapContext,
    zoneRepo as unknown as Repository<ZoneEntity>,
  );
  return { service, cargo, zoneRepo };
}

describe('LegacyFmsCargoService', () => {
  it('creates the cargo on WES and answers with the legacy CargoDTO shape', async () => {
    const { service, cargo, zoneRepo } = setup();

    const result = await service.createCargo(BODY, 'user-1');

    expect(zoneRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mapRecordId: MAP_ID, name: 'Kho-A' },
      }),
    );

    expect(cargo.create).toHaveBeenCalledWith(
      { itemCode: 'abc', sourcePointName: '0110', destinationZoneId: store.id },
      'user-1',
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: 'cargo-1',
        name: 'abc',
        initialPosition: '0110',
        position: '0110',
        destination: 'Kho-A',
        state: 'NONE',
        createAt: '2026-09-28T00:00:00.000Z',
      }),
    );
  });

  it('checks the destination before the position, like the legacy FMS', async () => {
    const { service, cargo } = setup(null);

    await expect(service.createCargo(BODY, 'user-1')).rejects.toMatchObject({
      code: 40003,
      message: 'Destination does not exist',
    });
    expect(cargo.inspectSource).not.toHaveBeenCalled();
  });

  it('rejects a PICKUP zone as not a SHIPPING location', async () => {
    const { service } = setup({ ...store, type: ZoneType.PICKUP });

    await expect(
      service.assertDestinationAvailable('Kho-A'),
    ).rejects.toMatchObject({ code: 40004 });
  });

  it('reports a full destination as 40903', async () => {
    const { service, cargo } = setup();
    cargo.hasRoomIn.mockResolvedValue(false);

    await expect(
      service.assertDestinationAvailable('Kho-A'),
    ).rejects.toMatchObject({ code: 40903, message: 'Destination full' });
  });

  it.each([
    ['POINT_NOT_FOUND', 40002],
    ['NOT_PICKUP_POINT', 40001],
    ['OCCUPIED_BY_CARGO', 40901],
    ['LANE_COMMITTED', 40902],
  ])('maps source %s to legacy code %i', async (availability, code) => {
    const { service, cargo } = setup();
    cargo.inspectSource.mockResolvedValue(availability);

    await expect(service.assertPositionAvailable('0110')).rejects.toMatchObject(
      { code },
    );
  });

  it('answers the legacy availability bodies', async () => {
    const { service } = setup();

    await expect(service.assertPositionAvailable('0110')).resolves.toEqual({
      'Position available': true,
    });
    await expect(service.assertDestinationAvailable('Kho-A')).resolves.toEqual({
      'Destination available': true,
    });
  });

  it('turns a duplicate item code into the legacy NAME_EXISTS error', async () => {
    const { service, cargo } = setup();
    cargo.create.mockRejectedValue(new ConflictException('dup'));

    await expect(service.createCargo(BODY, 'user-1')).rejects.toMatchObject({
      code: 40900,
      message: 'Name already exists',
    });
  });

  it('refuses a caller whose map scope excludes the loaded map', async () => {
    const { service } = setup();

    await expect(
      service.assertPositionAvailable('0110', ['other-map']),
    ).rejects.toMatchObject({ status: 403 });
  });
});
