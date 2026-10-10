# Deploy WES (prod, staging, lab)

Mọi môi trường dùng chung một file `compose.deploy.yml`. Mỗi môi trường `<env>` (`prod`, `staging`, `lab`) có ba file:

- `deploy/releases/<env>.env`: tag của các image (`OPENTCS_TAG`, `BE_TAG`, `FE_TAG`, `SIMULATOR_TAG`). Commit vào git; mỗi lần deploy là một commit, nên `git log deploy/releases/<env>.env` là lịch sử version của môi trường đó.
- `deploy/.env.<env>`: secret, port, URL. Chỉ nằm trên máy chạy, không commit (`.gitignore`); repo giữ bản mẫu `deploy/.env.<env>.example`.
- `deploy/opentcs-kernel.<env>.properties`: cấu hình kernel.

Version đi theo thứ tự lab → staging → prod.

| Môi trường | Dùng cho                                | Máy                                      | `COMPOSE_PROJECT_NAME` | Web   | REST kernel | RMI registry / service |
| ---------- | --------------------------------------- | ---------------------------------------- | ---------------------- | ----- | ----------- | ---------------------- |
| `prod`     | Xưởng, xe thật                          | Máy Windows ở xưởng, `10.0.101.51` (LAN) | `wes-prod`             | 18080 | 19200       | 1499 / 59000           |
| `staging`  | Đội test chạy theo chuẩn để lấy dữ liệu | `171.244.54.218`                         | `wes-staging`          | 18080 | 59200       | 1499 / 59000           |
| `lab`      | Đội test chạy case đặc thù              | `171.244.54.218`                         | `wes-lab`              | 18090 | 60200       | 1599 / 60000           |

Compose đặt tên volume theo `COMPOSE_PROJECT_NAME` (`<project>_postgres-data`, ...), nên đổi tên project là ra volume mới rỗng. Muốn đổi tên mà giữ dữ liệu thì `down` project cũ (không `-v`), rồi copy từng volume sang tên mới bằng `docker run --rm -v <cũ>:/from:ro -v <mới>:/to alpine cp -a /from/. /to/` trước khi `up`.

Trên `171.244.54.218` còn project `wes-v2` (bản cũ cho khách hàng khác, web 18081, REST 59201, RMI 1500 / 59001) không quản lý trong repo này. Không dùng tên project hay các port đó cho môi trường mới, và không `down`/`pull` project đó.

`staging` và `lab` dùng chung broker trên server, nên MQTT `clientId` trong properties phải khác nhau (`opentcs-vda5050-<env>`); trùng `clientId` thì broker đá qua đá lại hai kernel.

Các lệnh bên dưới dùng `<env>`; thay bằng môi trường cần thao tác. Mọi lệnh compose phải truyền cả hai env file (`--env-file deploy/.env.<env> --env-file deploy/releases/<env>.env`, cần Docker Compose ≥ 2.17). Thiếu biến bắt buộc thì `docker compose` dừng ngay và báo tên biến. Port RMI trong properties phải trùng với `OPENTCS_RMI_REGISTRY_PORT`/`OPENTCS_RMI_SERVICE_PORT` trong env file, vì RMI stub quảng bá đúng port mà kernel lắng nghe.

Gói này chạy frontend, backend, PostgreSQL và một openTCS kernel trong một Docker Compose project riêng. Kernel dùng broker MQTT có sẵn qua external network `fms_default`; stack WES không tạo, restart hay xóa broker đó. Tên container, network và volume của WES đều được Compose thêm prefix từ `COMPOSE_PROJECT_NAME`, vì vậy có thể chạy cạnh các kernel khác.

Cấu trúc này kế thừa cách tách service và cổng demo của `FMS-SRC`. REST của WES kernel chạy ở `59200` để tránh các kernel trên server đang dùng `55200`, `56200`, `57200` và `58200`. RMI registry dùng `1499`; toàn bộ RMI service dùng chung port `59000`. REST và RMI mặc định chỉ được publish trên loopback.

## Chuẩn bị server

- Linux x86_64 có Docker Engine và Docker Compose v2.
- Đăng nhập Docker Hub bằng tài khoản có quyền pull các image private trong namespace `aubot`.
- Các cổng trong `deploy/.env.<env>` chưa bị tiến trình khác sử dụng.

Server chỉ cần bundle deploy, không cần source của frontend/backend/openTCS:

```text
~/products/wes-fms/
├── compose.deploy.yml
├── database/
│   └── schema.sql
├── downloads/
│   ├── opentcs-wes-clients-dev-20260908-01.zip
│   ├── opentcs-wes-modeleditor-dev-20260908-01.zip
│   └── opentcs-wes-operationsdesk-dev-20260908-01.zip
└── deploy/
    ├── .env.<env>.example
    ├── .env.<env>
    ├── opentcs-kernel.<env>.properties
    └── releases/
        └── <env>.env
```

## Cấu hình

```bash
cd ~/products/wes-fms
cp deploy/.env.<env>.example deploy/.env.<env>
chmod 600 deploy/.env.<env>
```

Sửa tối thiểu các biến sau:

- `COMPOSE_PROJECT_NAME`: duy nhất trên server, chỉ dùng chữ thường, số, dấu `-` hoặc `_`.
- `DOCKERHUB_NAMESPACE`: tài khoản hoặc organization trên Docker Hub.
- `PUBLIC_URL`: URL mà người dùng mở frontend.
- `WES_HTTP_PORT`: cổng web trên server.
- `OPENTCS_HTTP_PORT`: cổng REST debug của kernel, chỉ bind loopback theo mặc định.
- `OPENTCS_RMI_BIND_ADDRESS`: địa chỉ Tailscale của server, hiện là `100.92.46.11`.
- `OPENTCS_RMI_ADVERTISED_HOST`: địa chỉ được ghi vào RMI stub, hiện là `100.92.46.11`.
- `MQTT_NETWORK_NAME`: Docker network đang chứa `mqtt-broker`, hiện là `fms_default`.
- `POSTGRES_PASSWORD` và `JWT_SECRET`: không dùng giá trị mẫu.
- `MQTT_URL`: mặc định `mqtt://mqtt-broker:1883`; backend tham gia external network MQTT để kiểm tra trạng thái broker. Điền `MQTT_USERNAME` và `MQTT_PASSWORD` nếu broker yêu cầu xác thực. Kết nối này chỉ kiểm tra health; kernel và simulator có cấu hình MQTT riêng.

Kiểm tra xung đột cổng trước khi chạy:

```bash
ss -ltn | grep -E ':(1499|18080|59000|59200)\b' || true
```

## Cập nhật `opentcs-kernel.<env>.properties` lên server

File này được bind-mount read-only vào kernel (`./deploy/opentcs-kernel.<env>.properties` → `/opt/opentcs/config/opentcs-kernel.properties`). Kernel chỉ đọc nó lúc khởi động, nên sau khi copy phải recreate service `opentcs` thì cấu hình mới có hiệu lực.

Chạy từ thư mục `wes/` trên máy dev:

```bash
scp deploy/opentcs-kernel.<env>.properties root@171.244.54.218:~/products/wes-fms/deploy/
```

Trên PowerShell, bước 3 phía máy dev dùng `Get-FileHash deploy\opentcs-kernel.<env>.properties -Algorithm MD5` thay cho `md5sum`.

## Build và push image

Tag image có hai loại: `<sha>` (short SHA của commit đã build, không bao giờ đổi) và `latest` (bản build mới nhất, chỉ để thử nhanh). Chỉ deploy bằng `<sha>`. Mỗi repo có SHA riêng, nên ba image thường mang ba tag khác nhau.

Chạy trên máy có đủ ba repository, mỗi repo đã commit sạch:

```bash
docker login
docker compose -f compose.build.yml build
bash scripts/push-images.sh
```

Chỉ build/push một phần: `docker compose -f compose.build.yml build backend` rồi `bash scripts/push-images.sh wes-be`. Script đẩy `latest` và `<sha>`, từ chối repo còn thay đổi chưa commit, và in ra các dòng `*_TAG=<sha>` để dán vào `deploy/releases/<env>.env`.

Frontend image build Vite thành static artifact rồi dùng Nginx để serve; image runtime không chạy Vite dev server.

## Phát hành một version

1. Sửa `deploy/releases/<env>.env`, chỉ đổi dòng của image có thay đổi.
2. Commit, ví dụ `deploy lab: be a1b2c3d`.
3. Copy file lên máy chạy rồi `pull` và `up -d` (mục dưới). Compose chỉ tạo lại container có tag đổi.

Nâng lab lên staging: copy các dòng tag từ `releases/lab.env` sang `releases/staging.env`, commit, deploy staging. Không build lại; staging chạy đúng image đã thử trên lab.

## Khởi động và cập nhật trên server

```bash
docker login
docker compose --env-file deploy/.env.<env> --env-file deploy/releases/<env>.env -f compose.deploy.yml config --quiet
docker compose --env-file deploy/.env.<env> --env-file deploy/releases/<env>.env -f compose.deploy.yml pull
docker compose --env-file deploy/.env.<env> --env-file deploy/releases/<env>.env -f compose.deploy.yml up -d
docker compose --env-file deploy/.env.<env> --env-file deploy/releases/<env>.env -f compose.deploy.yml ps
```

```bash
docker compose --env-file deploy/.env.prod --env-file deploy/releases/prod.env -f compose.deploy.yml config --quiet
docker compose --env-file deploy/.env.staging --env-file deploy/releases/staging.env -f compose.deploy.yml config --quiet
docker compose --env-file deploy/.env.lab --env-file deploy/releases/lab.env -f compose.deploy.yml config --quiet

```

Với database mới, chạy seed đúng một lần sau khi backend healthy:

```bash
docker compose --env-file deploy/.env.<env> --env-file deploy/releases/<env>.env -f compose.deploy.yml \
  exec backend node dist/database/seed.js
```

Seed tạo tài khoản ban đầu `quan.tran` với mật khẩu `Wes@1234`; đổi mật khẩu ngay sau lần đăng nhập đầu tiên. Không chạy seed trong mỗi lần deploy vì script sẽ đặt lại mật khẩu tài khoản này.

Nginx trên host proxy domain WES tới frontend container đang bind loopback:

```nginx
location / {
    proxy_pass http://127.0.0.1:18080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Hai client openTCS được frontend container phục vụ trực tiếp từ bundle. Link sau tải một ZIP chứa cả hai distribution:

```text
http://171.244.54.218/downloads/opentcs-wes-clients-dev-20260908-01.zip
```

Máy khách phải cài Tailscale, tham gia đúng tailnet và kết nối được hai port sau trước khi mở client:

```powershell
Test-NetConnection 100.92.46.11 -Port 1499
Test-NetConnection 100.92.46.11 -Port 59000
```

Hai distribution đã có bookmark `WES Dev|100.92.46.11|1499`.

Xem log:

```bash
docker compose --env-file deploy/.env.<env> --env-file deploy/releases/<env>.env -f compose.deploy.yml logs -f --tail=200
```

Khi phát hành version mới, cập nhật `deploy/releases/<env>.env`, chạy lại `pull` rồi `up -d`. Compose chỉ thay các service thuộc project được chỉ định, không dừng container hoặc kernel của project khác.

## Kiểm tra

```bash
curl -f http://127.0.0.1:18080/
curl -f http://127.0.0.1:59200/v1/kernel/version
docker compose --env-file deploy/.env.<env> --env-file deploy/releases/<env>.env -f compose.deploy.yml ps
```

Không mở PostgreSQL. REST openTCS và frontend mặc định chỉ truy cập được từ chính server; Nginx host là điểm truy cập public. MQTT tiếp tục dùng broker `mqtt-broker` đang publish cổng `1883`.

## Simulator AGV tùy chọn

Simulator dùng profile `simulator`, nên các lệnh deploy thông thường không tự khởi động simulator. Dockerfile nằm ở `deploy/simulator.Dockerfile`; source build nằm ở repository `../AgvSimulator`. Server chỉ cần image, không cần source hay Dockerfile.

Build và push từ thư mục `wes/` trên máy dev:

```bash
docker compose -f compose.build.yml build simulator
bash scripts/push-images.sh wes-simulator
```

Cập nhật `SIMULATOR_TAG` trong release env bằng tag script in ra. Tag hiện tại `96a973b` tương ứng source simulator; image phải được build rồi push hoặc chuyển bằng `docker save`/`docker load` trước khi deploy. Nếu chuyển offline:

```bash
docker tag wes-simulator:latest aubot/wes-simulator:96a973b
docker save -o deploy/wes-simulator-96a973b.tar aubot/wes-simulator:96a973b
# Copy file tar lên server rồi chạy:
docker load -i deploy/wes-simulator-96a973b.tar
```

Thêm vào `deploy/.env.<env>` các biến `SIM_MQTT_HOST=mqtt-broker`, `SIM_MQTT_PORT=1883`, `SIM_MQTT_USERNAME`, `SIM_MQTT_PASSWORD` đúng với broker hiện có. Tạo `SIMULATOR_TOKEN` bằng `openssl rand -hex 32`; cùng token được truyền cho backend và simulator. `SIMULATOR_HTTP_PORT` mặc định 8091, lab dùng 8092 để chạy cạnh staging. Simulator tham gia cả network nội bộ WES và network MQTT đã cấu hình, không tạo hoặc phụ thuộc service broker mới.

Trên server, sau khi copy Compose và release env mới, chạy:

```bash
docker compose --env-file deploy/.env.prod --env-file deploy/releases/prod.env -f compose.deploy.yml --profile simulator config --quiet
# Chỉ dùng pull khi image đã có trên Docker Hub:
docker compose --env-file deploy/.env.prod --env-file deploy/releases/prod.env -f compose.deploy.yml --profile simulator pull simulator
docker compose --env-file deploy/.env.prod --env-file deploy/releases/prod.env -f compose.deploy.yml --profile simulator up -d --no-deps simulator backend
curl -f http://127.0.0.1:8091/health
```

Backend dùng `http://simulator:8091`; API simulator chỉ publish trên loopback host. Volume `simulator-data` giữ trạng thái đội xe qua các lần recreate. `SIM_SEED_DEFAULTS=false` giữ đội xe trống ở lần khởi động đầu tiên; cấu hình này không xóa đội xe đã lưu. Khi dùng chung broker production, tạo xe với định danh riêng, tránh trùng MQTT client ID và topic của xe thật.

## Dừng và rollback

```bash
docker compose --env-file deploy/.env.<env> --env-file deploy/releases/<env>.env -f compose.deploy.yml down
```

Không thêm `-v` khi dừng vì tùy chọn đó xóa dữ liệu PostgreSQL và dữ liệu runtime của kernel. Để rollback, `git revert` commit deploy trong `deploy/releases/<env>.env`, copy file lên máy chạy rồi chạy lại `pull` và `up -d`.
