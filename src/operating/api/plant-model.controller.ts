import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { ActiveMapScopeGuard } from '../../maps/api/active-map-scope.guard';
import { OperatingPlantModelService } from '../application/operating-plant-model.service';
import type {
  PlantModelLocationDto,
  PlantModelLocationTypeDto,
  PlantModelPathDto,
  PlantModelPointsDto,
} from '../dto/operating.dto';

@ApiTags('operating')
@UseGuards(JwtAuthGuard, ActiveMapScopeGuard)
@Controller('operating/plant-model')
export class OperatingPlantModelController {
  constructor(private readonly plantModel: OperatingPlantModelService) {}

  @Get('points')
  points(): Promise<PlantModelPointsDto> {
    return this.plantModel.points();
  }

  @Get('paths')
  paths(): Promise<PlantModelPathDto[]> {
    return this.plantModel.paths();
  }

  @Get('location-types')
  locationTypes(): Promise<PlantModelLocationTypeDto[]> {
    return this.plantModel.locationTypes();
  }

  @Get('locations')
  locations(): Promise<PlantModelLocationDto[]> {
    return this.plantModel.locations();
  }
}
