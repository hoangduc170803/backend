import {
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AxiosError } from 'axios';

export function kernelReason(data: unknown): string | null {
  const messages = Array.isArray(data)
    ? data.filter((entry): entry is string => typeof entry === 'string')
    : typeof data === 'string'
      ? [data]
      : [];
  const joined = messages.join('; ').trim();
  return joined || null;
}

export function toVehicleCommandException(
  err: unknown,
  vehicleName: string,
  action: string,
): HttpException {
  const axiosErr = err as AxiosError;

  if (axiosErr.response?.status === 404) {
    return new NotFoundException(
      `Hệ thống điều khiển không có xe "${vehicleName}" trong bản đồ đang nạp nên không thể ${action}. ` +
        'Hãy nạp bản đồ có xe này, hoặc xoá AGV khỏi danh sách.',
    );
  }

  const reason = kernelReason(axiosErr.response?.data) ?? axiosErr.message;
  return new ServiceUnavailableException(
    `Không thể ${action} xe "${vehicleName}" trên hệ thống điều khiển: ${reason}`,
  );
}
