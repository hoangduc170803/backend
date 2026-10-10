import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { AxiosError } from 'axios';
import { KernelApiService } from './kernel-api.service';

const logger = new Logger('SavePlantModel');

export async function savePlantModel(
  kernelApi: KernelApiService,
  model: unknown,
): Promise<void> {
  try {
    await kernelApi.putRawPlantModel(model);
  } catch (err) {
    const axiosErr = err as AxiosError;
    const status = axiosErr.response?.status;
    const kernelReason = describeKernelError(axiosErr.response?.data);
    logger.warn(
      `Kernel rejected plant model (status ${status ?? 'n/a'}): ${kernelReason ?? axiosErr.message}`,
    );
    const msg =
      status !== undefined
        ? `Hệ thống điều khiển từ chối bản đồ (HTTP ${status}): ${kernelReason ?? axiosErr.message}`
        : `Không thể kết nối hệ thống điều khiển: ${axiosErr.message}`;
    throw new ServiceUnavailableException(msg);
  }
}

function describeKernelError(data: unknown): string | null {
  if (data == null || data === '') return null;
  if (typeof data === 'string') return data.slice(0, 1000);
  if (Array.isArray(data)) return data.map(String).join('; ').slice(0, 1000);
  return JSON.stringify(data).slice(0, 1000);
}
