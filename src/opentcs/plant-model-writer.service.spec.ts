import { FMS_EVENTS } from '../cargo/domain/events';
import { PlantModelWriter } from './plant-model-writer.service';

function setup() {
  const steps: string[] = [];
  let model: Record<string, unknown> = { name: 'm', points: [], locations: [] };
  const kernel = {
    invalidatePlantModelCache: jest.fn(),
    getRawPlantModel: jest.fn(() => Promise.resolve(model)),
    putRawPlantModel: jest.fn(async (next: Record<string, unknown>) => {
      steps.push(`put:${String(next.name)}`);
      await Promise.resolve();
      model = next;
    }),
    initializeVehiclesForOperation: jest.fn(() => {
      steps.push('initialize');
      return Promise.resolve();
    }),
    getVehicleStates: jest.fn(() =>
      Promise.resolve([
        { name: 'V1', state: 'IDLE', integrationLevel: 'TO_BE_UTILIZED' },
        { name: 'V2', state: 'UNKNOWN', integrationLevel: 'TO_BE_RESPECTED' },
      ]),
    ),
    setVehicleAdapterEnabled: jest.fn(() => Promise.resolve()),
    setVehicleIntegrationLevel: jest.fn((name: string) => {
      steps.push(`restore:${name}`);
      return Promise.resolve();
    }),
  };
  const events = {
    emitAsync: jest.fn((event: string) => {
      steps.push(`event:${event}`);
      return Promise.resolve([]);
    }),
  };
  const writer = new PlantModelWriter(kernel as never, events as never);
  return { writer, kernel, events, steps, current: () => model };
}

describe('PlantModelWriter', () => {
  it('writes, publishes, handles the fleet, then resyncs the obstacles', async () => {
    const { writer, steps } = setup();

    await writer.replace(
      { name: 'next' },
      {
        reason: 'map load',
        vehicles: 'initialize',
        afterWrite: () => {
          steps.push('afterWrite');
          return Promise.resolve();
        },
      },
    );

    expect(steps).toEqual([
      `event:${FMS_EVENTS.PLANT_MODEL_REPLACING}`,
      'put:next',
      'afterWrite',
      'initialize',
      `event:${FMS_EVENTS.PLANT_MODEL_REPLACED}`,
    ]);
  });

  it('restores the running fleet after an edit, leaving detached vehicles alone', async () => {
    const { writer, steps } = setup();

    await writer.update((raw) => ({ ...raw, name: 'edited' }), {
      reason: 'zone edit',
      vehicles: 'restore',
    });

    expect(steps).toEqual([
      `event:${FMS_EVENTS.PLANT_MODEL_REPLACING}`,
      'put:edited',
      'restore:V1',
      `event:${FMS_EVENTS.PLANT_MODEL_REPLACED}`,
    ]);
  });

  it('serialises writes so two edits never overwrite each other', async () => {
    const { writer, current } = setup();
    const addLocation = (name: string) => (raw: Record<string, unknown>) => ({
      ...raw,
      locations: [...(raw.locations as string[]), name],
    });

    await Promise.all([
      writer.update(addLocation('A'), { reason: 'a', vehicles: 'restore' }),
      writer.update(addLocation('B'), { reason: 'b', vehicles: 'restore' }),
    ]);

    expect(current().locations).toEqual(['A', 'B']);
  });

  it('skips the write when there is nothing to change', async () => {
    const { writer, kernel, events } = setup();

    await expect(
      writer.update(() => null, { reason: 'noop', vehicles: 'restore' }),
    ).resolves.toBe(false);
    expect(kernel.putRawPlantModel).not.toHaveBeenCalled();
    expect(events.emitAsync).not.toHaveBeenCalled();
  });

  it('keeps serving writes after one failed', async () => {
    const { writer, kernel } = setup();
    kernel.putRawPlantModel.mockRejectedValueOnce(new Error('kernel down'));

    await expect(
      writer.replace({ name: 'x' }, { reason: 'a', vehicles: 'initialize' }),
    ).rejects.toThrow();
    await expect(
      writer.replace({ name: 'y' }, { reason: 'b', vehicles: 'initialize' }),
    ).resolves.toBeUndefined();
  });

  it('does not fail the write when a post-write listener fails', async () => {
    const { writer, events } = setup();
    events.emitAsync.mockRejectedValueOnce(new Error('resync failed'));

    await expect(
      writer.replace({ name: 'x' }, { reason: 'a', vehicles: 'initialize' }),
    ).resolves.toBeUndefined();
  });
});
