import { Controller, UseGuards, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { OperatingVehiclesService } from '../application/operating-vehicles.service';
import type { VehicleRealtimeDto } from '../dto/operating.dto';

@ApiTags('operating')
@UseGuards(JwtAuthGuard)
@Controller('operating/vehicles')
export class OperatingVehiclesController {
  constructor(private readonly vehicles: OperatingVehiclesService) {}

  @Get()
  list(): Promise<VehicleRealtimeDto[]> {
    return this.vehicles.snapshot();
  }
}
