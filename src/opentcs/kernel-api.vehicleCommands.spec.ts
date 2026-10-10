import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import { KernelApiService } from './kernel-api.service';

function rejectPut(err: unknown): jest.Mock {
  const put = jest.spyOn(axios, 'put') as unknown as jest.Mock;
  put.mockRejectedValue(err);
  return put;
}

const unknownVehicle = {
  isAxiosError: true,
  message: 'Request failed with status code 404',
  response: { status: 404, data: ['Unknown vehicle: B300_3_3'] },
};

describe('KernelApiService vehicle commands', () => {
  afterEach(() => jest.restoreAllMocks());

  it('enables the comm adapter through the kernel', async () => {
    const put = jest.spyOn(axios, 'put') as unknown as jest.Mock;
    put.mockResolvedValue({ data: null });

    await new KernelApiService().setVehicleAdapterEnabled('B300_3_3', true);

    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/v1/vehicles/B300_3_3/commAdapter/enabled'),
      null,
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it('reports a vehicle missing from the loaded plant model as not found', async () => {
    rejectPut(unknownVehicle);

    await expect(
      new KernelApiService().setVehicleAdapterEnabled('B300_3_3', true),
    ).rejects.toThrow(NotFoundException);
  });

  it('names the vehicle and the remedy instead of failing opaquely', async () => {
    rejectPut(unknownVehicle);

    await expect(
      new KernelApiService().setVehicleIntegrationLevel(
        'B300_3_3',
        'TO_BE_UTILIZED',
      ),
    ).rejects.toThrow(/B300_3_3.*bản đồ đang nạp/s);
  });

  it('surfaces the kernel message when the command fails for another reason', async () => {
    rejectPut({
      isAxiosError: true,
      message: 'Request failed with status code 400',
      response: { status: 400, data: ['Kernel is not in operating mode'] },
    });

    await expect(
      new KernelApiService().setVehicleIntegrationLevel(
        'Vehicle-0001',
        'TO_BE_IGNORED',
      ),
    ).rejects.toThrow(/Kernel is not in operating mode/);
  });

  it('reports an unreachable kernel as a service failure, not a missing vehicle', async () => {
    rejectPut(new Error('connect ECONNREFUSED 127.0.0.1:55200'));

    await expect(
      new KernelApiService().setVehicleAdapterEnabled('Vehicle-0001', false),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
