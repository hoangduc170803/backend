import { FleetTelemetryService } from './fleet-telemetry.service';
import { VehicleStateStore } from './vehicle-state.store';
import type { KernelVehicleState } from './domain/kernel-model';

function vehicleState(
  overrides: Partial<KernelVehicleState> = {},
): KernelVehicleState {
  return {
    name: 'V1',
    state: 'IDLE',
    procState: 'IDLE',
    integrationLevel: 'TO_BE_UTILIZED',
    energyLevel: 90,
    paused: false,
    currentPosition: 'P1',
    transportOrder: null,
    ...overrides,
  };
}

function makeService() {
  const sessionRepo = {
    save: jest.fn(),
    create: jest.fn((x: unknown) => x),
    update: jest.fn(),
  };
  const transitionRepo = { insert: jest.fn() };
  const service = new FleetTelemetryService(
    sessionRepo as never,
    transitionRepo as never,
    new VehicleStateStore(),
  );
  return { service, transitionRepo };
}

describe('FleetTelemetryService.flush', () => {
  it('requeues the batch instead of dropping it when the insert fails', async () => {
    const { service, transitionRepo } = makeService();
    (service as unknown as { sessionId: string | null }).sessionId =
      'session-1';
    transitionRepo.insert.mockRejectedValueOnce(new Error('db down'));
    (service as unknown as { record: (s: KernelVehicleState) => void }).record(
      vehicleState({ currentPosition: 'P1' }),
    );

    await (service as unknown as { flush: () => Promise<void> }).flush();

    expect(transitionRepo.insert).toHaveBeenCalledTimes(1);
    expect((service as unknown as { buffer: unknown[] }).buffer).toHaveLength(
      1,
    );

    transitionRepo.insert.mockResolvedValueOnce(undefined);
    await (service as unknown as { flush: () => Promise<void> }).flush();

    expect(transitionRepo.insert).toHaveBeenCalledTimes(2);
    expect((service as unknown as { buffer: unknown[] }).buffer).toHaveLength(
      0,
    );
  });

  it('drops the oldest rows instead of growing without bound during a sustained outage', async () => {
    const { service, transitionRepo } = makeService();
    (service as unknown as { sessionId: string | null }).sessionId =
      'session-1';
    transitionRepo.insert.mockRejectedValue(new Error('db down'));
    const record = (
      service as unknown as { record: (s: KernelVehicleState) => void }
    ).record.bind(service);
    const flush = (
      service as unknown as { flush: () => Promise<void> }
    ).flush.bind(service);

    for (let i = 0; i < 5_010; i += 1) {
      record(vehicleState({ currentPosition: `P${i}` }));

      await flush();
    }

    const buffer = (service as unknown as { buffer: { pointName: string }[] })
      .buffer;
    expect(buffer.length).toBe(5_000);
    expect(buffer[0].pointName).toBe('P10');
    expect(buffer[buffer.length - 1].pointName).toBe('P5009');
  });
});
