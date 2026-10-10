import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthUser } from '../../auth/jwt-payload';
import { CargoGeneratorService } from './cargo-generator.service';
import {
  CargoGeneratorStateDto,
  StartCargoGeneratorDto,
} from './cargo-generator.dto';

const CONTROL = 'cargo.create';
const DELETE_CARGO = 'cargo.cancel';

@ApiTags('cargo-generator')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('operating/cargo-generator')
export class CargoGeneratorController {
  constructor(private readonly generator: CargoGeneratorService) {}

  @Get()
  @ApiOperation({
    summary: 'Trạng thái bộ tạo hàng theo lịch dùng chung',
    description:
      'Bộ tạo hàng chạy trong tiến trình WES và chỉ có một phiên cho cả hệ thống: mọi người dùng thấy cùng trạng thái, ' +
      'cấu hình, bộ đếm và nhật ký. Chỉ cần đăng nhập.',
  })
  @ApiOkResponse({ type: CargoGeneratorStateDto })
  state(): CargoGeneratorStateDto {
    return this.generator.state();
  }

  @Post('start')
  @HttpCode(200)
  @RequirePermissions(CONTROL)
  @ApiOperation({
    summary: 'Bắt đầu phiên tạo hàng theo lịch',
    description:
      `Quyền: \`${CONTROL}\`. Hàng được tạo dưới tên người bấm chạy và trong phạm vi bản đồ của người đó. ` +
      `Store đã đầy hàng giao xong chỉ được dọn khi người bấm chạy có thêm quyền \`${DELETE_CARGO}\`. ` +
      'Đang có phiên chạy thì trả 409 — không bao giờ có hai phiên cùng lúc.',
  })
  @ApiOkResponse({ type: CargoGeneratorStateDto })
  @ApiBadRequestResponse({ description: 'Cấu hình không hợp lệ.' })
  @ApiForbiddenResponse({ description: `Thiếu quyền ${CONTROL}.` })
  @ApiConflictResponse({ description: 'Đã có phiên đang chạy.' })
  start(
    @Body() body: StartCargoGeneratorDto,
    @CurrentUser() user: AuthUser,
  ): CargoGeneratorStateDto {
    return this.generator.start(body.config, {
      userId: user.sub,
      username: user.username,
      mapIds: user.mapIds,
      canDeleteCargo: user.perms.includes(DELETE_CARGO),
    });
  }

  @Post('stop')
  @HttpCode(200)
  @RequirePermissions(CONTROL)
  @ApiOperation({
    summary: 'Dừng phiên tạo hàng đang chạy',
    description: `Quyền: \`${CONTROL}\`. Ai có quyền cũng dừng được phiên do người khác bắt đầu. Không có phiên nào thì không làm gì.`,
  })
  @ApiOkResponse({ type: CargoGeneratorStateDto })
  @ApiForbiddenResponse({ description: `Thiếu quyền ${CONTROL}.` })
  stop(@CurrentUser() user: AuthUser): CargoGeneratorStateDto {
    return this.generator.stop(user.username);
  }

  @Post('run-now')
  @HttpCode(200)
  @RequirePermissions(CONTROL)
  @ApiOperation({
    summary: 'Bỏ thời gian chờ, chạy vòng kế tiếp ngay',
    description: `Quyền: \`${CONTROL}\`. Không có tác dụng khi một vòng đang chạy hoặc không có phiên.`,
  })
  @ApiOkResponse({ type: CargoGeneratorStateDto })
  @ApiForbiddenResponse({ description: `Thiếu quyền ${CONTROL}.` })
  runNow(): CargoGeneratorStateDto {
    return this.generator.runNow();
  }

  @Post('reset-statistics')
  @HttpCode(200)
  @RequirePermissions(CONTROL)
  @ApiOperation({
    summary: 'Xoá bộ đếm và nhật ký của bộ tạo hàng',
    description: `Quyền: \`${CONTROL}\`. Chỉ khi không có phiên đang chạy.`,
  })
  @ApiOkResponse({ type: CargoGeneratorStateDto })
  @ApiForbiddenResponse({ description: `Thiếu quyền ${CONTROL}.` })
  @ApiConflictResponse({ description: 'Đang có phiên chạy.' })
  resetStatistics(): CargoGeneratorStateDto {
    return this.generator.resetStatistics();
  }
}
