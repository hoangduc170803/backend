import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KernelApiService } from './kernel-api.service';
import { PlantModelWriter } from './plant-model-writer.service';
import { TransportOrderService } from './transport-order.service';
import { KernelSyncService } from './kernel-sync.service';
import { KernelEventListenerService } from './kernel-event-listener.service';
import { VehicleStateStore } from './vehicle-state.store';
import { FleetTelemetryService } from './fleet-telemetry.service';
import { MqttHealthService } from './mqtt-health.service';
import { SseSessionEntity } from './entities/sse-session.entity';
import { VehicleStateTransitionEntity } from './entities/vehicle-state-transition.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SseSessionEntity, VehicleStateTransitionEntity]),
  ],
  providers: [
    VehicleStateStore,
    KernelApiService,
    PlantModelWriter,
    TransportOrderService,
    FleetTelemetryService,
    KernelSyncService,
    KernelEventListenerService,
    MqttHealthService,
  ],
  exports: [
    KernelApiService,
    PlantModelWriter,
    TransportOrderService,
    VehicleStateStore,
    MqttHealthService,
  ],
})
export class OpenTcsModule {}
