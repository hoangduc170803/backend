import {
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { WEIGHT_MAX } from './domain/dispatch-cost';

export class CreateDispatchPolicyDto {
  @IsString()
  @Length(1, 100)
  name!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(WEIGHT_MAX)
  weightBattery?: number;
}

export class UpdateDispatchPolicyDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(WEIGHT_MAX)
  weightBattery?: number;
}
