import { KernelApiService } from '../src/opentcs/kernel-api.service';
import { locationPointNames } from '../src/opentcs/domain/kernel-mappers';
import { EnvironmentalEntitySyncService } from '../src/environmental-entities/environmental-entity-sync.service';
import {
  EntityDesiredState,
  EntitySyncStatus,
} from '../src/environmental-entities/entities/cargo-environmental-entity.entity';
import {
  InMemoryEntitySyncStore,
  InProcessEntitySyncLock,
  deliveredCargo,
} from '../src/environmental-entities/entity-sync.testing';

const kernelUrl = process.env.OPENTCS_IT_KERNEL_URL;
const describeWithKernel = kernelUrl ? describe : describe.skip;

describeWithKernel('WES → openTCS → ACK (live kernel)', () => {
  let kernelApi: KernelApiService;
  let store: InMemoryEntitySyncStore;
  let service: EnvironmentalEntitySyncService;
  let locationName: string;
  let pointName: string;
  const createdNames: string[] = [];

  beforeAll(async () => {
    process.env.OPENTCS_KERNEL_URL = kernelUrl;
    kernelApi = new KernelApiService();
    const model = await kernelApi.getPlantModelView();
    if (!model) throw new Error('The kernel has no plant model loaded');
    const vehiclePoints = new Set(
      (await kernelApi.getVehicleStates()).map(
        (vehicle) => vehicle.currentPosition,
      ),
    );
    const location = model.locations.find((candidate) => {
      const [point] = locationPointNames(candidate.links);
      return point !== undefined && !vehiclePoints.has(point);
    });
    if (!location) throw new Error('No free location to test with');
    locationName = location.name;
    pointName = locationPointNames(location.links)[0];
  });

  beforeEach(() => {
    store = new InMemoryEntitySyncStore();
    service = new EnvironmentalEntitySyncService(
      store,
      new InProcessEntitySyncLock(),
      kernelApi,
      { id: () => Promise.resolve(null) } as never,
      { resolveId: () => Promise.resolve(null) } as never,
      { emit: () => true } as never,
    );
  });

  afterAll(async () => {
    for (const name of createdNames) {
      await kernelApi.retireEnvironmentalEntity(name).catch(() => undefined);
    }
  });

  async function deliver() {
    const cargo = deliveredCargo({
      mapRecordId: null,
      destinationLocationName: locationName,
    });
    store.cargos.push(cargo);
    await service.markPresent(cargo, null);
    await service.syncNow();
    await service.settled();
    createdNames.push(store.row(cargo.id).entityName);
    return cargo;
  }

  it('creates the obstacle on the kernel and records its ACK', async () => {
    const cargo = await deliver();
    const row = store.row(cargo.id);

    expect(row.syncStatus).toBe(EntitySyncStatus.ACKED);
    const entity = (await kernelApi.getEnvironmentalEntity(row.entityName)) as {
      type: string;
      integrationLevel: string;
      retired: boolean;
      properties: Record<string, string>;
      envelope: { vertices: { x: number; y: number }[] };
    };
    expect(entity.type).toBe('OBJECT');
    expect(entity.integrationLevel).toBe('TO_BE_RESPECTED');
    expect(entity.retired).toBe(false);
    expect(entity.properties['wes:cargoId']).toBe(cargo.id);
    expect(entity.properties['wes:destinationPoint']).toBe(pointName);
    expect(entity.envelope.vertices).toHaveLength(5);
  });

  it('does not create a second entity when synced again', async () => {
    const cargo = await deliver();
    await service.retryNow(cargo.id);
    await service.retryNow(cargo.id);

    const mine = (await kernelApi.listEnvironmentalEntities()).filter(
      (entity) =>
        (entity as { properties?: Record<string, string> }).properties?.[
          'wes:cargoId'
        ] === cargo.id && !(entity as { retired: boolean }).retired,
    );
    expect(mine).toHaveLength(1);
    createdNames.push(store.row(cargo.id).entityName);
  });

  it('retires the obstacle when the delivered cargo is deleted', async () => {
    const cargo = await deliver();

    await service.markRetired(cargo.id, 'integration test');
    await service.syncNow();
    await service.settled();

    const row = store.row(cargo.id);
    expect(row.desiredState).toBe(EntityDesiredState.RETIRED);
    expect(row.syncStatus).toBe(EntitySyncStatus.ACKED);
    const entity = (await kernelApi.getEnvironmentalEntity(row.entityName)) as {
      retired: boolean;
    } | null;
    expect(entity === null || entity.retired).toBe(true);
  });
});
