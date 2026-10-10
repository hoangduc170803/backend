import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

const VEHICLE_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const POINT_NAME = /^[^\s/#+]{1,64}$/;
const MAX_VOLTAGE = 30;

export const SIMULATOR_COMMANDS = [
  'setLaser',
  'triggerError',
  'clearErrors',
  'setCancelResponseMode',
  'setSpeed',
  'clearLoad',
  'setBattery',
  'setPaused',
  'setEStop',
  'setPosition',
] as const;

export const SIMULATOR_ESTOP_STATES = [
  'NONE',
  'MANUAL',
  'AUTOACK',
  'REMOTE',
] as const;

export const SIMULATOR_ERROR_TYPES = [
  'validationError',
  'orderError',
  'orderUpdateError',
  'noRouteError',
  'adapterLostNavigation',
] as const;

export const SIMULATOR_CANCEL_MODES = ['RANDOM', 'NO_RESPONSE'] as const;

export class CreateSimulatorVehicleDto {
  @ApiProperty({
    example: 'V01',
    description:
      'Tên xe, cũng là serialNumber VDA5050 và MQTT client id — phải trùng tên xe trên kernel.',
  })
  @Matches(VEHICLE_NAME, {
    message: 'Tên xe gồm 1–32 ký tự chữ, số, "-" hoặc "_"',
  })
  name: string;

  @ApiProperty({ example: '2000', description: 'Điểm xe đứng khi bật.' })
  @Matches(POINT_NAME, {
    message: 'Vị trí là tên điểm 1–64 ký tự, không có khoảng trắng',
  })
  position: string;

  @ApiPropertyOptional({ example: 99, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  battery?: number;

  @ApiPropertyOptional({ example: 26, minimum: 0, maximum: MAX_VOLTAGE })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_VOLTAGE)
  voltage?: number;
}

export class UpdateSimulatorVehicleDto {
  @ApiPropertyOptional({ example: '2000' })
  @IsOptional()
  @Matches(POINT_NAME, {
    message: 'Vị trí là tên điểm 1–64 ký tự, không có khoảng trắng',
  })
  position?: string;

  @ApiPropertyOptional({ example: 99, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  battery?: number;

  @ApiPropertyOptional({ example: 26, minimum: 0, maximum: MAX_VOLTAGE })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_VOLTAGE)
  voltage?: number;
}

export class SimulatorPowerDto {
  @ApiProperty({ description: 'true = bật (kết nối broker), false = tắt.' })
  @IsBoolean()
  on: boolean;
}

export class SimulatorCommandDto {
  @ApiProperty({ enum: SIMULATOR_COMMANDS })
  @IsIn(SIMULATOR_COMMANDS)
  command: (typeof SIMULATOR_COMMANDS)[number];

  @ApiPropertyOptional({
    description:
      'setLaser: bật/tắt cảm biến laser. setEStop: true = xe báo safetyState.eStop "MANUAL", false = "NONE"; ' +
      'nhả e-stop khi đã có setPosition thì xe báo lastNodeId là điểm mới và bỏ hết node, edge đang giữ.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    description:
      'setPaused: giá trị `paused` xe tự báo trong VDA5050 state (xe tự dừng, không qua instant action).',
  })
  @IsOptional()
  @IsBoolean()
  paused?: boolean;

  @ApiPropertyOptional({
    enum: SIMULATOR_ERROR_TYPES,
    description: 'triggerError: loại lỗi tiêm vào state.errors.',
  })
  @IsOptional()
  @IsIn(SIMULATOR_ERROR_TYPES)
  errorType?: (typeof SIMULATOR_ERROR_TYPES)[number];

  @ApiPropertyOptional({
    enum: SIMULATOR_CANCEL_MODES,
    description: 'setCancelResponseMode: xe có trả lời cancelOrder hay không.',
  })
  @IsOptional()
  @IsIn(SIMULATOR_CANCEL_MODES)
  mode?: (typeof SIMULATOR_CANCEL_MODES)[number];

  @ApiPropertyOptional({
    description: 'setSpeed: hệ số tốc độ mô phỏng, 0 < speed < 10.',
    example: 2,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(9.9)
  speed?: number;

  @ApiPropertyOptional({
    description: 'setBattery: mức pin mới (%).',
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  level?: number;

  @ApiPropertyOptional({
    example: '0014',
    description:
      'adapterLostNavigation (bắt buộc): tên điểm xe bị đặt lại vào khi mất định vị. ' +
      'setPosition (bắt buộc): tên điểm xe được đặt vào trong lúc e-stop.',
  })
  @IsOptional()
  @Matches(POINT_NAME, {
    message: 'targetNodeId là tên điểm 1–64 ký tự, không có khoảng trắng',
  })
  targetNodeId?: string;

  @ApiPropertyOptional({
    description:
      'adapterLostNavigation, setPosition: toạ độ x (m). Bỏ trống cả x và y để lấy toạ độ điểm từ bản đồ đang nạp.',
  })
  @IsOptional()
  @IsNumber()
  x?: number;

  @ApiPropertyOptional({
    description:
      'adapterLostNavigation, setPosition: toạ độ y (m). Bỏ trống cả x và y để lấy toạ độ điểm từ bản đồ đang nạp.',
  })
  @IsOptional()
  @IsNumber()
  y?: number;

  @ApiPropertyOptional({
    description: 'adapterLostNavigation, setPosition: góc (rad).',
  })
  @IsOptional()
  @IsNumber()
  theta?: number;

  @ApiPropertyOptional({
    description: 'adapterLostNavigation, setPosition: mapId.',
  })
  @IsOptional()
  @IsString()
  mapId?: string;
}

export class SimulatorBrokerView {
  @ApiProperty({ example: 'mqtt' })
  host: string;

  @ApiProperty({ example: 1883 })
  port: number;

  @ApiProperty({ example: 'fms' })
  username: string;
}

export class SimulatorVehicleView {
  @ApiProperty({ example: 'V01' })
  name: string;

  @ApiProperty({
    example: '2000',
    description: 'Vị trí hiện tại khi đang bật, điểm xuất phát khi đang tắt.',
  })
  position: string;

  @ApiProperty({ example: 99 })
  battery: number;

  @ApiProperty({ example: 26 })
  voltage: number;

  @ApiProperty({ enum: ['OFF', 'CONNECTING', 'ONLINE', 'DISCONNECTING'] })
  power: 'OFF' | 'CONNECTING' | 'ONLINE' | 'DISCONNECTING';

  @ApiProperty({
    description:
      'Người dùng muốn xe bật; xe chưa kết nối được vẫn được thử lại.',
  })
  desiredOn: boolean;

  @ApiPropertyOptional({ nullable: true })
  lastError: string | null;

  @ApiPropertyOptional({ description: 'Đang giữ kết nối MQTT.' })
  connected?: boolean;

  @ApiPropertyOptional()
  driving?: boolean;

  @ApiPropertyOptional({
    description: 'Giá trị `paused` xe đang báo trong state.',
  })
  paused?: boolean;

  @ApiPropertyOptional({
    enum: SIMULATOR_ESTOP_STATES,
    description: 'Giá trị safetyState.eStop xe đang báo trong state.',
  })
  eStop?: (typeof SIMULATOR_ESTOP_STATES)[number];

  @ApiPropertyOptional()
  charging?: boolean;

  @ApiPropertyOptional()
  loaded?: boolean;

  @ApiPropertyOptional({ nullable: true })
  orderId?: string | null;

  @ApiPropertyOptional()
  laserActive?: boolean;

  @ApiPropertyOptional({ nullable: true })
  activeError?: string | null;

  @ApiPropertyOptional({ type: [String] })
  errors?: string[];

  @ApiPropertyOptional({ enum: SIMULATOR_CANCEL_MODES })
  cancelResponseMode?: (typeof SIMULATOR_CANCEL_MODES)[number];

  @ApiPropertyOptional()
  cancelPending?: boolean;

  @ApiPropertyOptional({ example: 1 })
  speedMultiplier?: number;

  @ApiPropertyOptional({ example: 0 })
  pendingOrders?: number;

  @ApiPropertyOptional({
    nullable: true,
    example: '0014',
    description:
      'Điểm đã đặt bằng setPosition trong lúc e-stop, xe sẽ báo khi nhả e-stop; null khi không có.',
  })
  pendingPosition?: string | null;
}

export class SimulatorFleetView {
  @ApiProperty({
    description:
      'false khi WES không gọi được dịch vụ mô phỏng (container chưa chạy).',
  })
  available: boolean;

  @ApiPropertyOptional({ nullable: true })
  reason: string | null;

  @ApiPropertyOptional({ nullable: true })
  startedAt: string | null;

  @ApiPropertyOptional({ type: SimulatorBrokerView, nullable: true })
  broker: SimulatorBrokerView | null;

  @ApiProperty({ type: [SimulatorVehicleView] })
  vehicles: SimulatorVehicleView[];
}
