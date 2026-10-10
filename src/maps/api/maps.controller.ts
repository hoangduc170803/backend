import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  MessageEvent,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  Sse,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { MapLibraryService } from '../application/map-library.service';
import { KernelMapService } from '../application/kernel-map.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthUser } from '../../auth/jwt-payload';
import { VehicleStateStore } from '../../opentcs/vehicle-state.store';
import { ActiveMapContext } from '../infrastructure/active-map-context.service';
import { ActiveMapScopeGuard } from './active-map-scope.guard';

const SSE_HEARTBEAT_MS = 5_000;

interface UploadFile {
  buffer: Buffer;
  originalname: string;
  size: number;
  mimetype: string;
}

@ApiTags('maps')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('maps')
export class MapsController {
  constructor(
    private readonly mapLibrary: MapLibraryService,
    private readonly kernelMap: KernelMapService,
    private readonly vehicleStateStore: VehicleStateStore,
    private readonly activeMap: ActiveMapContext,
  ) {}

  @Get('kernel-status')
  getKernelStatus() {
    return this.kernelMap.getKernelStatus();
  }

  @Get('current')
  @UseGuards(ActiveMapScopeGuard)
  getCurrent() {
    return this.kernelMap.getCurrent();
  }

  @Get('plant-model')
  @UseGuards(ActiveMapScopeGuard)
  getPlantModel() {
    return this.kernelMap.getPlantModel();
  }

  @Get('health')
  @UseGuards(ActiveMapScopeGuard)
  getHealth() {
    return this.kernelMap.getHealth();
  }

  @Get('plant-model/xml')
  @UseGuards(ActiveMapScopeGuard)
  @RequirePermissions('map.download')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async getPlantModelXml(): Promise<string> {
    const xml = await this.kernelMap.getPlantModelXml();
    if (xml == null)
      throw new NotFoundException('Kernel has no plant model loaded.');
    return xml;
  }

  @Get('cargo-options')
  @UseGuards(ActiveMapScopeGuard)
  getCargoOptions() {
    return this.kernelMap.getCargoOptions();
  }

  @Get('kernel/vehicles')
  getKernelVehicles() {
    return this.kernelMap.getKernelVehicles();
  }

  @Sse('kernel/sse')
  vehicleStream(): Observable<MessageEvent> {
    return merge(
      this.vehicleStateStore.vehicleUpdates.pipe(
        map((vehicle) => ({ data: vehicle })),
      ),
      interval(SSE_HEARTBEAT_MS).pipe(
        map(() => ({ type: 'heartbeat', data: '' })),
      ),
    );
  }

  @Get('kernel/debug')
  @UseGuards(ActiveMapScopeGuard)
  getKernelDebug() {
    return this.kernelMap.getKernelDebug();
  }

  @Post('kernel/transport-orders/:name/withdraw')
  @RequirePermissions('order.withdraw')
  withdrawTO(@Param('name') name: string) {
    return this.kernelMap.withdrawTransportOrder(name);
  }

  @Get('kernel/events')
  @UseGuards(ActiveMapScopeGuard)
  getKernelEvents(
    @Query('minSequenceNo') minSequenceNo?: string,
    @Query('timeout') timeout?: string,
  ) {
    const seq = Math.max(0, parseInt(minSequenceNo ?? '0', 10) || 0);
    const ms = Math.min(
      10_000,
      Math.max(0, parseInt(timeout ?? '1000', 10) || 1000),
    );
    return this.kernelMap.proxyKernelEvents(seq, ms);
  }

  @Get('library')
  getLibrary(@CurrentUser() user: AuthUser) {
    return this.mapLibrary.listLibrary(user.mapIds);
  }

  @Get('active-identity')
  async activeIdentity() {
    return { mapRecordId: await this.activeMap.id() };
  }

  @Get('library/:id/xml')
  @RequirePermissions('map.download')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async getLibraryXml(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const file = await this.mapLibrary.getLibraryXml(id, user.mapIds);
    const fallback = file.filename
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    return file.content;
  }

  @Get('library/:id')
  getLibraryMap(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.mapLibrary.getLibraryMap(id, user.mapIds);
  }

  @Post('library')
  @RequirePermissions('map.upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  uploadToLibrary(
    @UploadedFile() file: UploadFile | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) throw new BadRequestException('Vui lòng chọn file XML.');
    return this.mapLibrary.uploadToLibrary(
      file.buffer,
      file.originalname,
      user.sub,
    );
  }

  @Post('library/:id/load')
  @RequirePermissions('map.upload')
  loadLibraryMap(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.mapLibrary.loadLibraryMap(id, user.mapIds);
  }

  @Delete('library/:id')
  @HttpCode(204)
  @RequirePermissions('map.delete')
  @ApiOperation({
    summary: 'Xoá bản đồ khỏi thư viện WES',
    description:
      'Xoá mềm một bản đồ đã lưu: bản đồ biến mất khỏi thư viện và không nạp lại được, ' +
      'nhưng khu vực, xe và lịch sử nhiệm vụ gắn với nó vẫn giữ nguyên và vẫn hiện tên bản đồ. ' +
      'Không đụng tới trung tâm điều phối. Quyền: `map.delete`; vai trò bị giới hạn phạm vi ' +
      'bản đồ chỉ xoá được bản đồ trong phạm vi của mình.',
  })
  @ApiParam({ name: 'id', description: 'ID bản đồ trong thư viện (uuid).' })
  @ApiNoContentResponse({ description: 'Đã xoá bản đồ khỏi thư viện.' })
  @ApiForbiddenResponse({
    description:
      'Thiếu quyền map.delete, hoặc bản đồ nằm ngoài phạm vi vai trò.',
  })
  @ApiNotFoundResponse({
    description: 'Không có bản đồ này trong thư viện (hoặc đã bị xoá).',
  })
  @ApiConflictResponse({
    description:
      'Bản đồ đang được nạp trong trung tâm điều phối, hoặc không đọc được bản đồ đang chạy để xác nhận.',
  })
  async deleteLibraryMap(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.mapLibrary.deleteLibraryMap(id, user.sub, user.mapIds);
  }
}
