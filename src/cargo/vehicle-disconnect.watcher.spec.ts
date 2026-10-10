import { kernelSessionStub } from '../kernel-session/kernel-session.testing';
import {
  AUTO_IGNORED_PROPERTY,
  DISCONNECT_GRACE_MS,
  VehicleDisconnectWatcher,
} from './vehicle-disconnect.watcher';
import { TaskKind, TaskStatus } from './entities/transport-task.entity';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';
import { fixedActiveMap } from '../maps/infrastructure/active-map-context.testing';

function vehicle(
  overrides: Partial<KernelVehicleState> = {},
): KernelVehicleState {
  return {
    name: 'V1',
    state: 'UNKNOWN',
    procState: 'IDLE',
    integrationLevel: 'TO_BE_UTILIZED',
    energyLevel: 80,
    paused: false,
    currentPosition: 'P1',
    transportOrder: null,
    ...overrides,
  };
}

function setup(
  activeTask: Record<string, unknown> | null = null,
  {
    loaded = false,
    pickupDestinationState = 'TRAVELLING',
    transportOrder = 'MOVE-1',
    currentPosition = 'P1',
  } = {},
) {
  const kernelApi = {
    setVehicleIntegrationLevel: jest.fn().mockResolvedValue(undefined),
    putVehicleProperty: jest.fn().mockResolvedValue(undefined),
    withdrawVehicleOrder: jest.fn().mockResolvedValue(undefined),
    getTransportOrderRaw: jest.fn().mockResolvedValue({
      state: 'BEING_PROCESSED',
      destinations: [{ state: pickupDestinationState }],
    }),
  };
  const vehicleStore = {
    get: jest.fn().mockReturnValue({
      name: 'V1',
      state: 'UNKNOWN',
      integrationLevel: 'TO_BE_UTILIZED',
      transportOrder,
      loaded,
      currentPosition,
    }),
    vehicleUpdates: { subscribe: jest.fn() },
  };
  const cancellation = {
    activeTaskOf: jest.fn().mockResolvedValue(activeTask),
    cancelTasks: jest
      .fn()
      .mockResolvedValue({ results: [{ outcome: 'cancelled' }] }),
  };
  const cargo = { failCargo: jest.fn().mockResolvedValue(undefined) };
  const session = kernelSessionStub();
  const watcher = new VehicleDisconnectWatcher(
    vehicleStore as never,
    kernelApi as never,
    fixedActiveMap(),
    cancellation as never,
    cargo as never,
    {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'c1', sourcePointName: '0020' }),
    } as never,
    { latestOrder: jest.fn().mockResolvedValue(null) } as never,
    session,
  );
  return { watcher, kernelApi, cancellation, cargo, vehicleStore, session };
}

describe('VehicleDisconnectWatcher', () => {
  it('does nothing while the vehicle has been lost for less than 3s', async () => {
    const { watcher, kernelApi } = setup();

    watcher.observe(vehicle(), 0);
    await watcher.tick(DISCONNECT_GRACE_MS - 1);

    expect(kernelApi.setVehicleIntegrationLevel).not.toHaveBeenCalled();
  });

  it('never treats vehicles as disconnected while the kernel is being restored', async () => {
    const { watcher, kernelApi, cancellation, session } = setup();
    session.stub.ready = false;

    watcher.observe(vehicle(), 0);
    await watcher.tick(DISCONNECT_GRACE_MS + 1);
    session.stub.ready = true;
    await watcher.tick(DISCONNECT_GRACE_MS * 2);

    expect(kernelApi.setVehicleIntegrationLevel).not.toHaveBeenCalled();
    expect(cancellation.cancelTasks).not.toHaveBeenCalled();
  });

  it('forgets a vehicle that reconnects within the grace period', async () => {
    const { watcher, kernelApi } = setup();

    watcher.observe(vehicle(), 0);
    watcher.observe(vehicle({ state: 'IDLE' }), 1_000);
    await watcher.tick(DISCONNECT_GRACE_MS + 1);

    expect(kernelApi.setVehicleIntegrationLevel).not.toHaveBeenCalled();
  });

  it('fails the cargo on board, then ignores and marks the vehicle', async () => {
    const { watcher, kernelApi, cargo } = setup({
      id: 't1',
      requestCode: 'TR-1',
      kind: TaskKind.CARGO,
      status: TaskStatus.DELIVERING,
      cargoId: 'c1',
    });

    watcher.observe(vehicle(), 0);
    await watcher.tick(DISCONNECT_GRACE_MS);

    expect(cargo.failCargo).toHaveBeenCalledWith(
      'c1',
      'Xe V1 mất kết nối',
      expect.objectContaining({ trigger: 'DISCONNECT_WATCHER' }),
    );
    expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledWith(
      'V1',
      'TO_BE_IGNORED',
    );
    expect(kernelApi.putVehicleProperty).toHaveBeenCalledWith(
      'V1',
      AUTO_IGNORED_PROPERTY,
      'true',
    );
  });

  it('cancels any other task of the lost vehicle', async () => {
    const { watcher, cancellation, cargo } = setup({
      id: 't1',
      requestCode: 'MN-1',
      kind: TaskKind.MANUAL,
      status: TaskStatus.EXECUTING,
      cargoId: null,
    });

    watcher.observe(vehicle(), 0);
    await watcher.tick(DISCONNECT_GRACE_MS);

    expect(cargo.failCargo).not.toHaveBeenCalled();
    expect(cancellation.cancelTasks).toHaveBeenCalledWith(['t1'], {
      permissions: { cargo: true, direct: true },
      log: expect.objectContaining({ reason: 'Xe V1 mất kết nối' }),
      loadConfirmedOffBoard: true,
    });
  });

  it('withdraws a raw order when the lost vehicle has no task', async () => {
    const { watcher, kernelApi } = setup(null);

    watcher.observe(vehicle(), 0);
    await watcher.tick(DISCONNECT_GRACE_MS);

    expect(kernelApi.withdrawVehicleOrder).toHaveBeenCalledWith('V1', true);
  });

  it('brings back only a vehicle WES itself ignored', async () => {
    const { watcher, kernelApi } = setup();

    watcher.observe(
      vehicle({
        state: 'IDLE',
        integrationLevel: 'TO_BE_IGNORED',
        properties: {},
      }),
      0,
    );
    watcher.observe(
      vehicle({
        state: 'IDLE',
        integrationLevel: 'TO_BE_IGNORED',
        properties: { [AUTO_IGNORED_PROPERTY]: 'true' },
      }),
      0,
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledTimes(1);
    expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledWith(
      'V1',
      'TO_BE_UTILIZED',
    );
    expect(kernelApi.putVehicleProperty).toHaveBeenCalledWith(
      'V1',
      AUTO_IGNORED_PROPERTY,
      null,
    );
  });

  it('fails the cargo once the vehicle reported liftUp done', async () => {
    const { watcher, cargo, cancellation } = setup(
      {
        id: 't1',
        requestCode: 'TR-1',
        kind: TaskKind.CARGO,
        status: TaskStatus.PICKING_UP,
        cargoId: 'c1',
        metadata: {
          pickupOrderName: 'PICKUP-V1-L1-x',
          assignedVehicleName: 'V1',
        },
      },
      { pickupDestinationState: 'FINISHED' },
    );

    watcher.observe(vehicle(), 0);
    await watcher.tick(DISCONNECT_GRACE_MS);

    expect(cargo.failCargo).toHaveBeenCalledWith(
      'c1',
      'Xe V1 mất kết nối',
      expect.anything(),
    );
    expect(cancellation.cancelTasks).not.toHaveBeenCalled();
  });

  it('fails the cargo when the vehicle reports a load on board', async () => {
    const { watcher, cargo } = setup(
      {
        id: 't1',
        requestCode: 'TR-1',
        kind: TaskKind.CARGO,
        status: TaskStatus.PICKING_UP,
        cargoId: 'c1',
        metadata: {
          pickupOrderName: 'PICKUP-V1-L1-x',
          assignedVehicleName: 'V1',
        },
      },
      { loaded: true },
    );

    watcher.observe(vehicle(), 0);
    await watcher.tick(DISCONNECT_GRACE_MS);

    expect(cargo.failCargo).toHaveBeenCalled();
  });

  it('requeues a cargo task whose vehicle has not lifted yet, even at the pickup point', async () => {
    const { watcher, cargo, cancellation } = setup({
      id: 't1',
      requestCode: 'TR-1',
      kind: TaskKind.CARGO,
      status: TaskStatus.PICKING_UP,
      cargoId: 'c1',
      metadata: {
        pickupOrderName: 'PICKUP-V1-L1-x',
        assignedVehicleName: 'V1',
      },
    });

    watcher.observe(vehicle(), 0);
    await watcher.tick(DISCONNECT_GRACE_MS);

    expect(cargo.failCargo).not.toHaveBeenCalled();
    expect(cancellation.cancelTasks).toHaveBeenCalledWith(
      ['t1'],
      expect.objectContaining({
        loadConfirmedOffBoard: true,
      }),
    );
  });

  it('withdraws whatever order is left before ignoring the vehicle', async () => {
    const { watcher, kernelApi } = setup({
      id: 't1',
      requestCode: 'MN-1',
      kind: TaskKind.MANUAL,
      status: TaskStatus.EXECUTING,
      cargoId: null,
    });
    const calls: string[] = [];
    kernelApi.withdrawVehicleOrder.mockImplementation(() => {
      calls.push('withdraw');
      return Promise.resolve();
    });
    kernelApi.setVehicleIntegrationLevel.mockImplementation(() => {
      calls.push('ignore');
      return Promise.resolve();
    });

    watcher.observe(vehicle(), 0);
    await watcher.tick(DISCONNECT_GRACE_MS);

    expect(calls).toEqual(['withdraw', 'ignore']);
  });

  it('retries after the grace period when handling fails', async () => {
    const { watcher, kernelApi } = setup(null);
    kernelApi.setVehicleIntegrationLevel.mockRejectedValueOnce(
      new Error('vehicle busy'),
    );

    watcher.observe(vehicle(), 0);
    await watcher.tick(DISCONNECT_GRACE_MS);
    await watcher.tick(DISCONNECT_GRACE_MS + 1);
    await watcher.tick(2 * DISCONNECT_GRACE_MS);

    expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledTimes(2);
  });

  it('fails the cargo when the vehicle stands on the pickup point', async () => {
    const { watcher, cargo, cancellation } = setup(
      {
        id: 't1',
        requestCode: 'TR-1',
        kind: TaskKind.CARGO,
        status: TaskStatus.PICKING_UP,
        cargoId: 'c1',
        metadata: {
          pickupOrderName: 'PICKUP-V1-L1-x',
          assignedVehicleName: 'V1',
        },
      },
      { currentPosition: '0020' },
    );

    watcher.observe(vehicle(), 0);
    await watcher.tick(DISCONNECT_GRACE_MS);

    expect(cargo.failCargo).toHaveBeenCalledWith(
      'c1',
      'Xe V1 mất kết nối',
      expect.anything(),
    );
    expect(cancellation.cancelTasks).not.toHaveBeenCalled();
  });
});
