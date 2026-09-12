# TODO và prompt triển khai backend — App xem phim

Bản đồng bộ: **2026-09-12 / revision 8**. Checklist chưa tick là việc chưa có bằng chứng nghiệm thu. G0–G4 đã qua nghiệm thu local end-to-end trên Node 24.21.0 và PostgreSQL/Kafka Compose. Workflow GitHub Actions gọi smoke Catalog và Payment; hosted result chỉ được xác nhận sau khi push/trigger CI. Tài liệu tách rõ bằng chứng local khỏi kết quả CI hosted.

Đọc [thiết kế app](thiet-ke-app-xem-phim.md), [thiết kế backend chi tiết](backend-chi-tiet.md), [hợp đồng Payment OpenAPI](payment-openapi.yaml) và [tài liệu tích hợp KKPhim](kkphim-api.md) trước các giai đoạn liên quan. Backend chi tiết là nguồn chuẩn schema/API/event của MovieApp; OpenAPI ghi request/response cho các route đã nghiệm thu; tài liệu KKPhim là tham chiếu endpoint/response của provider; TODO không định nghĩa schema cạnh tranh.

## 1. Cách thực hiện và quy tắc nghiệm thu

- Chỉ triển khai giai đoạn được giao; không tự làm tất cả giai đoạn hoặc tự deploy chỉ vì prompt có mô tả lộ trình.
- Làm trong `Backend/`, giữ `document/`; repository Git root hiện là `Backend/`, nên workflow ở `Backend/.github/workflows/ci.yml`. Không tạo thêm workspace lồng `movie-backend`.
- Đọc AGENTS.md nếu có tại thời điểm triển khai. Nếu repository/thư viện/version thực tế khác thiết kế, ghi quyết định cập nhật vào backend chi tiết và sửa hai tài liệu liên quan.
- SQL/entity theo mô hình chuẩn: movie → playable_items → source_items, content_sources nhiều nguồn; `video_assets` chỉ owned. JSON camelCase, SQL snake_case; nguồn owned/third_party và provider kkphim.
- Mọi giai đoạn có migration/schema phải chạy migration từ DB trống, kiểm tra constraint, seed idempotent nếu có và integration tests với DB thật. Không bật synchronize để thay migration.
- Unit test kiểm tra logic/mapper; integration kiểm tra DB/Redis/Kafka; E2E kiểm tra Gateway và media HTTP. Không dùng unit mock thay bằng chứng giao dịch/unique/concurrency chạy đúng.
- CI dùng KKPhim/payment/notification fixtures; không gọi Internet trong test mặc định. Smoke provider thật sau này phải ghi riêng ngày/endpoint/kết quả, không gọi đó là CI deterministic.
- Báo cáo mỗi giai đoạn: phần đã làm, lệnh kiểm tra và kết quả thực, phần chưa chạy/nguyên nhân, điều chỉnh thiết kế và bước còn lại. Chỉ tick checklist có bằng chứng pass. Giai đoạn sau chỉ bắt đầu khi các phụ thuộc cần thiết đã qua nghiệm thu.

## 2. Thứ tự và phụ thuộc

| ID | Giai đoạn | Phụ thuộc | Mốc dùng được |
|---|---|---|---|
| G0 | Workspace, hạ tầng core, CI và Gateway skeleton | Không | App build, infra health, basic routing |
| G1 | Auth và Gateway auth | G0 | Login/rotation/revoke/admin guard qua Gateway |
| G2 | Profile core | G1 | Tạo/chọn profile an toàn, giới hạn atomic |
| G3 | Catalog hai nguồn và KKPhim metadata | G1, G2 | ID chuẩn, discovery/import/sync, public catalog |
| G4 | Payment mock và entitlement | G1 | Free/subscription quyết định được ở backend |
| G5 | Phiên phát KKPhim và progress | G2, G3, G4 | External HLS, heartbeat, resume, lỗi provider |
| G6 | Upload, Worker và owned HLS | G3, G5 | Phim nội bộ phát thành công end-to-end |
| G7 | Search, history/favorites và Home composition | G2, G3, G5, G6 | Catalog/search/profile thống nhất |
| G8 | Notification và Recommendation | G4, G5, G7 | Mock notification, qualified views/trending |
| G9 | Nghiệm thu tích hợp, lỗi và tải | G6, G7, G8 | Cả hai nguồn hoạt động và phục hồi được |
| G10 | Đóng gói và triển khai staging | G9 | Artifact deploy có kiểm chứng, deployment khi có cấu hình |

Gateway được mở rộng trong từng giai đoạn, không đợi cuối mới nối các service. CI kiểm tra từ G0; G10 chỉ thêm publish/deploy. Profile history phụ thuộc Streaming nên làm ở G7, trong khi Profile ownership đã sẵn sàng từ G2 cho playback.

## G0 — Workspace, hạ tầng core, CI và Gateway skeleton

- [x] Khởi tạo NestJS monorepo ngay tại Backend và chốt version/lockfile.
- [x] Tạo đủ apps/libs theo backend mục 1; ghi rõ phần chưa có business logic.
- [x] Compose file định nghĩa profile core/media/observability với named volumes và healthchecks; YAML đã parse offline.
- [x] PostgreSQL bootstrap tạo/tái sử dụng 8 database/user, chạy lặp trên PostgreSQL 16.15 tạm và PostgreSQL 16.4 Compose.
- [x] Compose core health, Kafka topic bootstrap, Redis/Kafka/PostgreSQL persistence sau restart đã chạy thành công.
- [x] Media profile MinIO health/bucket bootstrap đã chạy và được xác nhận.
- [x] Health/readiness, requestId, shared response/error/config và route skeleton; HTTP smoke cho Gateway + bốn service chưa đến giai đoạn đã pass, Profile được nghiệm thu ở G2, Catalog ở G3 và Payment ở G4 sau khi DB sẵn sàng.
- [x] Tạo CI lint/typecheck/unit/build và core infrastructure acceptance workflow tại Git root `Backend/`.
- [x] CI-equivalent code checks chạy xanh trên Node 24.21.0; core Compose acceptance chạy xanh local.
- [ ] GitHub Actions remote chạy xanh trên Node 24.21.0; chưa trigger vì working tree chưa được push và `gh auth status` báo token không hợp lệ.
- [x] `.gitignore` ở repository root loại dependency/build/runtime files và secrets nhưng giữ `.env.example`.

**Prompt:**

```text
Chỉ thực hiện G0. Đọc các tài liệu dự án và áp dụng workspace/stack tại backend mục 0–1.
Khởi tạo NestJS monorepo trong Backend/, giữ nguyên document/. Tạo skeleton apps:
api-gateway, auth-service, profile-service, catalog-service, payment-service,
streaming-service, transcode-worker, notification-service, recommendation-service.
Tạo shared-dto, shared-auth, shared-config, shared-kafka và content-provider;
chỉ tạo interface/helpers cần nền tảng, business chưa có phải ghi rõ chưa triển khai.

Chốt Node/Nest/TypeORM và phiên bản image tương thích, pin version/digest + lockfile.
Workspace G1 hiện đang pin Node 24.21.0, NestJS 11.2.3, TypeORM 0.3.31,
TypeScript 5.9.3 và PostgreSQL 16.4 cho Auth dev; kiểm tra tương thích khi hoàn thiện G0,
không tự đổi version mà không cập nhật tài liệu liên quan.
Compose core: PostgreSQL, Redis, Kafka KRaft. DB/user riêng cho auth, profile,
catalog, streaming, payment, worker, notification, recommendation.
OpenSearch/MinIO/media-edge và observability thuộc profile bật theo giai đoạn.
Bootstrap databases/topics/buckets qua script/job idempotent; volume bền vững,
healthcheck thật, init thất bại phải có lỗi rõ. Không bắt laptop chạy tất cả service khi chưa cần.

Tạo config validation, error envelope chuẩn, requestId, startup/readiness và Gateway
skeleton chỉ expose health cho phần chưa triển khai. Thiết lập test runner và CI checks.
Không triển khai guard cho phép tất cả rồi coi là auth hoàn chỉnh.
Báo version đã chọn và resource footprint để cập nhật thiết kế nếu cần.
```

**Nghiệm thu:** clean install/build từng app; Compose core sẵn sàng và restart không mất dữ liệu; init chạy lại không tạo trùng; config thiếu báo lỗi; CI chạy được. Chưa cần credential/provider thật.

**Bằng chứng local 2026-09-12:** Trong image `node:24.21.0-bookworm-slim`, `npm ci`, lint, typecheck, build, 4 unit tests và HTTP smoke đều pass (8 service skeleton + thiếu config bắt buộc). Compose Engine 29.8.0/Compose v5.5.1: PostgreSQL 16.4, Redis 7.4.2 và Kafka 4.2.0 healthy; bootstrap G0 ban đầu tạo 8 database/user và 13 Kafka topics, lặp lại trước lẫn sau restart không lỗi. Marker PostgreSQL, Redis AOF và 13 topic đó còn sau khi restart cả 3 container; G4 bổ sung topic `payment.reconciliation_required`, nên bootstrap hiện tại có 14 topic. Profile media (OpenSearch 2.19.1, MinIO và media-edge) và observability (Prometheus, Grafana, Loki) đều healthy; MinIO bootstrap chạy lặp, tạo hai bucket và đặt quyền private. Auth/Gateway migration + E2E pass trên PostgreSQL Compose; sau lượt đầu, migration báo không còn migration chờ và smoke xác nhận uniqueness, password, refresh replay race, device cap, user/admin guards, logout và banned-user revoke. Vì host đang dùng cổng 6379, `.env` local (được `.gitignore` loại trừ) dùng PostgreSQL 15432/Redis 16379; các port nội bộ container giữ nguyên. GitHub Actions workflow chưa chạy trên remote: worktree còn thay đổi chưa push và `gh auth status` báo token không hợp lệ. MinIO bootstrap được sửa sau khi Docker pull `minio/mc` thất bại: custom image dùng client `mc` đi kèm image MinIO server đã pin, với `MC_CONFIG_DIR` writable; build và bootstrap sau sửa đã pass.

## G1 — Auth và Gateway auth

- [x] users/auth_sessions/refresh_tokens migrations và email unique không phân biệt hoa thường.
- [x] Register/login/refresh/logout/JWKS theo hợp đồng chuẩn.
- [x] Password hash, rotation/reuse detection, giới hạn device atomic.
- [x] Service auth và Gateway/service guards, revoke/user status.
- [x] Dev seed admin bằng env, không production seed/không private key ngoài Auth.

**Prompt:**

```text
Chỉ thực hiện G1 sau G0. Dùng schema backend mục 2.1 và HTTP mục 4.
Lưu fullName và role đúng schema; không nhận role từ đăng ký public.
Access JWT RS256 15 phút, refresh 30 ngày; private key đọc secret ổn định,
JWKS có kid và overlap rotation. Refresh transaction one-time-use, reuse thu hồi auth session.
Logout idempotent và kiểm tra banned/revoked cho protected endpoint.
Giới hạn 5 device đăng nhập qua khóa user, phân biệt với concurrent stream của gói.
Không tự sinh private key cho mỗi replica và không seed password mặc định production.

Triển khai /internal/auth/validate-session với service credential và caller allowlist.
Gateway/service verify JWT iss/aud/algorithm/expiry; không tin X-User-Id của client.
JWKS unknown kid refresh có rate limit. Route public match method/path chính xác;
/admin luôn role-guard; /internal không được Gateway expose.
Tests qua Gateway và DB thật cho rotation/unique/concurrent login.
```

**Nghiệm thu:** email trùng khác hoa thường bị từ chối; sai mật khẩu; token expired/revoked/reused; hai request refresh cạnh tranh chỉ một request thành công; login đồng thời không vượt 5 device; role user không gọi Admin; refresh/logout lỗi không lộ secret; signed JWT đúng chữ ký nhưng sai iss/aud bị từ chối.

**Trạng thái hiện tại (2026-09-12):** G1 đã qua E2E với Auth và Gateway chạy thật, kết nối PostgreSQL 16.4 của Compose; lượt đầu thực thi migration, lượt chạy Node 24.21.0 sau đó xác nhận không còn migration pending. `npm run smoke:auth` kiểm tra email uniqueness không phân biệt hoa thường, sai mật khẩu, refresh replay/race, concurrent login device cap, user/admin guards, logout và banned-user revoke. Các kiểm thử G0/G1 đã pass local; kết quả GitHub Actions hosted vẫn chờ xác thực lại `gh` và push commit chứa workflow/source hiện tại.

`npm ci` báo 4 cảnh báo high; `npm audit --omit=dev` trước đó quy chúng về Multer 2.2.0 kéo theo bởi Express adapter. `npm audit fix --force` đề xuất đổi `@nestjs/typeorm` sang 7.1.5, không áp dụng vì phá tương thích major. G1 chưa có multipart route; giải quyết dependency trước khi thêm upload hoặc triển khai production.

## G2 — Profile core

- [x] Migration profiles/profile_quotas/outbox_events và soft delete.
- [x] CRUD, ownership và giới hạn 5 profile atomic.
- [x] Internal validation có service auth, cùng transaction outbox cho `profile.deleted`.
- [x] Gateway routes và contract/E2E tests.

**Prompt:**

```text
Chỉ thực hiện G2 sau G1. Dùng schema backend mục 2.2.
Triển khai CRUD /profiles, PATCH/DELETE theo profileId; userId luôn lấy từ JWT.
Tạo quota row theo user và khóa transaction để concurrent create không vượt 5 profile.
/internal/profiles/validate kiểm tra ownership/active/isKids; service auth bắt buộc.
Soft delete phát profile.deleted trong cùng transaction qua outbox.
Chưa tạo dependency bắt buộc tới Streaming: history/favorites hydration hoàn tất ở G7.
Test ownership mọi path và profile ID do user khác truyền vào, concurrent quota và delete lặp.
```

**Nghiệm thu:** user không xem/sửa/xóa profile khác, deleted profile không validate được; outbox bền vững khi Kafka chưa sẵn sàng. Consumer dọn Streaming/Recommendation được nối ở G5/G8.

**Kết quả local 2026-09-12:** Profile migration được chạy lần đầu trên `profile_db` trống và tạo thành công các bảng/index; những lượt sau `migration:profile:run` báo không còn migration pending. CI-equivalent chạy bằng `node:24.21.0-bookworm`: lint, typecheck, build, 4 unit tests, G0 HTTP smoke, G1 Auth E2E và G2 Profile E2E đều pass. `infra:up` đợi PostgreSQL/Redis/Kafka healthy; `infra:bootstrap` chạy hai lượt và cả 8 DB/user cùng 13 Kafka topic sẵn sàng.

`smoke:profile-ci` xác nhận Auth → Gateway → Profile trên PostgreSQL Compose; 6 yêu cầu tạo đồng thời cho ra đúng 5 thành công và 1 `409`; client giả mạo `x-user-id` không đổi owner; user khác bị `404` khi sửa/xóa/validate profile; internal caller thiếu token bị `401`, caller ngoài allowlist bị `403`; profile kids được phản ánh trong validate; xóa mềm lặp lại vẫn `204`, profile đã xóa không validate và chỉ có một outbox row. Khi broker không sẵn sàng event vẫn nằm trong DB với retry/error; sau restart Profile trỏ về Kafka thật consumer nhận đúng event và outbox chỉ được đánh published sau broker ACK. GitHub Actions hosted vẫn chưa được chạy/push ở phiên này; điều đó không thay đổi kết quả local.

## G3 — Catalog hai nguồn và import KKPhim

- [x] Schema movies/seasons/playable_items/content_sources/source_items và sync_runs.
- [x] Mapping phim lẻ/tập/server, composite constraints, không tạo external video_assets.
- [x] Public catalog từ DB nội bộ; Admin discovery/import/sync với ID ổn định.
- [x] Metadata cache strip URL, metadata-lock, archive và event semantics.
- [x] OpenAPI và fixtures lỗi/mapping, job sync lease/checkpoint.

**Prompt:**

```text
Chỉ thực hiện G3 sau G1/G2. Nguồn chuẩn backend mục 2.3 và mục 3.
Tạo migrations/constraint và service kiểm tra movie-kind/source-item cùng movie.
Movie lẻ có một playableId, series có playableId cho mỗi tập; các server của cùng tập
có sourceItemId riêng. Không tạo bảng episodes cạnh tranh hoặc source đơn trị trên movies.
Owned asset được Streaming tạo ở G6, Catalog chỉ tạo owned source item ở giai đoạn này.

Public catalog/search chỉ dùng dữ liệu đã import, giữ ID, sort/page ổn định.
Trước G7 có thể dùng ILIKE trên title/originTitle làm implementation search tạm,
phải ghi rõ chưa đạt nghiệm thu OpenSearch/tìm kiếm tiếng Việt nâng cao.
Admin routes theo backend mục 4.3, import/sync trả 202 syncRunId và chạy job bền vững.
Implement content-provider client với fixture theo hai loại response legacy/v1;
fetchMetadata loại bỏ link playback trước khi persist/cache, resolver interface tách riêng.
Import nhận movieId tùy chọn để gắn nguồn vào phim có sẵn; route sửa source-item mapping
phải validate cùng movie, giữ playable ID và ghi audit. Catalog có profileId thì bắt buộc
JWT/ownership và kids filter; public không profileId không được lẫn cache đã lọc.

Discovery bounded, refresh imported items theo vòng và checkpoint. Upsert theo external_id,
slug cập nhật được; không tự merge cùng tên và không xóa phim vì thiếu trong trang discovery.
metadata_locked chỉ khóa nội dung biên tập, vẫn cập nhật mapping/availability.
movie.published chỉ phát khi chuyển published, update và archive có topic riêng;
đều qua outbox/version. Import auto-publish metadata hợp lệ, archive thủ công giữ nguyên.
Cron mặc định dev tắt, seed/fixtures đủ movie lẻ/series và cả hai nguồn để không cần Internet.
```

**Nghiệm thu:** unique/source mapping thật ở DB; rating 10.0 hợp lệ; phim hoạt hình không bị ép thành series; tập Full/special không parse sai; hai server cùng tập không trùng history ID; slug đổi giữ UUID; mapping mơ hồ báo conflict; sync lặp không spam movie.published; khóa metadata vẫn refresh nguồn; archive không bị sync mở lại; response public/cache/DB không chứa link phát ngoài. Các item chưa transcode trả khả năng phát chưa sẵn sàng, không seed asset ready giả.

**Kết quả local 2026-09-12:** Migration Catalog chạy trên `catalog_db` PostgreSQL Compose. Trên Node 24.21.0, `npm ci`, lint, typecheck, build và 9 unit tests pass; `smoke:catalog-ci` chạy Auth → Gateway → Profile → Catalog với PostgreSQL/Kafka Compose và KKPhim fixture offline, exit code 0. E2E xác nhận auth/role, import phim lẻ/series và attach vào phim owned, rating 10.0/hoạt hình/Full/special, playable/source-item mapping, same-movie constraints/audit, đổi slug giữ UUID, metadata lock vẫn refresh source availability, archive bền qua refresh, kids ownership/cache, không lưu URL playback trong DB/event/public response, checkpoint bền, expired lease được reclaim và Kafka ACK trước khi đánh published. Smoke live đọc-only qua `npm run smoke:kkphim-live` cũng pass: discovery legacy 24 mục, search v1 parse được 1–20 kết quả theo keyword giữa hai lượt, detail 479 selector và resolver HLS; URL không được in/lưu, không ghi DB. Workflow CI gọi `smoke:catalog-ci`; smoke live chỉ chạy thủ công, không đưa vào CI deterministic. Chưa có kết quả GitHub Actions hosted trong phiên này. Search nội bộ hiện là PostgreSQL `ILIKE`, chưa phải nghiệm thu OpenSearch hoặc tìm kiếm tiếng Việt nâng cao (G7).

## G4 — Payment mock và entitlement

- [x] Migrations plans/subscriptions/payments/requests/receipts/reminders/purchase_guards.
- [x] Snapshot giá/giới hạn và subscription lifecycle.
- [x] HMAC mock webhook, idempotency transaction/CAS/outbox.
- [x] Entitlement nội bộ, free/subscription, cron expiry/reminder dedupe.

**Prompt:**

```text
Chỉ thực hiện G4 sau G1. Theo backend mục 2.5 và 7.1.
MVP payment mock chỉ dev/test, có HMAC secret; verifier không được luôn trả true.
Subscribe nhận planId/paymentMethod + Idempotency-Key; server quyết định amount/currency,
transaction tạo pending order/subscription/snapshot; gọi mock provider bằng orderId idempotent.
Gateway forward raw webhook bytes tới /payments/webhook/:provider để verify signature.

Webhook kiểm tra event/order/provider/amount/currency, khóa payment và state transition,
ghi receipt, cập nhật subscription và outbox cùng transaction; không tính lại endAt khi lặp.
Khóa purchase_guards trước order; unique pending/active subscription theo user.
Hai key khác nhau không tạo hai order đang mở; active hết hạn được đóng trước mua mới.
Pending có expiry và job truy vấn mock provider để đóng hoặc đối soát, không suy failed
từ timeout. Late success order đã đóng ghi reconciliation_required, không cấp gói chồng.
Mua khi đang active/pending khác trả 409; autoRenew=false.
Entitlement trả current limits dựa vào now()/endAt; free không buộc mua gói.
Seed plan demo, giới hạn concurrent stream khác 5 device login của Auth.
Mock config production phải fail startup. Test DB concurrency, không chỉ mock repository.
```

**Nghiệm thu:** hai webhook đồng thời chỉ cấp một subscription/payment.success; chữ ký/tiền/provider/order sai không kích hoạt; webhook failed đến sau paid không hạ trạng thái; retry subscribe cùng key không tạo order mới; hai key cạnh tranh không tạo hai pending; pending bỏ dở được đối soát và late success không bị mất; plan đổi không sửa snapshot cũ; expired bị từ chối dù cron chưa chạy; reminder không phát mỗi ngày cho cùng lần hết hạn.

**Kết quả local 2026-09-12:** Migration Payment đã chạy trên `payment_db` PostgreSQL Compose và trên database tạm hoàn toàn mới do E2E tạo rồi xóa; kiểm tra đủ 9 bảng G4, seed demo và CHECK constraint giá. Node 24.21.0 `npm run smoke:payment-ci` exit code 0: cấu hình mock bị từ chối khi production, Auth/Gateway/Payment readiness, plan và giá server-side, retry/idempotency và open-order guard, raw-body HMAC với payload whitespace-preserving, signature/order/amount/provider lỗi, webhook đồng thời và receipt dedupe, một lần kích hoạt/outbox Kafka ACK, failed-after-paid, snapshot bất biến và `autoRenew=false`, internal Streaming-only entitlement/free limits, hết hạn theo `endAt` trước cron, reminder dedupe, cho mua lại sau khi subscription hết hạn, pending timeout không tự thành failed, provider-confirmed failure, late success vào `reconciliation_required` không cấp entitlement, hai idempotency key cạnh tranh chỉ có một order. Local E2E đã chạy trên PostgreSQL/Kafka Compose; hosted GitHub Actions chưa được trigger trong phiên này.

## G5 — Phiên phát KKPhim và progress

- [ ] Session request/idempotency, atomic Redis lease/quota.
- [ ] POST playback-sessions + heartbeat/progress/events, contract camelCase.
- [ ] Fresh HLS resolver, không cache/persist URL và không tạo external asset.
- [ ] Progress PostgreSQL write-through, seq/session ordering.
- [ ] Source recovery/circuit breaker và profile deletion consumer.

**Prompt:**

```text
Chỉ thực hiện G5 sau G2/G3/G4. Theo backend mục 2.4 và mục 5.
Implement POST /streaming/playback-sessions, body movieId/playableId/sourceItemId/profileId,
Idempotency-Key và response chuẩn. Từ chối ID không cùng movie, profile khác user,
archived/kids không phù hợp và subscription không hợp lệ. Free vẫn phát được sau login.
Service auth cho các cuộc gọi Auth/Profile/Catalog/Payment; Gateway không tạo user claims giả.

Reserve slot Redis atomic per user, TTL 90s, heartbeat 30s; session DB + request idempotency,
resolve lỗi release slot; process chết TTL/reconcile xử lý. Hai request cùng key không ăn hai slot.
Retry key cũ của session terminal/hết lease trả 409; dùng key mới để mở lại.
Resolver KKPhim fetch fresh detail, match đúng selectors, giới hạn budget/concurrency,
HTTPS/domain validation; không dùng metadata cache làm URL playback cache.
Source error có retryAfter/half-open để phục hồi; embed-only trả lỗi mode unsupported.
Owned resolver ở đây trả VIDEO_NOT_READY cho asset thiếu, phần thành công làm ở G6.

Progress seq, session ordinal do server cấp; commit PostgreSQL trước ACK rồi cache.
Tua về trước hợp lệ, request cũ/reordered không ghi đè progress mới; duration có thể null.
Event idempotent, qualified view một lần/session, outbox playback.qualified cho G8.
Dọn/đóng session khi profile.deleted; endpoint của session luôn verify user/profile binding.
```

**Nghiệm thu:** local provider fixture thay URL giữa hai lần tạo phiên, backend lấy URL mới; `video_assets` không có dữ liệu KKPhim; concurrency race không vượt quota; user khác không gửi progress/heartbeat; app mất mạng hết lease; tua lại/sai thứ tự/session mới không mất progress; Redis cache hỏng vẫn đọc DB nhưng Redis lease hỏng chặn tạo phiên mới; provider phục hồi sau 503 được thử lại; failed resolve không rò slot. Test HTTP media fixture riêng, không chỉ kiểm tra chuỗi URL trong response.

## G6 — Upload, transcode và phát owned HLS

- [ ] Initiate upload → presigned PUT → verified complete → outbox video.uploaded.
- [ ] Durable worker job, lease/retry/generation/DLQ và cleanup.
- [ ] FFmpeg HLS nhiều rendition phù hợp input, manifest hoàn chỉnh.
- [ ] Owned resolver/media-edge bảo vệ master lẫn variant/segment; credential renew.
- [ ] Catalog readiness projection và flow phim nội bộ thực sự phát được.

**Prompt:**

```text
Chỉ thực hiện G6 sau G3/G5. Theo backend mục 5.3 và 6.
/admin/videos/uploads tạo asset upload_pending liên kết owned sourceItemId.
Client PUT file trực tiếp MinIO; upload-complete HEAD/checksum/size/expiry đúng raw key do
server cấp, CAS queued + outbox. Không publish event chỉ vì đã cấp URL upload.

Worker nhận video.uploaded, persist job unique asset/generation trước offset commit,
claim lease rồi chạy FFmpeg ngoài Kafka poll loop. Dùng child_process.spawn argument array,
ffprobe, resource timeout, temp dir theo job, không upscaling, H.264/AAC và keyframe aligned.
Upload segment/variant trước master vào processed bucket prefix generation.
Retry lưu DB, outbox kết quả; processing/ready/failed có consumers đúng owner/version.
Late completion generation cũ không ghi đè asset mới, complete/retry request idempotent.
Reclaim cùng generation có attempt token/output prefix riêng, worker cũ không commit được.
Processing event đến muộn không hạ ready; worker verify checksum raw sau download.

Triển khai dev media-edge có credential verification, private origin, scope bao toàn bộ
file HLS của asset/generation; Android contract mediaAuth và endpoint media-auth renew.
Không coi query JWT là bảo vệ nếu edge không verify. Không để master/segment/origin public.
MVP chưa DRM, không cần cloud account thật. Tạo một clip test nhỏ bằng FFmpeg local.
```

**Nghiệm thu:** Gateway Admin đúng role; missing file/wrong size/expiry bị từ chối; complete lặp không hai job; worker chết/restart không mất job; retry hết thành failed; master/variant/segment fetch được với credential và media decode/ffprobe được; thiếu/hết hạn cookie hoặc truy cập origin bị chặn; renewal phiên active hoạt động; generation cũ không override ready mới. Kiểm thử cả phim lẻ và ít nhất một tập series.

## G7 — Search, favorites/history và Home composition

- [ ] OpenSearch projection, analyzer tiếng Việt, reindex/update/archive version.
- [ ] Favorites idempotent và history hydration/tombstone.
- [ ] Personalized Home tại Gateway, không cache lẫn profile.
- [ ] Route/authorization matrix đầy đủ, role reports tách đúng service.

**Prompt:**

```text
Chỉ thực hiện G7 sau G2/G3/G5/G6. Theo backend mục 3–4 và app mục 4.
Thay search tạm bằng OpenSearch trên catalog đã import, filter/sort/pagination chuẩn.
Consumer movie.published/updated/archived qua inbox/version; reindex từ Catalog API/DB của chính
Catalog. Recheck publication/kids trước trả kết quả để stale index không lộ archived.

Hoàn thiện PUT/DELETE favorites và watch-history Profile gọi Streaming/Catalog nội bộ,
không join DB khác. GET /home personalized ở Gateway nhận profileId đã verify ownership,
compose catalog/progress; recommendation chưa có thì fallback có nhãn rõ.
GET /catalog/home public không đọc profileId hoặc chứa lịch sử cá nhân.
Route /admin/videos tới Streaming, /admin/movies và /admin/providers tới Catalog,
bao gồm /admin/content-sources và /admin/source-items tới Catalog,
reports tới owner theo bảng. Method/path public allowlist, raw webhook forwarding và rate-limit
phân lớp auth/catalog/progress; không expose internal qua Gateway.
```

**Nghiệm thu:** query tiếng Việt có/không dấu theo fixture; stable pagination, archive reindex và out-of-order event; favorite cùng movie nhiều nguồn chỉ một lần; không trả profile A cho user B; history archived có tombstone; lỗi recommendation không làm Home lỗi; public catalog không có raw stream URLs hay user progress.

## G8 — Notification, Recommendation và telemetry

- [ ] Delivery outbox/inbox/idempotency, mock email/push.
- [ ] Qualified views riêng progress; window trending 7 ngày.
- [ ] HTTP nội bộ recommendations/trending và Gateway composition.
- [ ] Consumer retry/DLQ và profile deletion cleanup.

**Prompt:**

```text
Chỉ thực hiện G8 sau G4/G5/G7. Theo backend mục 2.6 và 7.2.
Notification subscribe movie.published/payment.success/subscription.expiring/video.transcode_failed;
recipient policy rõ theo loại event, delivery unique event/recipient/channel, mock log đã redact.
Không broadcast mỗi lần metadata update. Retry/DLQ có replay không tạo delivery trùng ở DB;
provider gửi thật sau này cần idempotency hoặc xử lý delivery-unknown riêng.

Recommendation consume playback.qualified, unique session/event, không đếm progress làm view.
Trending distinct qualified session trong 7 ngày; gợi ý cùng thể loại chưa xem, fallback trending
hoặc newReleases. Có HTTP internal recommendations và trending, chỉ caller được phép.
Hydrate/filter published/kids qua Catalog và gắn section vào /home; không tự mở public API mới.
profile.deleted dọn dữ liệu liên quan. Không gắn userId/movieId vào metrics labels.
```

**Nghiệm thu:** event replay/consumer restart không nhân bản dữ liệu; một session gửi nhiều progress vẫn một view; event quá 7 ngày không tính trending; phim archived/kids không phù hợp không được gợi ý; notification lỗi retry/DLQ nhìn thấy được, không cản payment/catalog.

## G9 — Nghiệm thu hệ thống trước deploy

- [ ] E2E qua Gateway cho owned và third_party, movie lẻ và series.
- [ ] Negative authorization/SSRF/URL credential leakage, webhook concurrency.
- [ ] Restart/replay/out-of-order và dependency failure/recovery.
- [ ] Đo tải theo mục tiêu backend mục 8, ghi cấu hình máy/kết quả.
- [ ] So khớp OpenAPI MovieApp thực tế với thiết kế app/backend/TODO; kiểm tra adapter KKPhim với fixture và cập nhật khác biệt vào tài liệu tích hợp provider.

**Prompt:**

```text
Chỉ thực hiện G9 sau G6/G7/G8. Không deploy ở giai đoạn này.
Chạy stack bằng Compose với fixture provider HTTP local cho cả metadata và file HLS;
payment mock ký HMAC, clip owned tạo local, không gọi Internet trong CI.

A. Register/login -> create profile -> create owned movie/playable/source item -> upload PUT ->
complete -> poll status bounded -> ready -> publish -> tạo session -> GET master, variant,
segment và kiểm tra media hợp lệ -> progress -> stopped -> resume session mới đúng vị trí.
B. Import KKPhim fixture movie/series -> canonical IDs -> create session -> fetch external
fixture HLS -> progress/favorites/history; không có external video_assets. Thay URL/server,
re-sync và re-resolve; metadata-lock không làm link cũ, giữ playable ID.
C. Free phát không cần thanh toán; nội dung subscription bị từ chối trước payment, webhook
hợp lệ kích hoạt mới phát được. Paid expired dù cron chưa chạy vẫn bị từ chối.
D. Race webhook/login/profile quota/playback quota, replay Kafka, out-of-order progress/source
version; worker crash/retry/generation cũ; missing completion; provider outage rồi recovery.
E. User khác/role sai/internal route bị chặn; không forward backend bearer tới media;
URL redirect/private IP/host sai bị từ chối ở backend/media client tương ứng;
owned segment/origin không bypass được bằng URL đoán. API no-store và log redact.

Đo p95 cached catalog và progress write load, report resource footprint, Kafka/outbox lag,
startup/buffering riêng với local fixtures. Không suy ra SLA provider từ test local.
Lệnh test:e2e phải có timeout/poll bounded, cleanup và report từng scenario.
```

**Nghiệm thu:** cả happy path thật và negative/failure cases pass; không xem việc chỉ trả VIDEO_NOT_READY hoặc URL string đúng là đủ. Android Media3 device test thực tế được ghi là công việc kiểm thử client riêng khi có app; chưa có app thì không báo đã xác nhận player Android.

## G10 — Đóng gói và triển khai staging

- [ ] Docker multi-stage cho từng app, worker có FFmpeg, media-edge có config.
- [ ] CI dependency-aware cho app/shared lib/root config/lockfile.
- [ ] Migration job, secret isolation, smoke/rollback và restore rehearsal.
- [ ] Deploy staging khi có cấu hình đích; ghi rõ phần chưa thực hiện.

**Prompt:**

```text
Chỉ thực hiện G10 sau G9. Theo backend mục 8.
Build container immutable SHA, healthcheck/resource defaults và đúng dist entrypoint từng Nest app.
CI PR chỉ checks; main/tag trusted mới publish image. App/lib/lockfile/root config đổi phải chạy
checks cho mọi app bị ảnh hưởng; nếu chưa tính dependency graph thì build/test toàn workspace.
Auth private key chỉ vào Auth, Streaming/Worker không nhận key này. Không để mock payment
vào production. Migration từng DB chạy một lần trước rollout, không per replica startup.

Chuẩn bị Compose staging + env template không secrets, smoke health/catalog/playback,
rollback app tương thích schema, DB/object storage backup và diễn tập restore.
Registry/hostname/CDN/storage/secret target chưa có thì báo cụ thể và chỉ tạo artifact cấu hình,
không bịa endpoint đã hoạt động. Không tự thay bằng Kubernetes bắt buộc.
Khi môi trường thật được cung cấp và giao triển khai, deploy staging + smoke và báo kết quả thực.
```

**Nghiệm thu:** image chạy đúng service/user/process; shared lib change kích hoạt checks; secrets không ở image/log; migration/restart tương thích; smoke và restore được ghi bằng chứng. Chưa có registry/host thì checklist deploy vẫn chưa tick dù build artifacts đã xong.

## 3. Sau MVP — việc cần thiết cho sản phẩm đầy đủ

Các nhóm mở rộng cần đặc tả bổ sung trước khi code, không nằm ngầm trong checklist core:

- **E1 — Tài khoản và liên lạc thật:** xác minh email, reset password, OAuth account linking (email/password vẫn đăng nhập được), notification preferences/token lifecycle, FCM/email thật, rate-limit/monitoring vận hành. Hoàn tất account recovery/verification trước mở đăng ký production rộng rãi.
- **E2 — Payment thật:** chọn kênh bán gói trên Android/web và provider cụ thể; verify signature theo provider, reconcile giao dịch, refund, đổi gói, tái thanh toán và auto-renew state machine; mock không chứng minh tích hợp thật.
- **E3 — Media nâng cao:** multipart upload, subtitles/audio tracks, enforcement maxResolution nội bộ, thu hồi session tại edge tức thời nếu cần, DRM/key-server/Widevine, DASH, offline nội bộ (download quota/expiry/sync), đánh giá WebView embed riêng. Không tự bật tính năng mà response provider chưa mô tả.
- **E4 — Quy mô/vận hành:** Kubernetes/HPA/KEDA khi benchmark yêu cầu, distributed tracing, backup retention/restore, multi-CDN, tuning PostgreSQL/progress. Nếu chuyển progress sang write-behind phải đặc tả crash recovery/durability trước khi thay ACK semantics.

## 4. Các thay đổi so với TODO ban đầu

- Đưa Gateway/CI sớm, Profile trước Streaming; history composition làm sau khi có Streaming.
- Giữ mô hình nhiều source và ID playable thống nhất, bỏ schema nguồn đơn trị/asset ngoài trong prompt.
- Bỏ cache URL playback và GET tạo session; dùng POST/session/idempotency cùng hợp đồng backend.
- Thêm upload-complete, job bền vững, kiểm tra segment thật và bảo vệ origin.
- Thêm transaction/outbox/inbox/version cho webhook, sync và consumer; không dùng mock verify luôn true.
- Tách qualified view khỏi progress, tách mock khỏi sản phẩm tích hợp thật.
- E2E/failure checks trước deployment; TODO không đánh dấu thiết kế là code đã chạy.
