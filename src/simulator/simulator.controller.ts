import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { SimulatorTargetPointService } from './simulator-target-point.service';
import { SimulatorGatewayService } from './simulator-gateway.service';
import {
  CreateSimulatorVehicleDto,
  SimulatorCommandDto,
  SimulatorFleetView,
  SimulatorPowerDto,
  UpdateSimulatorVehicleDto,
} from './simulator.dto';

const MANAGE = 'simulator.manage';
const vehiclePath = (name: string, suffix = '') =>
  `/api/vehicles/${encodeURIComponent(name)}${suffix}`;

@ApiTags('simulator')
@ApiBearerAuth()
@ApiServiceUnavailableResponse({
  description: 'Dịch vụ mô phỏng không chạy hoặc không gọi được.',
})
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('simulator')
export class SimulatorController {
  constructor(
    private readonly simulator: SimulatorGatewayService,
    private readonly targetPoint: SimulatorTargetPointService,
  ) {}

  @Get('fleet')
  @ApiOperation({
    summary: 'Bảng mô phỏng AGV dùng chung',
    description:
      'Danh sách xe ảo của dịch vụ mô phỏng duy nhất phía máy chủ và trạng thái trực tiếp của từng xe. ' +
      'Mọi người dùng thấy cùng một bảng. Chỉ cần đăng nhập. ' +
      'Khi dịch vụ mô phỏng không chạy, trả 200 với `available: false` và `reason`.',
  })
  @ApiOkResponse({ type: SimulatorFleetView })
  fleet(): Promise<SimulatorFleetView> {
    return this.simulator.fleet();
  }

  @Post('fleet/power')
  @HttpCode(200)
  @RequirePermissions(MANAGE)
  @ApiOperation({
    summary: 'Bật / tắt toàn bộ xe ảo',
    description: `Quyền: \`${MANAGE}\`.`,
  })
  @ApiOkResponse({ type: SimulatorFleetView })
  @ApiForbiddenResponse({ description: `Thiếu quyền ${MANAGE}.` })
  setFleetPower(@Body() dto: SimulatorPowerDto): Promise<SimulatorFleetView> {
    return this.simulator.write('POST', '/api/fleet/power', dto);
  }

  @Post('vehicles')
  @HttpCode(200)
  @RequirePermissions(MANAGE)
  @ApiOperation({
    summary: 'Thêm xe ảo',
    description: `Xe mới ở trạng thái tắt. Quyền: \`${MANAGE}\`.`,
  })
  @ApiOkResponse({ type: SimulatorFleetView })
  @ApiBadRequestResponse({ description: 'Tên, vị trí hoặc pin không hợp lệ.' })
  @ApiConflictResponse({ description: 'Đã có xe trùng tên.' })
  @ApiForbiddenResponse({ description: `Thiếu quyền ${MANAGE}.` })
  addVehicle(
    @Body() dto: CreateSimulatorVehicleDto,
  ): Promise<SimulatorFleetView> {
    return this.simulator.write('POST', '/api/vehicles', dto);
  }

  @Patch('vehicles/:name')
  @RequirePermissions(MANAGE)
  @ApiOperation({
    summary: 'Sửa điểm xuất phát / pin của xe ảo đang tắt',
    description: `Quyền: \`${MANAGE}\`.`,
  })
  @ApiParam({ name: 'name', example: 'V01' })
  @ApiOkResponse({ type: SimulatorFleetView })
  @ApiNotFoundResponse({ description: 'Không có xe ảo này.' })
  @ApiConflictResponse({ description: 'Xe đang bật — tắt trước khi sửa.' })
  @ApiForbiddenResponse({ description: `Thiếu quyền ${MANAGE}.` })
  updateVehicle(
    @Param('name') name: string,
    @Body() dto: UpdateSimulatorVehicleDto,
  ): Promise<SimulatorFleetView> {
    return this.simulator.write('PATCH', vehiclePath(name), dto);
  }

  @Delete('vehicles/:name')
  @RequirePermissions(MANAGE)
  @ApiOperation({
    summary: 'Xoá xe ảo đang tắt',
    description: `Quyền: \`${MANAGE}\`.`,
  })
  @ApiParam({ name: 'name', example: 'V01' })
  @ApiOkResponse({ type: SimulatorFleetView })
  @ApiNotFoundResponse({ description: 'Không có xe ảo này.' })
  @ApiConflictResponse({ description: 'Xe đang bật — tắt trước khi xoá.' })
  @ApiForbiddenResponse({ description: `Thiếu quyền ${MANAGE}.` })
  removeVehicle(@Param('name') name: string): Promise<SimulatorFleetView> {
    return this.simulator.write('DELETE', vehiclePath(name));
  }

  @Post('vehicles/:name/power')
  @HttpCode(200)
  @RequirePermissions(MANAGE)
  @ApiOperation({
    summary: 'Bật / tắt một xe ảo',
    description:
      'Bật: xe kết nối broker MQTT và phát VDA5050 state; không kết nối được thì tự thử lại. ' +
      `Tắt: xe phát CONNECTIONBROKEN rồi ngắt, lần bật sau đứng lại đúng chỗ cũ. Quyền: \`${MANAGE}\`.`,
  })
  @ApiParam({ name: 'name', example: 'V01' })
  @ApiOkResponse({ type: SimulatorFleetView })
  @ApiNotFoundResponse({ description: 'Không có xe ảo này.' })
  @ApiConflictResponse({ description: 'Xe đang trong lúc ngắt kết nối.' })
  @ApiForbiddenResponse({ description: `Thiếu quyền ${MANAGE}.` })
  setVehiclePower(
    @Param('name') name: string,
    @Body() dto: SimulatorPowerDto,
  ): Promise<SimulatorFleetView> {
    return this.simulator.write('POST', vehiclePath(name, '/power'), dto);
  }

  @Post('vehicles/:name/command')
  @HttpCode(200)
  @RequirePermissions(MANAGE)
  @ApiOperation({
    summary: 'Gửi lệnh mô phỏng cho một xe ảo đang bật',
    description:
      'Laser, tiêm lỗi, xoá lỗi, chế độ trả lời cancel, tốc độ mô phỏng, bỏ tải, đặt pin, tự dừng, e-stop. ' +
      'Mọi lệnh đổi trạng thái của chính xe ảo — tức nội dung VDA5050 state xe phát lên — chứ không gửi ' +
      'instant action xuống xe: `setPaused` đổi `paused`, `setEStop` đổi `safetyState.eStop` giữa NONE và MANUAL. ' +
      'Tiêm `adapterLostNavigation` cần `targetNodeId`: xe bị đặt vào điểm đó, dừng lại và báo lỗi mức FATAL ' +
      'trong VDA5050 state để FMS xử lý; bỏ trống `x`/`y` thì lấy toạ độ điểm từ bản đồ đang nạp. ' +
      '`setPosition` (cần `targetNodeId`, toạ độ lấy như trên) chỉ nhận khi xe đang e-stop: điểm mới được giữ ở ' +
      '`pendingPosition`, state xe chưa đổi; khi `setEStop` về false xe báo `lastNodeId` là điểm đó ' +
      '(`lastNodeSequenceId` 0), bỏ hết nodeStates/edgeStates, đánh FAILED các action chưa xong và bỏ các order đang chờ. ' +
      `Quyền: \`${MANAGE}\`.`,
  })
  @ApiParam({ name: 'name', example: 'V01' })
  @ApiOkResponse({ type: SimulatorFleetView })
  @ApiBadRequestResponse({
    description:
      'Lệnh hoặc tham số không hợp lệ; adapterLostNavigation / setPosition thiếu targetNodeId hoặc điểm không có trên bản đồ đang nạp; ' +
      'setPosition khi xe không e-stop.',
  })
  @ApiNotFoundResponse({ description: 'Không có xe ảo này.' })
  @ApiConflictResponse({ description: 'Xe chưa bật.' })
  @ApiForbiddenResponse({ description: `Thiếu quyền ${MANAGE}.` })
  async command(
    @Param('name') name: string,
    @Body() dto: SimulatorCommandDto,
  ): Promise<SimulatorFleetView> {
    return this.simulator.write(
      'POST',
      vehiclePath(name, '/command'),
      await this.targetPoint.withTargetCoordinates(dto),
    );
  }
}
