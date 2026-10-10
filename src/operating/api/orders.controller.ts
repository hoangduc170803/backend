import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { OperatingOrdersService } from '../application/operating-orders.service';
import type { TransportOrderDto } from '../dto/operating.dto';

@ApiTags('operating')
@UseGuards(JwtAuthGuard)
@Controller('operating/orders')
export class OperatingOrdersController {
  constructor(private readonly orders: OperatingOrdersService) {}

  @Get()
  @ApiOperation({
    summary: 'Lệnh vận chuyển đang mở và vừa kết thúc',
    description:
      'Đọc từ sổ lệnh của WES (`transport_request_orders`), không gọi openTCS: mọi lệnh còn mở của bản đồ ' +
      'đang nạp cộng các lệnh vừa kết thúc trong cửa sổ gần (mặc định 100 lệnh / 15 phút). Vẫn trả dữ liệu khi ' +
      'kernel tắt. Lịch sử đầy đủ: `GET /operating/transport-orders/registry`. Chỉ cần đăng nhập.',
  })
  list(): Promise<TransportOrderDto[]> {
    return this.orders.list();
  }

  @Get(':name')
  @ApiOperation({
    summary: 'Chi tiết một lệnh vận chuyển',
    description:
      'Vehicle, trạng thái, đích và các mốc thời gian lấy từ sổ lệnh của WES. Tuyến đường từng chặng và lịch sử ' +
      'của openTCS được ghép thêm khi kernel còn giữ lệnh; kernel tắt hoặc đã dọn lệnh thì các chặng được dựng ' +
      'từ danh sách đích đã lưu. Lệnh không do WES tạo chỉ có khi kernel còn giữ. 404 khi cả hai nơi đều không có.',
  })
  @ApiOkResponse({
    description: 'Cùng hình dạng với transport order của openTCS.',
  })
  get(@Param('name') name: string): Promise<unknown> {
    return this.orders.get(name);
  }
}
