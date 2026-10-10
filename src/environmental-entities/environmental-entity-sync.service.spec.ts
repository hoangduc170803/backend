import { CargoEntity, CargoStatus } from '../cargo/entities/cargo.entity';
import {
  EntityDesiredState,
  EntitySyncErrorKind,
  EntitySyncStatus,
} from './entities/cargo-environmental-entity.entity';
import { EnvironmentalEntitySyncService } from './environmental-entity-sync.service';
import {
  FakeKernel,
  InMemoryEntitySyncStore,
  InProcessEntitySyncLock,
  connectionRefused,
  deliveredCargo,
  httpError,
  timeoutError,
} from './entity-sync.testing';

const START = new Date('2026-09-26T08:00:00Z');

function setup(activeMapId: string | null = 'map-a') {
  const store = new InMemoryEntitySyncStore();
  const kernel = new FakeKernel()
    .withPoint({ name: 'D1', x: 47367, y: 25638 }, 'location_D1')
    .withPoint(
      { name: 'D2', x: 1000, y: 2000, z: 5, orientation: 90 },
      'location_D2',
    );
  const emitted: unknown[] = [];
  const service = new EnvironmentalEntitySyncService(
    store,
    new InProcessEntitySyncLock(),
    kernel as never,
    { id: () => Promise.resolve(activeMapId) } as never,
    { resolveId: () => Promise.resolve(activeMapId) } as never,
    { emit: (...args: unknown[]) => emitted.push(args) } as never,
  );

  const sync = async () => {
    await service.syncNow();
    await service.settled();
  };
  const present = (cargo: CargoEntity, taskId: string | null) => {
    if (!store.cargos.includes(cargo)) store.cargos.push(cargo);
    return service.markPresent(cargo, taskId);
  };
  const later = async (ms: number) => {
    jest.setSystemTime(new Date(Date.now() + ms));
    await sync();
  };
  return { store, kernel, service, sync, later, emitted, present };
}

describe('EnvironmentalEntitySyncService', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    jest.setSystemTime(START);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('delivered cargo', () => {
    it('creates exactly one OBJECT entity, respected by traffic, and stores its name', async () => {
      const { store, kernel, sync, present } = setup();
      const cargo = deliveredCargo();

      await present(cargo, 'task-1');
      await sync();

      const row = store.row(cargo.id);
      expect(row.syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(row.entityName).toBe(`WES-CARGO-${cargo.id}-g1`);
      expect(row.ackedAt).not.toBeNull();
      expect(kernel.entities.size).toBe(1);
      const entity = kernel.entities.get(row.entityName)!;
      expect(entity.type).toBe('OBJECT');
      expect(entity.integrationLevel).toBe('TO_BE_RESPECTED');
    });

    it('sends an 800 × 740 envelope centred on the drop point, in mm, closed', async () => {
      const { store, kernel, sync, present } = setup();
      const cargo = deliveredCargo();

      await present(cargo, 'task-1');
      await sync();

      const entity = kernel.entities.get(store.row(cargo.id).entityName)!;
      expect(entity.envelope).toEqual({
        vertices: [
          { x: -400, y: -370 },
          { x: 400, y: -370 },
          { x: 400, y: 370 },
          { x: -400, y: 370 },
          { x: -400, y: -370 },
        ],
      });
      expect(entity.pose).toEqual({
        position: { x: 47367, y: 25638, z: 0 },
        orientationAngle: 0,
      });
    });

    it("keeps the drop point's orientation when the plant model has one", async () => {
      const { store, kernel, sync, present } = setup();
      const cargo = deliveredCargo({ destinationLocationName: 'location_D2' });

      await present(cargo, 'task-1');
      await sync();

      const entity = kernel.entities.get(store.row(cargo.id).entityName)!;
      expect(entity.pose).toEqual({
        position: { x: 1000, y: 2000, z: 5 },
        orientationAngle: 90,
      });
      expect(entity.properties['wes:orientationSource']).toBe('POINT');
    });

    it('stamps wes:* trace properties', async () => {
      const { store, kernel, sync, present } = setup();
      const cargo = deliveredCargo({ itemCode: 'PALLET-7' });

      await present(cargo, 'task-9');
      await sync();

      const entity = kernel.entities.get(store.row(cargo.id).entityName)!;
      expect(entity.properties).toMatchObject({
        'wes:cargoId': cargo.id,
        'wes:itemCode': 'PALLET-7',
        'wes:taskId': 'task-9',
        'wes:mapRecordId': 'map-a',
        'wes:destinationLocation': 'location_D1',
        'wes:status': 'DELIVERED',
      });
      expect(
        Object.keys(entity.properties).every((key) => key.startsWith('wes:')),
      ).toBe(true);
    });

    it('is idempotent when the same cargo is marked twice', async () => {
      const { store, kernel, sync, present } = setup();
      const cargo = deliveredCargo();

      await present(cargo, 'task-1');
      await present(cargo, 'task-1');
      await sync();

      expect(store.rows).toHaveLength(1);
      expect(kernel.callsOf('create')).toBe(1);
    });
  });

  describe('ACK and retry on CREATE', () => {
    it('recognises a CREATE that timed out after openTCS already created it', async () => {
      const { store, kernel, sync, later, present } = setup();
      kernel.failNext('createAfterSuccess', timeoutError());
      const cargo = deliveredCargo();

      await present(cargo, 'task-1');
      await sync();
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.RETRYING);

      await later(60_000);

      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(kernel.callsOf('create')).toBe(1);
      expect(kernel.entities.size).toBe(1);
    });

    it('retries a 5xx with exponential backoff and keeps the request', async () => {
      const { store, kernel, sync, later, present } = setup();
      kernel.failNext('create', httpError(500), 2);
      const cargo = deliveredCargo();

      await present(cargo, 'task-1');
      await sync();
      const first = store.row(cargo.id);
      expect(first.syncStatus).toBe(EntitySyncStatus.RETRYING);
      expect(first.errorKind).toBe(EntitySyncErrorKind.RETRYABLE);
      expect(first.lastError).toContain('HTTP 500');
      expect(first.nextRetryAt!.getTime() - START.getTime()).toBe(2_000);

      await sync();
      expect(kernel.callsOf('create')).toBe(1);

      await later(2_000);
      expect(store.row(cargo.id).nextRetryAt!.getTime() - Date.now()).toBe(
        4_000,
      );

      await later(4_000);
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(kernel.entities.size).toBe(1);
    });

    it('never creates a second entity however many retries it takes', async () => {
      const { store, kernel, sync, later, present } = setup();
      kernel
        .failNext('create', connectionRefused(), 3)
        .failNext('createAfterSuccess', timeoutError(), 1);
      const cargo = deliveredCargo();

      await present(cargo, 'task-1');
      await sync();
      for (let i = 0; i < 6; i++) await later(60_000);

      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(kernel.entities.size).toBe(1);
      expect(
        [...kernel.entities.keys()].every((name) => name.endsWith('-g1')),
      ).toBe(true);
    });

    it('fails a rejected CREATE (4xx) without retrying it blindly', async () => {
      const { store, kernel, sync, later, present } = setup();
      kernel.failNext('create', httpError(400, ['Could not parse JSON input']));
      const cargo = deliveredCargo();

      await present(cargo, 'task-1');
      await sync();
      await later(3_600_000);

      const row = store.row(cargo.id);
      expect(row.syncStatus).toBe(EntitySyncStatus.FAILED);
      expect(row.errorKind).toBe(EntitySyncErrorKind.FATAL);
      expect(row.lastError).toContain('Could not parse JSON input');
      expect(kernel.callsOf('create')).toBe(1);
    });

    it('lets an operator retry a FAILED row by hand', async () => {
      const { store, kernel, service, sync, present } = setup();
      kernel.failNext('create', httpError(400));
      const cargo = deliveredCargo();
      await present(cargo, 'task-1');
      await sync();

      const view = await service.retryNow(cargo.id);

      expect(view.status).toBe(EntitySyncStatus.ACKED);
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(kernel.entities.size).toBe(1);
    });

    it('does not place an obstacle when the drop point cannot be found', async () => {
      const { store, kernel, sync, present } = setup();
      const cargo = deliveredCargo({
        destinationLocationName: 'location_GONE',
      });

      await present(cargo, 'task-1');
      await sync();

      const row = store.row(cargo.id);
      expect(row.syncStatus).toBe(EntitySyncStatus.FAILED);
      expect(row.errorKind).toBe(EntitySyncErrorKind.FATAL);
      expect(row.lastError).toContain('location_GONE');
      expect(kernel.callsOf('create')).toBe(0);
    });

    it('retries while the plant model cannot be read', async () => {
      const { store, kernel, sync, later, present } = setup();
      kernel.modelAvailable = false;
      const cargo = deliveredCargo();

      await present(cargo, 'task-1');
      await sync();
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.RETRYING);

      kernel.modelAvailable = true;
      await later(60_000);
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.ACKED);
    });

    it('never overwrites an entity of the same name that belongs to another cargo', async () => {
      const { store, kernel, sync, present } = setup();
      const cargo = deliveredCargo();
      kernel.seed({
        name: `WES-CARGO-${cargo.id}-g1`,
        properties: { 'wes:cargoId': 'someone-else' },
      });

      await present(cargo, 'task-1');
      await sync();

      const row = store.row(cargo.id);
      expect(row.syncStatus).toBe(EntitySyncStatus.FAILED);
      expect(row.errorKind).toBe(EntitySyncErrorKind.FATAL);
      expect(kernel.callsOf('create')).toBe(0);
      expect(kernel.callsOf('retire')).toBe(0);
    });

    it('marks FAILED after the configured attempts but keeps retrying a connection error', async () => {
      const { store, kernel, sync, later, present } = setup();
      kernel.failNext('create', connectionRefused(), 12);
      const cargo = deliveredCargo();

      await present(cargo, 'task-1');
      await sync();
      for (let i = 0; i < 9; i++) await later(60_000);
      const exhausted = store.row(cargo.id);
      expect(exhausted.syncStatus).toBe(EntitySyncStatus.FAILED);
      expect(exhausted.errorKind).toBe(EntitySyncErrorKind.RETRYABLE);

      for (let i = 0; i < 3; i++) await later(60_000);
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(kernel.entities.size).toBe(1);
    });
  });

  describe('deleted delivered cargo', () => {
    async function delivered() {
      const context = setup();
      const cargo = deliveredCargo();
      await context.present(cargo, 'task-1');
      await context.sync();
      const name = context.store.row(cargo.id).entityName;
      return { ...context, cargo, name };
    }

    it('retires its entity with markEnvironmentalEntityRetired', async () => {
      const { store, kernel, service, sync, cargo, name } = await delivered();

      await service.markRetired(cargo.id, 'cargo deleted');
      await sync();

      const row = store.row(cargo.id);
      expect(row.desiredState).toBe(EntityDesiredState.RETIRED);
      expect(row.syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(kernel.entities.get(name)!.retired).toBe(true);
      expect(kernel.entities.size).toBe(1);
    });

    it('retries a failed RETIRE and keeps the cargo deleted meanwhile', async () => {
      const { store, kernel, service, sync, later, cargo, name } =
        await delivered();
      kernel.failNext('retire', httpError(503));

      await service.markRetired(cargo.id, 'cargo deleted');
      await sync();
      const failed = store.row(cargo.id);
      expect(failed.desiredState).toBe(EntityDesiredState.RETIRED);
      expect(failed.syncStatus).toBe(EntitySyncStatus.RETRYING);
      expect(failed.lastError).toContain('HTTP 503');
      expect(kernel.entities.get(name)!.retired).toBe(false);

      await later(60_000);
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(kernel.entities.get(name)!.retired).toBe(true);
    });

    it('treats an entity already retired by an earlier timed-out RETIRE as done', async () => {
      const { store, kernel, service, sync, later, cargo } = await delivered();
      kernel.failNext('retireAfterSuccess', timeoutError());

      await service.markRetired(cargo.id, 'cargo deleted');
      await sync();
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.RETRYING);

      await later(60_000);
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(kernel.callsOf('retire')).toBe(1);
    });

    it('treats an entity the kernel already swept as retired', async () => {
      const { store, kernel, service, sync, cargo } = await delivered();
      kernel.restart();

      await service.markRetired(cargo.id, 'cargo deleted');
      await sync();

      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(store.row(cargo.id).lastError).toBeNull();
    });

    it('leaves no live entity behind when the cargo is deleted while CREATE is pending', async () => {
      const { store, kernel, service, sync, present } = setup();
      const cargo = deliveredCargo();
      kernel.failNext('create', connectionRefused());

      await present(cargo, 'task-1');
      await service.settled();
      await service.markRetired(cargo.id, 'cargo deleted');
      await sync();

      expect(kernel.entities.size).toBe(0);
      expect(store.row(cargo.id).desiredState).toBe(EntityDesiredState.RETIRED);
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.ACKED);
    });

    it('converges to retired whichever of CREATE and delete lands first', async () => {
      const { store, kernel, service, sync, present } = setup();
      const cargo = deliveredCargo();

      await present(cargo, 'task-1');
      await service.markRetired(cargo.id, 'cargo deleted');
      await sync();
      await sync();

      const live = [...kernel.entities.values()].filter(
        (entity) => !entity.retired,
      );
      expect(live).toHaveLength(0);
      expect(store.row(cargo.id).desiredState).toBe(EntityDesiredState.RETIRED);
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.ACKED);
    });

    it('retires an entity whose CREATE landed while the cargo was being deleted', async () => {
      const { store, kernel, service, sync, present } = setup();
      const cargo = deliveredCargo();
      kernel.onCreate = async () => {
        kernel.onCreate = null;
        await service.markRetired(cargo.id, 'cargo deleted');
      };

      await present(cargo, 'task-1');
      await sync();
      await sync();

      const row = store.row(cargo.id);
      expect(row.desiredState).toBe(EntityDesiredState.RETIRED);
      expect(row.syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(kernel.entities.get(row.entityName)!.retired).toBe(true);
    });

    it('does nothing for cargo that was never delivered', async () => {
      const { service, kernel } = setup();

      await expect(
        service.markRetired('never-delivered', 'deleted'),
      ).resolves.toBeNull();
      expect(kernel.calls).toHaveLength(0);
    });
  });

  describe('kernel reset', () => {
    it('rebuilds every obstacle after the plant model was replaced', async () => {
      const { store, kernel, service, sync, present } = setup();
      const first = deliveredCargo();
      const second = deliveredCargo({ destinationLocationName: 'location_D2' });
      await present(first, 't1');
      await present(second, 't2');
      await sync();
      kernel.restart();

      await service.fullResync('plant model replaced');
      await service.settled();

      expect(store.row(first.id).entityName).toBe(`WES-CARGO-${first.id}-g2`);
      expect(store.row(second.id).entityName).toBe(`WES-CARGO-${second.id}-g2`);
      expect(store.row(first.id).syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(
        [...kernel.entities.values()].filter((e) => !e.retired),
      ).toHaveLength(2);
    });

    it('re-posts under a new generation and retires the old entity once the new one is acked', async () => {
      const { store, kernel, service, sync, present } = setup();
      const cargo = deliveredCargo();
      await present(cargo, 't1');
      await sync();

      await service.fullResync('manual');
      await service.settled();

      const live = [...kernel.entities.values()].filter((e) => !e.retired);
      expect(live.map((entity) => entity.name)).toEqual([
        `WES-CARGO-${cargo.id}-g2`,
      ]);
      expect(kernel.entities.get(`WES-CARGO-${cargo.id}-g1`)!.retired).toBe(
        true,
      );
      expect(store.logs.some((log) => log.event === 'FULL_RESYNC')).toBe(true);
    });

    it('leaves entities WES did not create alone', async () => {
      const { kernel, service } = setup();
      kernel.seed({ name: 'FORKLIFT-ZONE', properties: {} });

      await service.fullResync('manual');

      expect(kernel.entities.get('FORKLIFT-ZONE')!.retired).toBe(false);
    });

    it('detects a kernel restart on reconnect and recreates the lost obstacles', async () => {
      const { store, kernel, service, sync, present } = setup();
      const cargo = deliveredCargo();
      await present(cargo, 't1');
      await sync();
      kernel.restart();

      service.onKernelConnected();
      await service.settled();

      // The restarted kernel forgot the name entirely, so it is simply re-created as is.
      expect(store.row(cargo.id).generation).toBe(1);
      expect(kernel.entities.get(store.row(cargo.id).entityName)!.retired).toBe(
        false,
      );
    });

    it('retires an unexpected WES entity found on the kernel', async () => {
      const { kernel, service, later } = setup();
      kernel.seed({
        name: 'WES-CARGO-ghost-g1',
        properties: { 'wes:cargoId': 'ghost' },
      });

      await later(20_000);
      await service.settled();

      expect(kernel.entities.get('WES-CARGO-ghost-g1')!.retired).toBe(true);
    });

    it('does not resync while the kernel matches the table', async () => {
      const { store, kernel, sync, later, present } = setup();
      const cargo = deliveredCargo();
      await present(cargo, 't1');
      await sync();

      await later(20_000);

      expect(store.row(cargo.id).generation).toBe(1);
      expect(kernel.callsOf('retire')).toBe(0);
    });

    it("waits for the cargo's own map instead of placing it on another one", async () => {
      const { store, kernel, sync, present } = setup('map-b');
      const cargo = deliveredCargo({ mapRecordId: 'map-a' });

      await present(cargo, 't1');
      await sync();

      expect(kernel.callsOf('create')).toBe(0);
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.PENDING);
      expect(store.row(cargo.id).lastError).toContain('chưa được nạp');
    });
  });

  describe('desired-state reconcile', () => {
    it('queues delivered cargo that never got a row', async () => {
      const { store, kernel, sync } = setup();
      const cargo = deliveredCargo();
      store.cargos.push(cargo);
      store.latestTaskIds.set(cargo.id, 'task-7');

      await sync();
      await sync();

      expect(store.row(cargo.id).taskId).toBe('task-7');
      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(kernel.entities.size).toBe(1);
    });

    it('releases the obstacle of cargo no longer delivered', async () => {
      const { store, kernel, sync, later, present } = setup();
      const cargo = deliveredCargo();
      store.cargos.push(cargo);
      await present(cargo, 't1');
      await sync();
      cargo.status = CargoStatus.CANCELLED;
      cargo.deletedAt = new Date();

      await later(20_000);
      await sync();

      expect(store.row(cargo.id).desiredState).toBe(EntityDesiredState.RETIRED);
      expect(kernel.entities.get(store.row(cargo.id).entityName)!.retired).toBe(
        true,
      );
    });
  });

  it('reports the sync state per cargo', async () => {
    const { service, sync, present } = setup();
    const cargo = deliveredCargo();
    await present(cargo, 't1');
    await sync();

    const views = await service.viewsByCargoIds([cargo.id, 'other']);

    expect(views.get(cargo.id)).toMatchObject({
      status: EntitySyncStatus.ACKED,
      desiredState: EntityDesiredState.PRESENT,
      entityName: `WES-CARGO-${cargo.id}-g1`,
    });
    expect(views.has('other')).toBe(false);
  });

  it('outlines obstacles with the pose and envelope actually sent', async () => {
    const { service, sync, present } = setup();
    const cargo = deliveredCargo();
    await present(cargo, 't1');
    await sync();

    const [overlay] = await service.overlayFor('map-a');

    expect(overlay.pose?.position).toEqual({ x: 47367, y: 25638, z: 0 });
    expect(overlay.envelope?.vertices).toHaveLength(5);
  });

  describe('map scoping', () => {
    it('never turns delivered cargo without a map into an obstacle', async () => {
      const { store, kernel, sync } = setup();
      store.cargos.push(deliveredCargo({ mapRecordId: null }));

      await sync();
      await sync();

      expect(store.rows).toHaveLength(0);
      expect(kernel.entities.size).toBe(0);
    });

    it('retires a legacy obstacle row that has no map, even if it was on the kernel', async () => {
      const { store, kernel, sync, later, present } = setup();
      const cargo = deliveredCargo();
      await present(cargo, 't1');
      await sync();
      cargo.mapRecordId = null;

      await later(20_000);
      await sync();

      expect(store.row(cargo.id).desiredState).toBe(EntityDesiredState.RETIRED);
      expect(kernel.entities.get(store.row(cargo.id).entityName)!.retired).toBe(
        true,
      );
    });

    it('does not send an obstacle of another map to the loaded one', async () => {
      const { store, kernel, sync, present } = setup('map-a');
      const cargo = deliveredCargo({ mapRecordId: 'map-b' });

      await present(cargo, 't1');
      await sync();

      expect(store.row(cargo.id).syncStatus).toBe(EntitySyncStatus.PENDING);
      expect(kernel.entities.size).toBe(0);
    });

    it('draws only the loaded map, never rows without a map', async () => {
      const { store, service, sync, present } = setup();
      await present(deliveredCargo(), 't1');
      await present(deliveredCargo({ mapRecordId: 'map-b' }), 't2');
      await sync();
      store.rows.push({
        ...store.rows[0],
        id: 'legacy',
        cargoId: 'legacy-cargo',
        mapRecordId: null,
      });

      const overlay = await service.overlayFor('map-a');

      expect(overlay).toHaveLength(1);
      expect(await service.overlayFor(null)).toEqual([]);
    });

    it('leaves obstacles of other maps alone when repairing drift', async () => {
      const { kernel, sync, later, present } = setup('map-a');
      await present(deliveredCargo({ mapRecordId: 'map-b' }), 't1');
      kernel.seed({
        name: 'FORKLIFT-ZONE',
        properties: {},
      });

      await later(20_000);
      await sync();

      expect(kernel.entities.get('FORKLIFT-ZONE')!.retired).toBe(false);
    });
  });

  describe('operator actions', () => {
    it('retires on request and keeps it retired while the cargo stays delivered', async () => {
      const { store, kernel, service, sync, later, present } = setup();
      const cargo = deliveredCargo();
      await present(cargo, 't1');
      await sync();

      await service.retireManually(cargo.id, 'op');
      await later(20_000);
      await sync();

      expect(store.row(cargo.id).desiredState).toBe(EntityDesiredState.RETIRED);
      expect(kernel.entities.get(store.row(cargo.id).entityName)!.retired).toBe(
        true,
      );
      expect(store.logs.some((log) => log.event === 'MANUAL_RETIRE')).toBe(
        true,
      );
    });

    it('reactivates under a fresh generation, since the old name is retired on openTCS', async () => {
      const { store, kernel, service, sync, present } = setup();
      const cargo = deliveredCargo();
      await present(cargo, 't1');
      await sync();
      await service.retireManually(cargo.id, 'op');

      await service.reactivateManually(cargo.id, 'op');
      await service.settled();

      const row = store.row(cargo.id);
      expect(row.desiredState).toBe(EntityDesiredState.PRESENT);
      expect(row.syncStatus).toBe(EntitySyncStatus.ACKED);
      expect(row.entityName).toBe(`WES-CARGO-${cargo.id}-g2`);
      expect(kernel.entities.get(row.entityName)!.retired).toBe(false);
    });

    it('refuses to reactivate cargo that no longer qualifies', async () => {
      const { service, sync, present } = setup();
      const cargo = deliveredCargo();
      await present(cargo, 't1');
      await sync();
      await service.retireManually(cargo.id, 'op');
      cargo.mapRecordId = null;

      await expect(service.reactivateManually(cargo.id, 'op')).rejects.toThrow(
        'Hàng không gắn bản đồ',
      );
    });

    it('retires an untracked kernel entity by name, but not one WES manages', async () => {
      const { store, kernel, service, sync, present } = setup();
      const cargo = deliveredCargo();
      await present(cargo, 't1');
      await sync();
      kernel.seed({ name: 'FORKLIFT-ZONE', properties: {} });

      await service.retireKernelEntity('FORKLIFT-ZONE', 'op');

      expect(kernel.entities.get('FORKLIFT-ZONE')!.retired).toBe(true);
      await expect(
        service.retireKernelEntity(store.row(cargo.id).entityName, 'op'),
      ).rejects.toThrow('do WES quản lý');
      await expect(
        service.retireKernelEntity('WES-KERNEL-EPOCH-x', 'op'),
      ).rejects.toThrow('mốc phiên kernel');
    });
  });
});
