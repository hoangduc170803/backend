import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import mqtt, { type MqttClient } from 'mqtt';

/**
 * Liveness probe for the VDA5050 MQTT broker — the same broker the openTCS kernel's comm
 * adapter uses to reach the AGVs (SRS §4.1 External Interfaces). wes has no functional use for
 * MQTT; this only lets the operating console report whether the broker is up. Configuration:
 * `MQTT_URL` (default `mqtt://127.0.0.1:1883`), optional `MQTT_USERNAME` / `MQTT_PASSWORD`.
 */
@Injectable()
export class MqttHealthService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MqttHealthService.name);
  private client: MqttClient | null = null;
  private lastConnectedAt: string | null = null;
  private lastDisconnectedAt: string | null = null;

  onApplicationBootstrap(): void {
    const url = process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883';

    this.client = mqtt.connect(url, {
      clientId: `wes-health-${Math.random().toString(16).slice(2, 10)}`,
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      reconnectPeriod: 5_000,
      connectTimeout: 8_000,
      queueQoSZero: false,
    });

    this.client.on('connect', () => {
      this.lastConnectedAt = new Date().toISOString();
      this.lastDisconnectedAt = null;
      this.logger.log(`MQTT broker reachable at ${url}`);
    });
    this.client.on('close', () => {
      if (this.lastConnectedAt && !this.lastDisconnectedAt) {
        this.lastDisconnectedAt = new Date().toISOString();
        this.logger.warn('MQTT broker connection lost');
      }
    });
    this.client.on('error', (err) => {
      this.logger.warn(`MQTT broker error: ${err.message}`);
    });
  }

  onApplicationShutdown(): void {
    this.client?.end(true);
    this.client = null;
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  get status(): { connected: boolean; since: string | null } {
    const connected = this.isConnected();
    return {
      connected,
      since: connected ? this.lastConnectedAt : this.lastDisconnectedAt,
    };
  }
}
