import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  FMS_EVENTS,
  FmsVehicleErrorChangedEvent,
} from '../cargo/domain/events';
import { VehicleErrorEventEntity } from './entities/vehicle-error-event.entity';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';

@Injectable()
export class VehicleErrorService {
  private readonly logger = new Logger(VehicleErrorService.name);

  constructor(
    @InjectRepository(VehicleErrorEventEntity)
    private readonly repo: Repository<VehicleErrorEventEntity>,
    private readonly activeMap: ActiveMapContext,
  ) {}

  @OnEvent(FMS_EVENTS.VEHICLE_ERROR_CHANGED)
  async record(event: FmsVehicleErrorChangedEvent): Promise<void> {
    try {
      await this.repo.insert({
        vehicleName: event.vehicleName,
        kind: event.kind,
        fatalErrorTypes: event.fatal,
        warningErrorTypes: event.warning,
        vehicleState: event.vehicleState,
        pointName: event.pointName,
        transportOrderName: event.transportOrderName,
        metadata: {},
        occurredAt: new Date(),
        observedAt: this.toDate(event.observedAt),
        mapRecordId: await this.activeMap.id().catch(() => null),
      });
    } catch (error) {
      this.logger.error(
        `Cannot record vehicle error event for ${event.vehicleName}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private toDate(value: string | null): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}
