import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { AxiosError } from 'axios';
import { kernelReason } from './vehicle-command-error';

/** The kernel's REST API maps `ObjectExistsException` to 409 and `ObjectUnknownException` to
 *  404 (see `ServiceWebApi` in the kernel source) — null if `err` isn't an HTTP error at all
 *  (network failure, timeout). */
export function kernelHttpStatus(err: unknown): number | null {
  return (err as AxiosError)?.response?.status ?? null;
}

export function toTransportOrderException(
  err: unknown,
  orderName: string,
  action: string,
): HttpException {
  const axiosErr = err as AxiosError;
  const reason = kernelReason(axiosErr.response?.data) ?? axiosErr.message;
  return new ServiceUnavailableException(
    `Không thể ${action} lệnh vận chuyển "${orderName}" trên hệ thống điều khiển: ${reason}`,
  );
}
