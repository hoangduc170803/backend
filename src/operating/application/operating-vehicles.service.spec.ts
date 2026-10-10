import { OperatingVehiclesService } from './operating-vehicles.service';
import type { KernelVehicleState } from '../../opentcs/domain/kernel-model';
import type { VehicleStateStore } from '../../opentcs/vehicle-state.store';
import type { KernelApiService } from '../../opentcs/kernel-api.service';
import type { OperatingOrdersService } from './operating-orders.service';

const vehicle: KernelVehicleState = {
  name: 'Vehicle-0002',
  state: 'IDLE',
  procState: 'IDLE',
  integrationLevel: 'TO_BE_UTILIZED',
  energyLevel: 80,
  paused: false,
  currentPosition: '0354',
};

describe('OperatingVehiclesService pause states', () => {
  it.each([
    [undefined, null],
    ['true', true],
    ['false', false],
    ['unknown', null],
  ] as const)('maps reported pause %s to %s', async (property, expected) => {
    const source: KernelVehicleState = {
      ...vehicle,
      properties:
        property === undefined ? undefined : { 'vda5050:paused': property },
    };
    const store = { getAll: () => [source] } as unknown as VehicleStateStore;
    const service = new OperatingVehiclesService(
      store,
      {} as KernelApiService,
      {} as OperatingOrdersService,
    );

    await expect(service.snapshot()).resolves.toEqual([
      expect.objectContaining({ paused: false, reportedPaused: expected }),
    ]);
  });

  it('keeps kernel pause separate from the vehicle report', async () => {
    const store = {
      getAll: () => [
        { ...vehicle, paused: true, properties: { 'vda5050:paused': 'false' } },
      ],
    } as unknown as VehicleStateStore;
    const service = new OperatingVehiclesService(
      store,
      {} as KernelApiService,
      {} as OperatingOrdersService,
    );

    await expect(service.snapshot()).resolves.toEqual([
      expect.objectContaining({ paused: true, reportedPaused: false }),
    ]);
  });
});

describe('OperatingVehiclesService error codes', () => {
  const serviceFor = (source: KernelVehicleState) =>
    new OperatingVehiclesService(
      { getAll: () => [source] } as unknown as VehicleStateStore,
      {} as KernelApiService,
      {} as OperatingOrdersService,
    );

  it('exposes fatal and warning error types separately', async () => {
    const service = serviceFor({
      ...vehicle,
      state: 'ERROR',
      errors: {
        fatal: ['adapterLostNavigation', 'eStop'],
        warning: ['laserZoneStop'],
      },
    });

    await expect(service.snapshot()).resolves.toEqual([
      expect.objectContaining({
        fatalErrorCodes: ['adapterLostNavigation', 'eStop'],
        warningErrorCodes: ['laserZoneStop'],
      }),
    ]);
  });

  it('exposes the description the vehicle gave and its VDA5050 serial number', async () => {
    const service = serviceFor({
      ...vehicle,
      properties: { 'vda5050:serialNumber': ' V01 ' },
      errors: {
        fatal: ['eStop'],
        warning: [],
        descriptions: { eStop: 'Emergency stop button is pressed' },
      },
    });

    await expect(service.snapshot()).resolves.toEqual([
      expect.objectContaining({
        serialNumber: 'V01',
        errorDescriptions: { eStop: 'Emergency stop button is pressed' },
      }),
    ]);
  });

  it('reports no serial number or descriptions when the kernel has none', async () => {
    await expect(serviceFor(vehicle).snapshot()).resolves.toEqual([
      expect.objectContaining({ serialNumber: null, errorDescriptions: {} }),
    ]);
  });

  it('reports empty lists when the kernel has no errors', async () => {
    await expect(serviceFor(vehicle).snapshot()).resolves.toEqual([
      expect.objectContaining({ fatalErrorCodes: [], warningErrorCodes: [] }),
    ]);
  });
});
