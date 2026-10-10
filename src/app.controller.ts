import { Controller, Get, Header } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  @Header('Content-Type', 'text/html')
  getHome(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>WES FMS</title>
</head>
<body>
  <h2>WES Fleet Management</h2>
</body>
</html>`;
  }
}
