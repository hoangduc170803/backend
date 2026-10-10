import { BadRequestException } from '@nestjs/common';
import type { KernelApiService } from '../opentcs/kernel-api.service';
import { SimulatorTargetPointService } from './simulator-target-point.service';
import type { SimulatorCommandDto } from './simulator.dto';

function serviceWithPoints(
  points: Array<{ name: string; position: { x: number; y: number } }> | null,
) {
  const getPlantModelView = jest
    .fn()
    .mockResolvedValue(points ? { points } : null);
  const kernelApi = { getPlantModelView } as unknown as KernelApiService;
  return {
    service: new SimulatorTargetPointService(kernelApi),
    getPlantModelView,
  };
}

const lostNavigation = (
  extra: Partial<SimulatorCommandDto> = {},
): SimulatorCommandDto => ({
  command: 'triggerError',
  errorType: 'adapterLostNavigation',
  ...extra,
});

describe('SimulatorTargetPointService', () => {
  it('leaves every other command untouched without asking the kernel', async () => {
    const { service, getPlantModelView } = serviceWithPoints([]);
    const command: SimulatorCommandDto = {
      command: 'triggerError',
      errorType: 'orderError',
    };

    await expect(service.withTargetCoordinates(command)).resolves.toBe(command);
    expect(getPlantModelView).not.toHaveBeenCalled();
  });

  it('fills the target point coordinates in metres from the loaded map', async () => {
    const { service } = serviceWithPoints([
      { name: '0014', position: { x: 36000, y: -1500 } },
    ]);

    await expect(
      service.withTargetCoordinates(lostNavigation({ targetNodeId: '0014' })),
    ).resolves.toEqual(
      lostNavigation({ targetNodeId: '0014', x: 36, y: -1.5 }),
    );
  });

  it('fills the coordinates of the point a vehicle is moved to under e-stop', async () => {
    const { service } = serviceWithPoints([
      { name: '0014', position: { x: 36000, y: -1500 } },
    ]);

    await expect(
      service.withTargetCoordinates({
        command: 'setPosition',
        targetNodeId: '0014',
      }),
    ).resolves.toEqual({
      command: 'setPosition',
      targetNodeId: '0014',
      x: 36,
      y: -1.5,
    });
  });

  it('rejects moving a vehicle without a target point', async () => {
    const { service } = serviceWithPoints([]);

    await expect(
      service.withTargetCoordinates({ command: 'setPosition' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps coordinates the caller supplied', async () => {
    const { service, getPlantModelView } = serviceWithPoints([]);
    const command = lostNavigation({ targetNodeId: 'OFF-GRID', x: 1, y: 2 });

    await expect(service.withTargetCoordinates(command)).resolves.toBe(command);
    expect(getPlantModelView).not.toHaveBeenCalled();
  });

  it('rejects a lost-navigation injection without a target point', async () => {
    const { service } = serviceWithPoints([]);

    await expect(
      service.withTargetCoordinates(lostNavigation()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a point that is not on the loaded map', async () => {
    const { service } = serviceWithPoints([
      { name: '0014', position: { x: 0, y: 0 } },
    ]);

    await expect(
      service.withTargetCoordinates(lostNavigation({ targetNodeId: '9999' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when the kernel has no plant model to look the point up in', async () => {
    const { service } = serviceWithPoints(null);

    await expect(
      service.withTargetCoordinates(lostNavigation({ targetNodeId: '0014' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
