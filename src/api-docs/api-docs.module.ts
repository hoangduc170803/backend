import { Module } from '@nestjs/common';
import { ApiDocsController } from './api-docs.controller';
import { ApiDocsRegistry } from './api-docs.registry';

@Module({
  controllers: [ApiDocsController],
  providers: [ApiDocsRegistry],
})
export class ApiDocsModule {}
