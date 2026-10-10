import {
  KernelEnergyFloorService,
  withCriticalFloor,
} from './kernel-energy-floor.service';
import type { KernelApiService } from '../opentcs/kernel-api.service';

const vehicle = (name: string, critical: number, good = 90) => ({
  name,
  critical,
  good,
  sufficient: 40,
  full: 95,
});

describe('withCriticalFloor', () => {
  it('lowers the kernel critical threshold to the floor, keeping the rest', () => {
    expect(withCriticalFloor(vehicle('V1', 10), 5)).toEqual({
      ...vehicle('V1', 10),
      critical: 5,
    });
  });

  it('leaves a vehicle already at the floor alone', () => {
    expect(withCriticalFloor(vehicle('V1', 5), 5)).toBeNull();
  });

  it('keeps good at or above the new critical', () => {
    expect(withCriticalFloor(vehicle('V1', 2, 3), 5)?.good).toBe(5);
  });
});

describe('KernelEnergyFloorService', () => {
  it('pushes the floor only to vehicles that differ from it', async () => {
    const kernelApi = {
      getVehicleEnergyThresholds: jest
        .fn()
        .mockResolvedValue([vehicle('V1', 10), vehicle('V2', 5)]),
      setVehicleEnergyThresholds: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new KernelEnergyFloorService(
      kernelApi as unknown as KernelApiService,
    );

    await svc.reconcile();

    expect(kernelApi.setVehicleEnergyThresholds).toHaveBeenCalledTimes(1);
    expect(kernelApi.setVehicleEnergyThresholds).toHaveBeenCalledWith({
      ...vehicle('V1', 10),
      critical: 5,
    });
  });

  it('survives an unreachable kernel', async () => {
    const kernelApi = {
      getVehicleEnergyThresholds: jest
        .fn()
        .mockRejectedValue(new Error('down')),
      setVehicleEnergyThresholds: jest.fn(),
    };
    const svc = new KernelEnergyFloorService(
      kernelApi as unknown as KernelApiService,
    );

    await expect(svc.reconcile()).resolves.toBeUndefined();
    expect(kernelApi.setVehicleEnergyThresholds).not.toHaveBeenCalled();
  });
});
