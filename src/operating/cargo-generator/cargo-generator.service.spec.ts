import { ConflictException } from '@nestjs/common';
import {
  CargoGeneratorService,
  cancellableSleep,
} from './cargo-generator.service';
import type { CargoGeneratorConfigDto } from './cargo-generator.dto';

const config: CargoGeneratorConfigDto = {
  zoneIds: ['zone-1'],
  storeIds: ['store-1'],
  mode: 'all',
  batchSize: 2,
  delaySec: 0,
  intervalSec: 60,
};

const operator = (username: string) => ({
  userId: `id-${username}`,
  username,
  canDeleteCargo: false,
});

const member = (areaId: string, point: string) => ({
  wesId: `${areaId}-${point}`,
  areaId,
  opentcsLocationName: `L-${point}`,
  opentcsPointName: point,
  priority: 0,
  state: 'FREE' as const,
  cargoId: null,
});

const area = (wesId: string, kind: 'ZONE' | 'STORE', points: string[]) => ({
  wesId,
  name: wesId,
  kind,
  operation: '',
  maxVehicles: null,
  color: null,
  plantModelName: null,
  status: 'ACTIVE' as const,
  members: points.map((point) => member(wesId, point)),
});

function makeService() {
  const created: string[] = [];
  const cargos: { status: string; pickupPointName: string }[] = [];
  const cargo = {
    list: jest.fn(() =>
      Promise.resolve({ cargos, total: 0, truncated: false }),
    ),
    create: jest.fn((body: { pickupPointName: string }) => {
      created.push(body.pickupPointName);
      cargos.push({ status: 'QUEUED', pickupPointName: body.pickupPointName });
      return Promise.resolve({ itemCode: `C-${created.length}` });
    }),
    cancelMany: jest.fn(),
  };
  const areas = {
    list: jest.fn(() =>
      Promise.resolve([
        area('zone-1', 'ZONE', ['P1', 'P2']),
        area('store-1', 'STORE', ['S1', 'S2', 'S3']),
      ]),
    ),
  };
  const plantModel = {
    points: jest.fn(() =>
      Promise.resolve({
        modelName: 'm',
        points: [
          { name: 'P1', x: 0, y: 0 },
          { name: 'P2', x: 0, y: 1000 },
        ],
      }),
    ),
    paths: jest.fn(() => Promise.resolve([])),
  };
  const service = new CargoGeneratorService(
    areas as never,
    cargo as never,
    plantModel as never,
  );
  return { service, cargo, created };
}

const settle = async (service: CargoGeneratorService) => {
  for (let i = 0; i < 200 && service.state().phase !== 'waiting'; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

describe('cancellableSleep', () => {
  it('ends as soon as the signal aborts', async () => {
    const abort = new AbortController();
    const sleeping = cancellableSleep(60_000, abort.signal);
    abort.abort();
    await expect(sleeping).resolves.toBeUndefined();
  });
});

describe('CargoGeneratorService', () => {
  it('fills every free zone point, then waits for the next round', async () => {
    const { service, created } = makeService();
    service.start(config, operator('alice'));
    await settle(service);
    const state = service.state();
    service.stop('alice');

    expect([...created].sort()).toEqual(['P1', 'P2']);
    expect(state.phase).toBe('waiting');
    expect(state.createdTotal).toBe(2);
    expect(state.rounds).toBe(1);
    expect(state.nextRoundAt).not.toBeNull();
    expect(state.startedBy).toEqual({ userId: 'id-alice', username: 'alice' });
  });

  it('refuses a second session while one is running', async () => {
    const { service } = makeService();
    service.start(config, operator('alice'));
    expect(() => service.start(config, operator('bob'))).toThrow(
      ConflictException,
    );
    await settle(service);
    service.stop('bob');
  });

  it('lets another user stop the session and start a new one', async () => {
    const { service } = makeService();
    service.start(config, operator('alice'));
    await settle(service);
    expect(service.stop('bob').phase).toBe('idle');
    expect(service.state().log[0]).toMatchObject({
      key: 'stoppedBy',
      vars: { user: 'bob' },
    });
    expect(service.start(config, operator('bob')).startedBy?.username).toBe(
      'bob',
    );
    await settle(service);
    service.stop('bob');
  });

  it('keeps statistics while a session runs', async () => {
    const { service } = makeService();
    service.start(config, operator('alice'));
    expect(() => service.resetStatistics()).toThrow(ConflictException);
    await settle(service);
    service.stop('alice');
    expect(service.resetStatistics().createdTotal).toBe(0);
  });
});
