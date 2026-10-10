import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  SimulatorBrokerView,
  SimulatorFleetView,
  SimulatorVehicleView,
} from './simulator.dto';

const DEFAULT_SIMULATOR_URL = 'http://127.0.0.1:8091';
const REQUEST_TIMEOUT_MS = 5_000;
const UNREACHABLE = 'Không kết nối được dịch vụ mô phỏng AGV';

interface UpstreamFleet {
  startedAt: string;
  broker: SimulatorBrokerView;
  vehicles: SimulatorVehicleView[];
}

class SimulatorUnreachableError extends Error {}

@Injectable()
export class SimulatorGatewayService {
  private readonly logger = new Logger(SimulatorGatewayService.name);
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: ConfigService) {
    this.baseUrl = (
      config.get<string>('SIMULATOR_URL') ?? DEFAULT_SIMULATOR_URL
    ).replace(/\/+$/, '');
    this.token = config.get<string>('SIMULATOR_TOKEN') ?? '';
  }

  async fleet(): Promise<SimulatorFleetView> {
    try {
      return available(await this.request('GET', '/api/fleet'));
    } catch (error) {
      if (error instanceof SimulatorUnreachableError) {
        return {
          available: false,
          reason: error.message,
          startedAt: null,
          broker: null,
          vehicles: [],
        };
      }
      throw error;
    }
  }

  write(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: object,
  ): Promise<SimulatorFleetView> {
    return this.request(method, path, body).then(available, (error) => {
      if (error instanceof SimulatorUnreachableError) {
        throw new ServiceUnavailableException(
          `${UNREACHABLE}: ${error.message}`,
        );
      }
      throw error;
    });
  }

  private async request(
    method: string,
    path: string,
    body?: object,
  ): Promise<UpstreamFleet> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.token ? { 'X-Simulator-Token': this.token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new SimulatorUnreachableError(`${this.baseUrl} (${cause})`);
    }
    if (response.ok) return (await response.json()) as UpstreamFleet;
    throw await this.toHttpException(response);
  }

  private async toHttpException(response: Response): Promise<HttpException> {
    const message = await response
      .json()
      .then((payload: { message?: string }) => payload.message)
      .catch(() => undefined);
    const text = message ?? `Simulator HTTP ${response.status}`;
    if (response.status === 400) return new BadRequestException(text);
    if (response.status === 404) return new NotFoundException(text);
    if (response.status === 409) return new ConflictException(text);
    this.logger.warn(`Simulator trả ${response.status}: ${text}`);
    return new BadGatewayException(text);
  }
}

function available(fleet: UpstreamFleet): SimulatorFleetView {
  return { available: true, reason: null, ...fleet };
}
