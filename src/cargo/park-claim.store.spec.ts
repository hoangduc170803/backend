import { ParkClaimStore } from './park-claim.store';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import type { KernelApiService } from '../opentcs/kernel-api.service';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';

const PARK_ORDER = 'PARK-V1-PARK-1-0d4dd3a5-bfe5-4d90-8893-31ed8d12cae5';
const FOREIGN_ORDER = 'Move-01KY7T2QW4ZP8H3N6VC1RB9DKS';

const parkOrderName = (vehicle: string, point: string) =>
  `PARK-${vehicle}-${point}-0d4dd3a5-bfe5-4d90-8893-31ed8d12cae5`;

const order = (
  orderName: string,
  vehicleName: string | null,
  leg: string,
  destinations: string[],
) => ({
  row: {
    orderName,
    vehicleName,
    leg,
    destinations: destinations.map((locationName) => ({
      locationName,
      operation: 'MOVE',
    })),
  },
});

const parkOrder = (vehicle: string, point: string) =>
  order(parkOrderName(vehicle, point), vehicle, 'PARK', [point]);

const vehicle = (
  position: string,
  transportOrder: string | null = null,
): KernelVehicleState => ({
  name: 'V1',
  state: 'IDLE',
  procState: transportOrder ? 'PROCESSING_ORDER' : 'IDLE',
  integrationLevel: 'TO_BE_UTILIZED',
  energyLevel: 100,
  paused: false,
  currentPosition: position,
  transportOrder,
});

const liveParkOrder = parkOrder('V1', 'PARK-1');

function setup() {
  const openOrders = jest.fn().mockResolvedValue([]);
  const kernelApi = {
    getTransportOrderStateStrict: jest
      .fn()
      .mockResolvedValue('BEING_PROCESSED'),
  };
  const vehicleStore = new VehicleStateStore();
  const store = new ParkClaimStore(
    vehicleStore,
    kernelApi as unknown as KernelApiService,
    { openOrdersOn: openOrders } as never,
    { id: () => Promise.resolve('map-1') } as never,
  );
  return { store, kernelApi, vehicleStore, openOrders };
}

async function readyStoreWithClaim() {
  const built = setup();
  await built.store.onApplicationBootstrap();
  built.store.claim('V1', 'PARK-1', PARK_ORDER);
  return built;
}

describe('ParkClaimStore', () => {
  it('rebuilds the claims from the open park orders of the ledger on bootstrap', async () => {
    const { store, openOrders } = setup();
    openOrders.mockResolvedValue([liveParkOrder]);

    await store.onApplicationBootstrap();

    expect(store.isReady()).toBe(true);
    expect(store.get('V1')).toEqual({
      point: 'PARK-1',
      orderName: PARK_ORDER,
    });
    expect(store.claimedVehicles()).toEqual(new Set(['V1']));
    expect(store.claimedPoints()).toEqual(new Set(['PARK-1']));
  });

  it('claims only for park orders that have a vehicle, out of everything still open', async () => {
    const { store, openOrders } = setup();
    openOrders.mockResolvedValue([
      parkOrder('V1', '1002'),
      parkOrder('V2', '1006'),
      order('PICKUP-V4-LOC-1-uuid', 'V4', 'PICKUP', ['LOC-1']),
      order(parkOrderName('V5', '1007'), null, 'PARK', ['1007']),
    ]);

    await store.onApplicationBootstrap();

    expect(store.claimedVehicles()).toEqual(new Set(['V1', 'V2']));
    expect(store.claimedPoints()).toEqual(new Set(['1002', '1006']));
  });

  it('falls back to the park point encoded in the name when the order carries no destination', async () => {
    const { store, openOrders } = setup();
    openOrders.mockResolvedValue([
      order(parkOrderName('V1', '1002'), 'V1', 'PARK', []),
    ]);

    await store.onApplicationBootstrap();

    expect(store.get('V1')).toEqual({
      point: '1002',
      orderName: parkOrderName('V1', '1002'),
    });
  });

  it('tracks the last park order when one vehicle holds several', async () => {
    const { store, openOrders } = setup();
    openOrders.mockResolvedValue([
      parkOrder('V1', '1002'),
      parkOrder('V1', '1006'),
    ]);

    await store.onApplicationBootstrap();

    expect(store.get('V1')).toEqual({
      point: '1006',
      orderName: parkOrderName('V1', '1006'),
    });
    expect(store.claimedPoints()).toEqual(new Set(['1006']));
  });

  it('releases a claim once the vehicle stands on the claimed point', async () => {
    const { store, kernelApi, vehicleStore } = await readyStoreWithClaim();
    vehicleStore.set('V1', vehicle('PARK-1'));

    await store.reconcile();

    expect(store.claimedPoints()).toEqual(new Set());
    expect(kernelApi.getTransportOrderStateStrict).not.toHaveBeenCalled();
  });

  it('holds the claim while the vehicle is still driving the claimed order', async () => {
    const { store, kernelApi, vehicleStore } = await readyStoreWithClaim();
    vehicleStore.set('V1', vehicle('P9', PARK_ORDER));

    await store.reconcile();

    expect(store.get('V1')).toEqual({
      point: 'PARK-1',
      orderName: PARK_ORDER,
    });
    expect(kernelApi.getTransportOrderStateStrict).not.toHaveBeenCalled();
  });

  it('keeps the claim when the vehicle carries some other order', async () => {
    const { store, kernelApi, vehicleStore } = await readyStoreWithClaim();
    vehicleStore.set('V1', vehicle('P9', FOREIGN_ORDER));

    await store.reconcile();

    expect(kernelApi.getTransportOrderStateStrict).toHaveBeenCalledWith(
      PARK_ORDER,
    );
    expect(store.get('V1')).toEqual({
      point: 'PARK-1',
      orderName: PARK_ORDER,
    });
  });

  it.each(['FINISHED', 'FAILED', 'UNROUTABLE'])(
    'releases a claim whose order is %s',
    async (state) => {
      const { store, kernelApi, vehicleStore } = await readyStoreWithClaim();
      vehicleStore.set('V1', vehicle('P9', FOREIGN_ORDER));
      kernelApi.getTransportOrderStateStrict.mockResolvedValue(state);

      await store.reconcile();

      expect(store.claimedVehicles()).toEqual(new Set());
    },
  );

  it('keeps a claim whose order is WITHDRAWN — that state is not terminal', async () => {
    const { store, kernelApi, vehicleStore } = await readyStoreWithClaim();
    vehicleStore.set('V1', vehicle('P9'));
    kernelApi.getTransportOrderStateStrict.mockResolvedValue('WITHDRAWN');

    await store.reconcile();

    expect(store.claimedVehicles()).toEqual(new Set(['V1']));
  });

  it('releases a claim the kernel no longer knows', async () => {
    const { store, kernelApi, vehicleStore } = await readyStoreWithClaim();
    vehicleStore.set('V1', vehicle('P9'));
    kernelApi.getTransportOrderStateStrict.mockResolvedValue(null);

    await store.reconcile();

    expect(store.claimedVehicles()).toEqual(new Set());
  });

  it('keeps the claim when the kernel cannot be reached', async () => {
    const { store, kernelApi, vehicleStore } = await readyStoreWithClaim();
    vehicleStore.set('V1', vehicle('P9'));
    kernelApi.getTransportOrderStateStrict.mockRejectedValue(
      new Error('connect ECONNREFUSED'),
    );

    await store.reconcile();

    expect(store.claimedVehicles()).toEqual(new Set(['V1']));
    expect(store.claimedPoints()).toEqual(new Set(['PARK-1']));
  });

  it('keeps a live claim across repeated reconciles', async () => {
    const { store, vehicleStore } = await readyStoreWithClaim();
    vehicleStore.set('V1', vehicle('P9'));

    await store.reconcile();
    await store.reconcile();
    await store.reconcile();

    expect(store.claimedPoints()).toEqual(new Set(['PARK-1']));
  });

  it('stays unready when the bootstrap rehydrate fails', async () => {
    const { store, openOrders } = setup();
    openOrders.mockRejectedValue(new Error('database down'));

    await store.onApplicationBootstrap();

    expect(store.isReady()).toBe(false);
    expect(store.claimedPoints()).toEqual(new Set());
  });

  it('retries the rehydrate on every reconcile until it succeeds', async () => {
    const { store, openOrders } = setup();
    openOrders.mockRejectedValue(new Error('kernel down'));
    await store.onApplicationBootstrap();

    await store.reconcile();
    expect(store.isReady()).toBe(false);

    openOrders.mockResolvedValue([liveParkOrder]);
    await store.reconcile();

    expect(store.isReady()).toBe(true);
    expect(store.claimedPoints()).toEqual(new Set(['PARK-1']));
  });

  it('drops a claim on release and stops reporting its point', async () => {
    const { store } = await readyStoreWithClaim();

    store.release('V1');

    expect(store.get('V1')).toBeUndefined();
    expect(store.claimedPoints()).toEqual(new Set());
  });
});
