import { ChargeRecallService } from './charge-recall.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';
import type { AgvEntity } from '../agvs/entities/agv.entity';
import {
  TaskKind,
  TaskStatus,
  type TransportTaskEntity,
} from './entities/transport-task.entity';
import type { VehicleCandidate } from './domain/dispatch.policy';
import { fixedActiveMap } from '../maps/infrastructure/active-map-context.testing';

const agv = (name: string, overrides: Partial<AgvEntity> = {}): AgvEntity =>
  ({
    name,
    isDispatchEnabled: true,
    isIgnored: false,
    criticalBatteryThreshold: 20,
    goodBatteryThreshold: 50,
    sufficientBatteryThreshold: 60,
    fullBatteryThreshold: 95,
    ...overrides,
  }) as AgvEntity;

const state = (
  name: string,
  overrides: Partial<KernelVehicleState> = {},
): KernelVehicleState => ({
  name,
  state: 'CHARGING',
  procState: 'IDLE',
  integrationLevel: 'TO_BE_UTILIZED',
  energyLevel: 70,
  paused: false,
  currentPosition: 'C1',
  transportOrder: null,
  ...overrides,
});

const freeVehicle = (name: string): VehicleCandidate => ({
  name,
  dispatchEnabled: true,
  ignored: false,
  available: true,
  preemptibleParking: false,
  energyLevel: 80,
  criticalThreshold: 20,
  currentPosition: 'P1',
  hasActiveTask: false,
});

const chargeTask = (vehicle: string): TransportTaskEntity =>
  ({
    id: `charge-${vehicle}`,
    requestCode: `CH-${vehicle}`,
    kind: TaskKind.CHARGE,
    status: TaskStatus.EXECUTING,
    metadata: { assignedVehicleName: vehicle },
  }) as TransportTaskEntity;

function setup(options: {
  waitingWork: number;
  states: KernelVehicleState[];
  agvs: AgvEntity[];
  candidates?: VehicleCandidate[];
  liveChargeTasks?: TransportTaskEntity[];
}) {
  const liveChargeTasks = options.liveChargeTasks ?? [];
  const taskRepo = {
    count: jest.fn().mockResolvedValue(options.waitingWork),
    find: jest.fn().mockResolvedValue(liveChargeTasks),
  };
  const agvRepo = { find: jest.fn().mockResolvedValue(options.agvs) };
  const vehicleStore = new VehicleStateStore();
  for (const s of options.states) vehicleStore.set(s.name, s);
  const vehicleCandidates = {
    build: jest.fn().mockResolvedValue(options.candidates ?? []),
  };
  const taskTermination = { terminate: jest.fn().mockResolvedValue(undefined) };
  const chargeEngine = {
    stopCharging: jest.fn().mockResolvedValue(true),
    forgetChargeTarget: jest.fn(),
  };
  const svc = new ChargeRecallService(
    taskRepo as never,
    agvRepo as never,
    vehicleStore,
    fixedActiveMap(),
    vehicleCandidates as never,
    taskTermination as never,
    chargeEngine as never,
  );
  return { svc, chargeEngine, taskTermination };
}

describe('ChargeRecallService', () => {
  it('stops charging a vehicle at or above good when cargo waits and nobody else is free', async () => {
    const { svc, chargeEngine } = setup({
      waitingWork: 1,
      states: [state('V1')],
      agvs: [agv('V1')],
    });

    await svc.run();

    expect(chargeEngine.stopCharging).toHaveBeenCalledWith(
      'V1',
      expect.stringContaining('recalled for work'),
    );
  });

  it('leaves the charger alone while another vehicle is free to take the work', async () => {
    const { svc, chargeEngine } = setup({
      waitingWork: 1,
      states: [state('V1')],
      agvs: [agv('V1'), agv('V2')],
      candidates: [freeVehicle('V2')],
    });

    await svc.run();

    expect(chargeEngine.stopCharging).not.toHaveBeenCalled();
  });

  it('does nothing when no cargo task is waiting', async () => {
    const { svc, chargeEngine } = setup({
      waitingWork: 0,
      states: [state('V1')],
      agvs: [agv('V1')],
    });

    await svc.run();

    expect(chargeEngine.stopCharging).not.toHaveBeenCalled();
  });

  it('keeps charging a vehicle still below good', async () => {
    const { svc, chargeEngine } = setup({
      waitingWork: 1,
      states: [state('V1', { energyLevel: 49 })],
      agvs: [agv('V1')],
    });

    await svc.run();

    expect(chargeEngine.stopCharging).not.toHaveBeenCalled();
  });

  it('cancels the charge task of a vehicle still driving to the charger', async () => {
    const { svc, taskTermination, chargeEngine } = setup({
      waitingWork: 1,
      states: [
        state('V1', {
          state: 'EXECUTING',
          procState: 'PROCESSING_ORDER',
          currentPosition: 'P3',
          transportOrder: 'CHARGE-V1-CHG-1-x',
        }),
      ],
      agvs: [agv('V1')],
      liveChargeTasks: [chargeTask('V1')],
    });

    await svc.run();

    expect(taskTermination.terminate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'charge-V1' }),
      TaskStatus.CANCELLED,
      expect.objectContaining({ trigger: 'CHARGE_ENGINE' }),
    );
    expect(chargeEngine.forgetChargeTarget).toHaveBeenCalledWith('V1');
  });

  it('recalls no more vehicles than there are waiting tasks, fullest first', async () => {
    const { svc, chargeEngine } = setup({
      waitingWork: 1,
      states: [
        state('V1', { energyLevel: 60 }),
        state('V2', { energyLevel: 90 }),
      ],
      agvs: [agv('V1'), agv('V2')],
    });

    await svc.run();
    await svc.run();

    expect(chargeEngine.stopCharging).toHaveBeenCalledTimes(1);
    expect(chargeEngine.stopCharging).toHaveBeenCalledWith(
      'V2',
      expect.any(String),
    );
  });

  it('never recalls a dispatch-disabled vehicle', async () => {
    const { svc, chargeEngine } = setup({
      waitingWork: 1,
      states: [state('V1')],
      agvs: [agv('V1', { isDispatchEnabled: false })],
    });

    await svc.run();

    expect(chargeEngine.stopCharging).not.toHaveBeenCalled();
  });
});
