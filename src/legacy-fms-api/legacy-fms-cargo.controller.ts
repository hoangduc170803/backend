import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt-payload';
import { LegacyFmsCargoService } from './legacy-fms-cargo.service';
import { LegacyFmsExceptionFilter } from './legacy-fms-exception.filter';
import type { LegacyCargoDto } from './legacy-fms.mapping';

const LEGACY_ERROR_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'integer', example: 40901 },
    error: { type: 'string', example: 'Position is occupied by another cargo' },
  },
};
const PERMISSION_DENIED = {
  status: 403,
  description:
    'Thiếu/sai token hoặc thiếu quyền — body là chuỗi "Permission denied!"',
};

@ApiTags('Máy quét')
@ApiBearerAuth()
@UseFilters(LegacyFmsExceptionFilter)
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('v1')
export class LegacyFmsCargoController {
  constructor(private readonly legacy: LegacyFmsCargoService) {}

  @Post('cargo')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Thêm hàng (máy quét)',
    description:
      'name = mã hàng, position = điểm lấy hàng (tên point), destination = tên Zone đích. Cần quyền cargo.create.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'position', 'destination'],
      properties: {
        name: { type: 'string', example: 'SKU-0001' },
        position: { type: 'string', example: 'Point-0001' },
        destination: { type: 'string', example: 'SHIPPING-A' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Đã tạo hàng (LegacyCargoDto)' })
  @ApiResponse({
    status: 400,
    description:
      '40001 thiếu trường / không phải điểm hàng · 40002 không có vị trí · 40003 không có đích · 40004 đích không phải SHIPPING',
    schema: LEGACY_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description:
      '40900 trùng tên · 40901 vị trí có hàng · 40902 vị trí có xe · 40903 đích đầy',
    schema: LEGACY_ERROR_SCHEMA,
  })
  @ApiResponse(PERMISSION_DENIED)
  @RequirePermissions('cargo.create')
  createCargo(
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
  ): Promise<LegacyCargoDto> {
    return this.legacy.createCargo(body, user.sub, user.mapIds);
  }

  @Get('zones/:position/status')
  @ApiOperation({ summary: 'Kiểm tra vị trí lấy hàng còn trống (máy quét)' })
  @ApiParam({ name: 'position', example: 'Point-0001' })
  @ApiResponse({
    status: 200,
    schema: { example: { 'Position available': true } },
  })
  @ApiResponse({
    status: 400,
    description: '40001 không phải điểm hàng · 40002 không có vị trí',
    schema: LEGACY_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: '40901 vị trí có hàng · 40902 vị trí có xe',
    schema: LEGACY_ERROR_SCHEMA,
  })
  @ApiResponse(PERMISSION_DENIED)
  positionStatus(
    @Param('position') position: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ 'Position available': true }> {
    return this.legacy.assertPositionAvailable(position, user.mapIds);
  }

  @Get('stores/:destination/status')
  @ApiOperation({ summary: 'Kiểm tra đích còn chỗ (máy quét)' })
  @ApiParam({ name: 'destination', example: 'SHIPPING-A' })
  @ApiResponse({
    status: 200,
    schema: { example: { 'Destination available': true } },
  })
  @ApiResponse({
    status: 400,
    description: '40003 không có đích · 40004 đích không phải SHIPPING',
    schema: LEGACY_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: '40903 đích đầy',
    schema: LEGACY_ERROR_SCHEMA,
  })
  @ApiResponse(PERMISSION_DENIED)
  destinationStatus(
    @Param('destination') destination: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ 'Destination available': true }> {
    return this.legacy.assertDestinationAvailable(destination, user.mapIds);
  }
}
