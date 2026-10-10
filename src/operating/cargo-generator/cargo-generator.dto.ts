import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const GENERATOR_FILL_MODES = ['all', 'column', 'batch'] as const;
export const GENERATOR_PHASES = ['idle', 'running', 'waiting'] as const;
export const MIN_GENERATOR_INTERVAL_SECONDS = 5;
const MAX_SELECTED_AREAS = 200;

export type GeneratorPhase = (typeof GENERATOR_PHASES)[number];
export type GeneratorLogLevel = 'info' | 'warn' | 'error';

export class CargoGeneratorConfigDto {
  @ApiProperty({
    type: [String],
    description:
      'Các Zone lấy hàng (wesId) — hàng mới được đặt vào điểm trống.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_SELECTED_AREAS)
  @IsString({ each: true })
  zoneIds!: string[];

  @ApiProperty({
    type: [String],
    description:
      'Các Store đích (wesId) — mỗi hàng chọn ngẫu nhiên một Store còn chỗ.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_SELECTED_AREAS)
  @IsString({ each: true })
  storeIds!: string[];

  @ApiProperty({
    enum: GENERATOR_FILL_MODES,
    description:
      '`all`: điểm trống bất kỳ; `column`: lấp đầy từng cột; `batch`: thêm `batchSize` hàng vào một cột rồi bốc cột khác.',
  })
  @IsIn(GENERATOR_FILL_MODES)
  mode!: (typeof GENERATOR_FILL_MODES)[number];

  @ApiProperty({ minimum: 1, maximum: 1000 })
  @IsInt()
  @Min(1)
  @Max(1000)
  batchSize!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 3600,
    description: 'Số giây nghỉ sau mỗi hàng tạo thành công.',
  })
  @IsNumber()
  @Min(0)
  @Max(3600)
  delaySec!: number;

  @ApiProperty({
    minimum: MIN_GENERATOR_INTERVAL_SECONDS,
    maximum: 86400,
    description: 'Số giây giữa hai vòng tạo hàng.',
  })
  @IsNumber()
  @Min(MIN_GENERATOR_INTERVAL_SECONDS)
  @Max(86400)
  intervalSec!: number;
}

export class StartCargoGeneratorDto {
  @ApiProperty({ type: CargoGeneratorConfigDto })
  @ValidateNested()
  @Type(() => CargoGeneratorConfigDto)
  config!: CargoGeneratorConfigDto;
}

export class CargoGeneratorLogEntry {
  @ApiProperty()
  id!: number;

  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiProperty({ enum: ['info', 'warn', 'error'] })
  level!: GeneratorLogLevel;

  @ApiProperty({
    example: 'created',
    description: 'Mã sự kiện; client dịch bằng `tools.cargo.log_<key>`.',
  })
  key!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  })
  vars!: Record<string, string | number>;
}

export class CargoGeneratorOperator {
  @ApiProperty()
  userId!: string;

  @ApiProperty()
  username!: string;
}

export class CargoGeneratorStateDto {
  @ApiProperty({ enum: GENERATOR_PHASES })
  phase!: GeneratorPhase;

  @ApiProperty({
    type: CargoGeneratorConfigDto,
    nullable: true,
    description: 'Cấu hình của phiên đang chạy (hoặc phiên gần nhất).',
  })
  config!: CargoGeneratorConfigDto | null;

  @ApiProperty({ type: CargoGeneratorOperator, nullable: true })
  startedBy!: CargoGeneratorOperator | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  startedAt!: string | null;

  @ApiProperty()
  createdTotal!: number;

  @ApiProperty()
  createdThisRound!: number;

  @ApiProperty()
  rounds!: number;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  nextRoundAt!: string | null;

  @ApiProperty({
    type: [CargoGeneratorLogEntry],
    description: 'Mới nhất trước; tối đa 60 dòng.',
  })
  log!: CargoGeneratorLogEntry[];
}
