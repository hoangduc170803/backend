import { Subject } from 'rxjs';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';
import { kernelSessionStub } from '../kernel-session/kernel-session.testing';
import {
  AgvRestoreStep,
  integrationLevelOf,
  vehiclesToRestore,
} from './agv-restore.step';
import type { AgvEntity } from './entities/agv.entity';

const agv = (name: string, isIgnored = false) =>
  ({ name, isIgnored, mapRecordId: 'map-a' }) as AgvEntity;

function setup() {
  const updates = new Subject<KernelVehicleState>();
  const session = kernelSessionStub();
  const kernelApi = {
    getVehicles: jest
      .fn()
      .mockResolvedValue([{ name: 'V1' }, { name: 'V2' }, { name: 'V3' }]),
    setVehicleAdapterEnabled: jest.fn().mockResolvedValue(undefined),
    setVehicleIntegrationLevel: jest.fn().mockResolvedValue(undefined),
  };
  const step = new AgvRestoreStep(
    {
      find: jest
        .fn()
        .mockResolvedValue([agv('V1'), agv('V2', true), agv('V3'), agv('V9')]),
    } as never,
    kernelApi as never,
    { vehicleUpdates: updates.asObservable() } as never,
    session,
  );
  step.onModuleInit();
  const see = (name: string, state: string) =>
    updates.next({ name, state } as KernelVehicleState);
  const run = () => step.run({ mapRecordId: 'map-a', reason: 'test' });
  return { step, session, kernelApi, see, run };
}

const adapterCalls = (kernelApi: { setVehicleAdapterEnabled: jest.Mock }) =>
  kernelApi.setVehicleAdapterEnabled.mock.calls.map(
    (call: unknown[]) => call[0] as string,
  );

describe('AgvRestoreStep', () => {
  it('maps the WES acceptance flag to the kernel integration level', () => {
    expect(integrationLevelOf({ isIgnored: false })).toBe('TO_BE_UTILIZED');
    expect(integrationLevelOf({ isIgnored: true })).toBe('TO_BE_RESPECTED');
  });

  it('only touches AGVs the kernel knows', () => {
    expect(
      vehiclesToRestore([agv('V1'), agv('V9')], new Set(['V1']), null).map(
        (a) => a.name,
      ),
    ).toEqual(['V1']);
  });

  it('reconnects only the vehicles that were connected before the reset', async () => {
    const { see, run, kernelApi } = setup();
    see('V1', 'IDLE');
    see('V2', 'EXECUTING');
    see('V3', 'UNKNOWN');

    await run();

    expect(adapterCalls(kernelApi)).toEqual(['V1', 'V2']);
    expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledWith(
      'V2',
      'TO_BE_RESPECTED',
    );
  });

  it('forgets a vehicle the operator disconnected while the kernel was up', async () => {
    const { see, run, kernelApi } = setup();
    see('V1', 'IDLE');
    see('V1', 'UNKNOWN');
    see('V3', 'IDLE');

    await run();

    expect(adapterCalls(kernelApi)).toEqual(['V3']);
  });

  it('ignores updates seen while the kernel is being restored', async () => {
    const { see, run, kernelApi, session } = setup();
    see('V1', 'IDLE');
    session.stub.ready = false;
    see('V1', 'UNKNOWN');

    await run();

    expect(adapterCalls(kernelApi)).toEqual(['V1']);
  });

  it('falls back to every AGV that is not ignored when WES has no record', async () => {
    const { run, kernelApi } = setup();

    await run();

    expect(adapterCalls(kernelApi)).toEqual(['V1', 'V3']);
  });

  it('keeps going when one vehicle cannot be restored', async () => {
    const { see, run, kernelApi } = setup();
    see('V1', 'IDLE');
    see('V3', 'IDLE');
    kernelApi.setVehicleAdapterEnabled.mockRejectedValueOnce(new Error('404'));

    await expect(run()).resolves.toBeUndefined();
    expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledWith(
      'V3',
      'TO_BE_UTILIZED',
    );
  });
});
