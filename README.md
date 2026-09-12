# MovieApp backend workspace

Backend workspace hiện có G0 foundation và G1 Auth/Gateway. Bảy service còn lại là skeleton health/readiness; chưa có nghiệp vụ Profile, Catalog, Payment, Streaming, Worker, Notification hay Recommendation. Các giai đoạn tiếp theo nằm trong [`document/todo-prompt-backend.md`](document/todo-prompt-backend.md).

## Yêu cầu và khởi động local

- Node.js `24.21.0` theo `.nvmrc`, npm 10 trở lên.
- Docker Engine và Docker Compose v2 cho profile `core`.

Tạo `.env` từ `.env.example`, cài dependency từ lockfile, sau đó khởi chạy PostgreSQL/Redis/Kafka và bootstrap database/user/topic:

```sh
cp .env.example .env
npm ci
npm run infra:up
npm run dev:keys
npm run migration:run
```

Chạy Auth và Gateway ở hai terminal:

```sh
npm run dev:auth
npm run dev:gateway
```

Auth yêu cầu keypair tại `../.secrets/` và `AUTH_DATABASE_URL`; script `dev:keys` tạo keypair dùng local. Không commit `.env`, `.secrets` hoặc credential. Tài khoản dev admin là tùy chọn: đặt đủ ba biến `SEED_ADMIN_*`; Auth từ chối seed trong production.

`npm run infra:up` dùng Compose profile `core`, chờ healthcheck PostgreSQL/Redis/Kafka rồi chạy bootstrap có thể lặp lại. Các database và role riêng được tạo cho Auth, Profile, Catalog, Streaming, Payment, Worker, Notification và Recommendation. Kafka local là một broker với replication factor 1.

Profile media (OpenSearch, MinIO, media-edge) chỉ bật khi cần:

```sh
npm run infra:media
```

Trên Linux, OpenSearch yêu cầu `vm.max_map_count=262144`; profile media cần thêm khoảng 1 GiB RAM theo heap đã cấu hình. Đây là mức dự toán cho dev, chưa phải benchmark.

Media-edge hiện chỉ có health route; `/media/` cố ý trả 501 cho đến khi G6 bổ sung quyền truy cập manifest/segment. MinIO bootstrap tạo bucket riêng tư. Profile quan sát tùy chọn:

```sh
docker compose --profile observability up --detach --wait
```

Tắt container nhưng giữ volume:

```sh
npm run infra:down
```

## Kiểm tra workspace

```sh
npm run lint
npm run typecheck
npm run build
npm test
```

`npm test` build workspace, chạy unit tests và HTTP smoke end-to-end cho Gateway + bảy service skeleton. Smoke test kiểm tra health/readiness, request ID, error envelope, cấu hình thiếu và Gateway báo not-ready khi Auth không sẵn sàng. Nó không thay thế integration tests với PostgreSQL/Redis/Kafka.

GitHub Actions ở `.github/workflows/ci.yml` chạy clean install, lint, typecheck, build, HTTP smoke và Auth/Gateway smoke; sau đó bật core infrastructure, bootstrap hai lượt, restart và xác nhận dữ liệu PostgreSQL/Redis cùng Kafka topics còn tồn tại. Hiện môi trường phát triển này không truy cập được Docker daemon; xem trạng thái thực tế trong TODO trước khi coi nghiệm thu Compose/CI đã hoàn tất.

## Auth/Gateway boundary

Gateway chỉ proxy các Auth route được khai báo tường minh. Public auth routes có rate limit theo IP; route bảo vệ xác minh RS256, `iss`, `aud` và session active qua Auth. Gateway không expose `/internal/*`; Auth chỉ nhận validate-session từ caller có service credential.

Rate limiter hiện ở bộ nhớ từng Gateway process và dùng peer IP. Trước khi chạy nhiều replica/đặt sau ingress cần rate limit dùng chung hoặc edge policy và cấu hình proxy tin cậy. Môi trường production còn cần TLS, secret management và xác minh lại dependency audit trước khi thêm upload/multipart route.
