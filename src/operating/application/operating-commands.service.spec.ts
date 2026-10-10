import { OperatingCommandsService } from './operating-commands.service';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import { VehicleStateStore } from '../../opentcs/vehicle-state.store';
import type { KernelVehicleState } from '../../opentcs/domain/kernel-model';
import type { OperatingPlantModelService } from './operating-plant-model.service';
import { TaskKind } from '../../cargo/entities/transport-task.entity';

function vehicle(
  overrides: Partial<KernelVehicleState> = {},
): KernelVehicleState {
  return {
    name: 'V1',
    state: 'IDLE',
    procState: 'IDLE',
    integrationLevel: 'TO_BE_UTILIZED',
    energyLevel: 90,
    paused: false,
    currentPosition: null,
    transportOrder: null,
    ...overrides,
  };
}

describe('OperatingCommandsService', () => {
  let kernelApi: jest.Mocked<
    Pick<
      KernelApiService,
      | 'setVehicleAdapterEnabled'
      | 'setVehicleIntegrationLevel'
      | 'withdrawVehicleOrder'
      | 'getVehicles'
      | 'setVehiclePaused'
      | 'sendInstantAction'
    >
  >;
  let store: VehicleStateStore;
  let plantModel: jest.Mocked<
    Pick<OperatingPlantModelService, 'locations' | 'locationTypes'>
  >;
  let transportOrders: { issue: jest.Mock };
  let directTasks: { create: jest.Mock };
  let cancellation: { cancelVehicleWork: jest.Mock };
  let orderReplacement: { withdrawFromOrdersTab: jest.Mock };
  let disconnectWatcher: { releaseVehicleWork: jest.Mock };
  let service: OperatingCommandsService;

  beforeEach(() => {
    kernelApi = {
      setVehicleAdapterEnabled: jest.fn().mockResolvedValue(undefined),
      setVehicleIntegrationLevel: jest.fn().mockResolvedValue(undefined),
      withdrawVehicleOrder: jest.fn().mockResolvedValue(undefined),
      getVehicles: jest.fn().mockResolvedValue([]),
      setVehiclePaused: jest.fn().mockResolvedValue(undefined),
      sendInstantAction: jest.fn().mockResolvedValue(undefined),
    };
    store = new VehicleStateStore();
    plantModel = {
      locations: jest.fn().mockResolvedValue([]),
      locationTypes: jest.fn().mockResolvedValue([]),
    };
    transportOrders = { issue: jest.fn().mockResolvedValue('MOVE-V1-P9-x') };
    directTasks = {
      create: jest.fn().mockResolvedValue({
        task: { id: 'task-1', requestCode: 'MN-1' },
        orderName: 'MANUAL-ANY-P1-x',
      }),
    };
    cancellation = { cancelVehicleWork: jest.fn().mockResolvedValue(null) };
    orderReplacement = {
      withdrawFromOrdersTab: jest.fn().mockResolvedValue({
        orderName: 'TO-1',
        replacedBy: 'TO-2',
        taskId: 'task-1',
      }),
    };
    disconnectWatcher = {
      releaseVehicleWork: jest.fn().mockResolvedValue(undefined),
    };
    service = new OperatingCommandsService(
      kernelApi as unknown as KernelApiService,
      store,
      plantModel as unknown as OperatingPlantModelService,
      transportOrders as never,
      directTasks as never,
      cancellation as never,
      orderReplacement as never,
      disconnectWatcher as never,
    );
  });

  const manualTaskFor = (destinations: unknown[]): unknown =>
    expect.objectContaining({
      kind: TaskKind.MANUAL,
      vehicleName: null,
      destinations,
      trigger: 'API',
    });

  describe('createOrder — always a MANUAL task', () => {
    it('sends a bare point through unchanged for MOVE/NOP', async () => {
      const result = await service.createOrder({
        destinations: [{ name: 'P1', operation: 'MOVE' }],
      });

      expect(directTasks.create).toHaveBeenCalledWith(
        manualTaskFor([{ locationName: 'P1', operation: 'MOVE' }]),
      );
      expect(result).toEqual({
        ok: true,
        name: 'MANUAL-ANY-P1-x',
        queued: false,
        taskId: 'task-1',
        requestCode: 'MN-1',
      });
    });

    it('resolves a point + real action to the Location linked to that point supporting it', async () => {
      plantModel.locations.mockResolvedValue([
        { name: 'location_P1', type: 'Charging', pointNames: ['P1'] },
      ]);
      plantModel.locationTypes.mockResolvedValue([
        { name: 'Charging', allowedOperations: ['Charge'] },
      ]);

      await service.createOrder({
        destinations: [{ name: 'P1', operation: 'Charge' }],
        intendedVehicle: 'V1',
      });

      expect(directTasks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: TaskKind.MANUAL,
          vehicleName: 'V1',
          destinations: [{ locationName: 'location_P1', operation: 'Charge' }],
        }),
      );
    });

    it('rejects a point + action combination no Location there supports', async () => {
      plantModel.locations.mockResolvedValue([
        { name: 'location_P1', type: 'Pick up', pointNames: ['P1'] },
      ]);
      plantModel.locationTypes.mockResolvedValue([
        { name: 'Pick up', allowedOperations: ['liftUp'] },
      ]);

      await expect(
        service.createOrder({
          destinations: [{ name: 'P1', operation: 'Charge' }],
        }),
      ).rejects.toThrow(/không có Location nào hỗ trợ/);
      expect(directTasks.create).not.toHaveBeenCalled();
    });

    it('rejects with no destinations at all', async () => {
      await expect(service.createOrder({ destinations: [] })).rejects.toThrow(
        'Cần ít nhất 1 điểm đến.',
      );
    });

    it('passes a real Location name through unchanged (a caller bypassing the point-based UI)', async () => {
      plantModel.locations.mockResolvedValue([
        { name: 'location_P1', type: 'Charging', pointNames: ['P1'] },
      ]);

      await service.createOrder({
        destinations: [{ name: 'location_P1', operation: 'Charge' }],
      });

      expect(directTasks.create).toHaveBeenCalledWith(
        manualTaskFor([{ locationName: 'location_P1', operation: 'Charge' }]),
      );
    });
  });

  describe('sendToPoint — a raw MOVE order, no task', () => {
    it('issues the move through the transport order choke point without a task id', async () => {
      await service.sendToPoint('V1', 'P9', 'MOVE');

      expect(transportOrders.issue).toHaveBeenCalledWith({
        kind: 'MOVE',
        vehicleName: 'V1',
        aimedAt: 'P9',
        destinations: [{ locationName: 'P9', operation: 'MOVE' }],
      });
    });
  });

  describe('withdrawOrder — Orders tab', () => {
    it('hands the order to the replacement flow', async () => {
      const result = await service.withdrawOrder('TO-1');

      expect(orderReplacement.withdrawFromOrdersTab).toHaveBeenCalledWith(
        'TO-1',
      );
      expect(result).toMatchObject({ ok: true, replacedBy: 'TO-2' });
    });
  });

  describe('withdrawVehicle — cancels the vehicle task', () => {
    const permissions = { cargo: true, direct: true };

    it('cancels through the task cancellation rules', async () => {
      await service.withdrawVehicle('V1', permissions);

      expect(cancellation.cancelVehicleWork).toHaveBeenCalledWith('V1', {
        permissions,
      });
    });

    it('surfaces a refused cancellation as a 400', async () => {
      cancellation.cancelVehicleWork.mockResolvedValue({
        taskId: 't1',
        outcome: 'failed',
        reason: 'Hàng đã lên xe — không thể huỷ nhiệm vụ đang giao.',
        replacementTaskId: null,
      });

      await expect(service.withdrawVehicle('V1', permissions)).rejects.toThrow(
        'Hàng đã lên xe',
      );
    });
  });

  describe('stopCharging', () => {
    it('sends a VDA5050 "stopCharging" instant action straight to the vehicle', async () => {
      const result = await service.stopCharging('V1');

      expect(kernelApi.sendInstantAction).toHaveBeenCalledWith(
        'V1',
        'stopCharging',
      );
      expect(result).toEqual({ ok: true });
    });
  });

  describe('setPaused', () => {
    it('broadcasts the accepted kernel pause through the shared vehicle store', async () => {
      store.set('V1', vehicle());
      const updates: KernelVehicleState[] = [];
      const subscription = store.vehicleUpdates.subscribe((update) =>
        updates.push(update),
      );

      await service.setPaused('V1', true);

      expect(kernelApi.setVehiclePaused).toHaveBeenCalledWith('V1', true);
      expect(store.get('V1')?.paused).toBe(true);
      expect(updates).toEqual([expect.objectContaining({ paused: true })]);
      subscription.unsubscribe();
    });

    it('does not change the shared state when the kernel rejects the command', async () => {
      store.set('V1', vehicle());
      kernelApi.setVehiclePaused.mockRejectedValueOnce(new Error('rejected'));

      await expect(service.setPaused('V1', true)).rejects.toThrow('rejected');

      expect(store.get('V1')?.paused).toBe(false);
    });

    it('rejects pause controls while the vehicle is emergency-stopped', async () => {
      store.set('V1', vehicle({ errors: { fatal: ['eStop'], warning: [] } }));

      await expect(service.setPaused('V1', false)).rejects.toThrow(
        'đang dừng khẩn cấp',
      );

      expect(kernelApi.setVehiclePaused).not.toHaveBeenCalled();
    });
  });

  describe('setCommAdapter(false) — disconnect', () => {
    it('releases the vehicle work, then ignores the vehicle, then disables the adapter', async () => {
      store.set('V1', vehicle({ transportOrder: 'TO-1' }));
      const calls: string[] = [];
      disconnectWatcher.releaseVehicleWork.mockImplementation(() => {
        calls.push('release');
        return Promise.resolve();
      });
      kernelApi.setVehicleIntegrationLevel.mockImplementation(() => {
        calls.push('ignore');
        return Promise.resolve();
      });
      kernelApi.setVehicleAdapterEnabled.mockImplementation(() => {
        calls.push('disable');
        return Promise.resolve();
      });

      await service.setCommAdapter('V1', false);

      expect(disconnectWatcher.releaseVehicleWork).toHaveBeenCalledWith(
        'V1',
        'Ngắt kết nối xe V1',
        'API',
      );
      expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledWith(
        'V1',
        'TO_BE_IGNORED',
      );
      expect(kernelApi.setVehicleAdapterEnabled).toHaveBeenCalledWith(
        'V1',
        false,
      );
      expect(calls).toEqual(['release', 'ignore', 'disable']);
    });
  });

  describe('setCommAdapter(true) — connect', () => {
    it('only enables the adapter, leaving integration level untouched', async () => {
      await service.setCommAdapter('V1', true);

      expect(kernelApi.setVehicleAdapterEnabled).toHaveBeenCalledWith(
        'V1',
        true,
      );
      expect(kernelApi.setVehicleIntegrationLevel).not.toHaveBeenCalled();
      expect(kernelApi.withdrawVehicleOrder).not.toHaveBeenCalled();
    });
  });

  describe('fleet("connect-all")', () => {
    it('enables the adapter and sets TO_BE_UTILIZED for every vehicle, without pausing', async () => {
      kernelApi.getVehicles.mockResolvedValue([
        vehicle({ name: 'V1' }),
        vehicle({ name: 'V2' }),
      ]);

      const result = await service.fleet('connect-all');

      expect(kernelApi.setVehicleAdapterEnabled).toHaveBeenCalledWith(
        'V1',
        true,
      );
      expect(kernelApi.setVehicleAdapterEnabled).toHaveBeenCalledWith(
        'V2',
        true,
      );
      expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledWith(
        'V1',
        'TO_BE_UTILIZED',
      );
      expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledWith(
        'V2',
        'TO_BE_UTILIZED',
      );
      expect(kernelApi.setVehiclePaused).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, applied: ['V1', 'V2'], failed: [] });
    });

    it('does not run or pause an emergency-stopped vehicle', async () => {
      kernelApi.getVehicles.mockResolvedValue([
        vehicle({ name: 'V1' }),
        vehicle({
          name: 'V2',
          errors: { fatal: ['eStop'], warning: [] },
        }),
      ]);

      const result = await service.fleet('run-all');

      expect(kernelApi.setVehiclePaused).toHaveBeenCalledTimes(1);
      expect(kernelApi.setVehiclePaused).toHaveBeenCalledWith('V1', false);
      expect(result.applied).toEqual(['V1']);
      expect(result.failed).toEqual([
        expect.objectContaining({
          name: 'V2',
          reason: expect.stringContaining('dừng khẩn cấp'),
        }),
      ]);
    });

    it('names per-vehicle failures without throwing, and reports ok:false', async () => {
      kernelApi.getVehicles.mockResolvedValue([vehicle({ name: 'V1' })]);
      kernelApi.setVehicleAdapterEnabled.mockRejectedValueOnce(
        new Error('offline'),
      );

      const result = await service.fleet('connect-all');

      expect(result).toEqual({
        ok: false,
        applied: [],
        failed: [{ name: 'V1', reason: 'offline' }],
      });
    });

    it('throws instead of reporting a false success when the vehicle list itself fails', async () => {
      kernelApi.getVehicles.mockRejectedValue(new Error('kernel down'));

      await expect(service.fleet('connect-all')).rejects.toThrow('kernel down');

      expect(kernelApi.setVehicleAdapterEnabled).not.toHaveBeenCalled();
    });
  });
});
