# Thiết kế backend chi tiết — App xem phim

Bản đồng bộ: **2026-09-12 / revision 5**. Đây là đặc tả thiết kế; trạng thái triển khai từng giai đoạn được ghi riêng tại mục 8.2–8.5. Phạm vi không bao gồm kiểm tra bản quyền nguồn bên thứ ba.

## 0. Quy ước và quyết định nền

- [Thiết kế app](thiet-ke-app-xem-phim.md) xác định sản phẩm, trải nghiệm Android và phạm vi MVP.
- **Tài liệu này là nguồn chuẩn** cho domain, dữ liệu, API, sự kiện và hành vi lỗi.
- [TODO và prompt](todo-prompt-backend.md) xác định thứ tự triển khai, phụ thuộc và nghiệm thu. Không sao chép schema riêng vào prompt.
- Thư mục thực tế là `Backend/` (phân biệt hoa/thường trên Linux). Khởi tạo workspace ngay tại đó, giữ `document/`, không tạo thêm `Backend/movie-backend/`.
- Chọn NestJS monorepo gồm các service triển khai độc lập. Đây là lựa chọn phục vụ kiến trúc dự án; microservices có chi phí vận hành, không mặc định nhanh hơn monolith. MVP dùng Docker Compose, chưa yêu cầu Kubernetes.
- SQL dùng `snake_case`; JSON/query HTTP dùng `camelCase`; ID nội bộ UUID, thời gian UTC ISO-8601. Các giá trị enum dưới đây là chuẩn dự án; tài liệu API provider chỉ mô tả trường nguồn.
- `sourceType = owned | third_party`; `provider = kkphim` chỉ áp dụng nguồn ngoài. Không thêm trường nguồn đơn trị vào `movies`: một phim có thể có nhiều nguồn.
- `playableId` định danh một phim lẻ đầy đủ hoặc một tập phim; `sourceItemId` định danh một lựa chọn phát cụ thể (ví dụ tập 2, server Vietsub). Lịch sử và favorites dùng ID nội bộ, không dùng slug/URL bên thứ ba làm khóa.
- MVP: email/password, profile, catalog hợp nhất, KKPhim HLS, upload/transcode HLS nội bộ, progress, favorites, gói cước mock, notification mock và gợi ý đơn giản. OAuth, thanh toán thật/gia hạn tự động, DRM, offline nội bộ, WebView embed và Kubernetes là phần sau MVP.

## 1. Tech stack và cấu trúc workspace

| Thành phần | Lựa chọn thống nhất |
|---|---|
| Backend | Node.js 24.21.0, NestJS 11.2.3 + TypeScript 5.9.3 |
| ORM | TypeORM 0.3.31 + migration theo database; `synchronize=false` ở mọi môi trường dùng chung |
| Đồng bộ | HTTP REST/JSON qua Gateway; HTTP REST nội bộ có xác thực service |
| Giao nhận event | At-least-once; outbox/inbox và consumer idempotent |
| Dữ liệu | PostgreSQL 16.4 image cho Compose dev; database/user riêng cho từng service |
| Cache/lease | Redis 7.4.2 image; MVP không dùng Redis làm nơi duy nhất lưu tiến độ đã xác nhận thành công |
| Sự kiện | Apache Kafka 4.2.0, KRaft, một broker cho dev, replication factor 1 |
| Search | OpenSearch 2.19.1 dev, index từ catalog nội bộ đã chuẩn hóa |
| Storage/media | MinIO RELEASE.2025-06-13T11-33-47Z; Nginx 1.27.4 media-edge; FFmpeg worker; adapter CDN cho triển khai thật |
| Giám sát | Prometheus 3.2.1, Grafana 11.5.1, Loki 3.4.2; profile bật riêng |
| Vận hành | Docker Compose; GitHub Actions; structured logs |

Các phiên bản trên đã được pin trong manifest/Compose, không dùng tag `latest`. Kafka heap và OpenSearch heap đều giới hạn 512 MiB; profile core cần khoảng 1–2 GiB khi nhàn rỗi, media thêm khoảng 1 GiB, observability thêm khoảng 0.5–1 GiB. Đây là dự toán từ cấu hình, chưa phải số đo benchmark; để bật OpenSearch cần `vm.max_map_count=262144` trên host Linux. Image single-node, Kafka replication factor 1 và credentials ví dụ chỉ dành cho máy phát triển/CI, không phải cấu hình HA/production. Compose profile `core` chạy PostgreSQL, Redis, Kafka; `media` bổ sung OpenSearch, MinIO, media-edge; `observability` bổ sung Prometheus, Grafana, Loki.

Workspace dùng `package-lock.json`; `.nvmrc` chọn Node 24.21.0. CI phải dùng đúng phiên bản này. Các service business được triển khai theo từng giai đoạn; G3 bổ sung Catalog và content-provider KKPhim có fixture offline, còn luồng playback được giữ tách biệt cho G5.

```text
Backend/                                  # Git repository root
├── .github/workflows/ci.yml
├── document/                             # Tài liệu dự án và tham chiếu provider
├── apps/
│   ├── api-gateway/
│   ├── auth-service/
│   ├── profile-service/
│   ├── catalog-service/
│   ├── payment-service/
│   ├── streaming-service/
│   ├── transcode-worker/
│   ├── notification-service/
│   └── recommendation-service/
├── libs/
│   ├── shared-dto/
│   ├── shared-auth/
│   ├── shared-config/
│   ├── shared-kafka/                     # Envelope, outbox/inbox helpers
│   └── content-provider/                 # KKPhim metadata client + playback resolver interface
├── docker/                               # media-edge, Dockerfiles, observability config
├── docker-compose.yml
└── package.json
```

CMS là client quản trị riêng ở giai đoạn sau; backend MVP cung cấp Admin API và tài liệu OpenAPI để thao tác. Recommendation có consumer **và HTTP nội bộ**; worker/notification chỉ cần health/metrics, không có API công khai nghiệp vụ.

## 2. Ranh giới dữ liệu và schema chuẩn

Mỗi service dùng database/user DB riêng; dev có thể dùng chung một PostgreSQL instance. Không join hoặc tạo FK xuyên database. UUID tham chiếu domain khác phải được kiểm tra bằng API nội bộ, không bằng truy cập DB của service khác. Archive/soft delete catalog để giữ ID lịch sử; xóa profile phát sự kiện dọn dữ liệu liên quan.

Các bảng dưới đây là hợp đồng dữ liệu tối thiểu. Khi triển khai phải tạo migration, index FK hay dùng, NOT NULL/CHECK/UNIQUE và test constraint; không xem một danh sách tên cột là migration hoàn chỉnh.

### 2.1. Auth — `auth_db`

| Bảng | Cột và ràng buộc |
|---|---|
| `users` | `id UUID PK`, `email TEXT NOT NULL`, `full_name TEXT NOT NULL`, `password_hash TEXT NOT NULL` trong MVP, `role=user\|admin\|content_manager DEFAULT user`, `status=active\|banned\|deleted`, `created_at`, `updated_at`; unique index trên `lower(email)` |
| `auth_sessions` | `id UUID PK`, `user_id FK users NOT NULL`, `device_id TEXT NOT NULL`, `device_name`, `expires_at`, `revoked_at`, `created_at`; một phiên đang hiệu lực cho mỗi cặp user/device do transaction khóa user bảo đảm |
| `refresh_tokens` | `id UUID PK`, `session_id FK auth_sessions NOT NULL`, `token_hash TEXT UNIQUE NOT NULL`, `expires_at`, `used_at`, `revoked_at`, `replaced_by UUID NULL FK refresh_tokens`, `created_at` |

- Đăng ký nhận `{email,password,fullName}`, không nhận role. Argon2id cho password; refresh token ngẫu nhiên entropy cao, DB chỉ lưu SHA-256 hash.
- Access JWT RS256 sống 15 phút: `sub`, `sid`, `role`, `iss`, `aud`, `iat`, `exp`, `kid` ở header. Private key chỉ ở Auth; không tự sinh cặp khóa mới mỗi lần pod khởi động. JWKS công bố public key, giữ khóa cũ đủ thời gian token đang sống khi rotation.
- Refresh token sống tối đa 30 ngày và rotation mỗi lần refresh trong transaction. Dùng lại token đã consumed thu hồi toàn bộ auth session. Android single-flight refresh; nếu mất response sau rotation, yêu cầu đăng nhập lại thay vì retry mù token cũ. Không ghi password/token vào log.
- Giới hạn **5 thiết bị đăng nhập**, tách khỏi số luồng đang phát của gói cước. Khóa hàng user khi tạo session để tránh vượt giới hạn do login đồng thời; revoke session cũ nhất nếu vượt.
- Logout thu hồi session và chuỗi refresh. Gateway/service kiểm tra session revoke/user status cho endpoint được bảo vệ qua Auth nội bộ; không xem chữ ký JWT là đủ để user bị ban tiếp tục mở phiên phát. JWKS cache 10 phút, unknown `kid` refresh có giới hạn tần suất.
- Admin dev seed idempotent, credential từ biến môi trường dev; production không seed tài khoản mặc định. Schema OAuth/phone bổ sung khi làm giai đoạn mở rộng, tránh trường chưa dùng và account-linking nửa vời.
- Auth implementation hiện dùng Argon2id, unique index `lower(email)`, row lock trên user khi cấp device session và session/token lock khi rotate refresh. Dev seed không đổi quyền user có sẵn; production fail startup nếu seed env được đặt.
- Gateway chỉ public hóa method/path đăng nhập đã khai báo; register/login/refresh có rate limit IP per-process cho giai đoạn một replica/dev. Trước scale nhiều replica cần rate limit dùng chung/edge. Route protected xác minh signature RS256 + `iss`/`aud` rồi gọi `/internal/auth/validate-session`; Auth lỗi thì fail closed. Gateway không proxy `/internal/*`.
- JWKS có `kid`; hỗ trợ khai báo public key cũ qua `AUTH_JWKS_PREVIOUS_PUBLIC_KEYS_JSON` để overlap rotation. Không đưa private key ra khỏi Auth. `/auth/session` trả session đã được Auth xác nhận; `/admin/session` dùng để kiểm tra role boundary.

### 2.2. Profile — `profile_db`

- `profiles(id UUID PK, user_id UUID NOT NULL, name TEXT NOT NULL, avatar_id SMALLINT NULL, is_kids BOOLEAN DEFAULT false, deleted_at NULL, created_at, updated_at)`.
- `profile_quotas(user_id UUID PK)`: khóa hàng này khi tạo profile để giới hạn 5 profile active/user một cách atomic; tạo hàng bằng upsert trước khi khóa.
- `favorites(profile_id UUID FK profiles, movie_id UUID, added_at)` với PK `(profile_id,movie_id)`. PUT thao tác thêm là idempotent.
- Mọi API profile kiểm tra user ownership; service nội bộ validate profile cũng trả trạng thái active/isKids. Xóa mềm profile làm playback/heartbeat mới bị từ chối; phát `profile.deleted` để dọn progress/session/favorites/recommendation theo retention.
- Migration Profile tạo `profiles`, `profile_quotas` và `outbox_events`; tên profile sau trim dài 1–80 ký tự, `avatar_id` null hoặc không âm. Quota row được upsert rồi khóa `FOR UPDATE` trước khi đếm profile active.
- Event `profile.deleted` được ghi cùng transaction với `deleted_at`; unique `(aggregate_id,event_type)` ngăn tạo event xóa lặp. Envelope lưu `eventId/eventType/schemaVersion/aggregateId/aggregateVersion/occurredAt/producer/correlationId/payload`; publisher lease bằng `SKIP LOCKED`, retry có backoff và chỉ đánh published sau Kafka ACK. Delivery là at-least-once nên consumer vẫn phải dedupe theo eventId.
- User routes chỉ nhận qua Gateway: Gateway xác thực JWT và session với Auth, bỏ qua `x-user-id` client gửi, rồi chuyển `userId` từ session đã xác minh kèm service token. Profile chỉ chấp nhận Gateway cho CRUD; `/internal/profiles/validate` bắt buộc service token và allowlist Gateway/Streaming/Catalog. `PROFILE_SERVICE_URL`, `PROFILE_DATABASE_URL`, `PROFILE_KAFKA_BROKERS` và `PROFILE_INTERNAL_TOKENS_JSON` là cấu hình cần có khi chạy Profile.
- `watch_progress` thuộc Streaming; Profile lấy lịch sử qua API nội bộ rồi hydrate metadata Catalog. Phim archived trả tombstone (ID/tên tối thiểu, unavailable), không làm mất toàn bộ lịch sử.

### 2.3. Catalog — `catalog_db`

| Bảng | Cột và ý nghĩa |
|---|---|
| `movies` | `id UUID PK`, `title`, `origin_title`, `description`, `poster_url`, `backdrop_url`, `release_year`, `type=movie\|series`, `content_kind=film\|animation\|show`, `status=draft\|published\|archived`, `access_tier=free\|subscription DEFAULT free`, `is_kids_safe BOOLEAN DEFAULT false`, `average_rating NUMERIC(3,1) CHECK 0..10`, `published_at`, `created_at`, `updated_at`, `version BIGINT DEFAULT 1` |
| `genres`, `countries` | `id UUID PK`, `slug UNIQUE`, `name`; bảng nối `movie_genres`, `movie_countries` dùng PK kép/FK trong Catalog |
| `seasons` | `id UUID PK`, `movie_id FK movies NOT NULL`, `season_number INT CHECK >0`, `is_synthetic BOOLEAN DEFAULT false`; UNIQUE `(movie_id,season_number)`, UNIQUE `(id,movie_id)` |
| `playable_items` | `id UUID PK`, `movie_id FK movies NOT NULL`, `kind=movie\|episode`, `season_id NULL`, `episode_number INT NULL CHECK >0`, `label TEXT NOT NULL`, `sort_order INT NOT NULL`, `duration_seconds INT NULL CHECK >0`, `archived_at NULL`; UNIQUE `(id,movie_id)` |
| `content_sources` | `id UUID PK`, `movie_id FK movies NOT NULL`, `source_type=owned\|third_party`, `provider NULL hoặc kkphim`, `external_id TEXT NULL`, `external_slug TEXT NULL`, `external_updated_at NULL`, `metadata_locked BOOLEAN DEFAULT false`, `source_status=unknown\|available\|unavailable\|error`, `metadata_checked_at NULL`, `version BIGINT DEFAULT 1`; UNIQUE `(provider,external_id)`, UNIQUE `(provider,external_slug)`, UNIQUE `(id,movie_id)` |
| `source_items` | `id UUID PK`, `movie_id`, `source_id`, `playable_id`, `server_key TEXT NOT NULL`, `server_label TEXT NOT NULL`, `external_episode_key TEXT NULL`, `external_episode_slug TEXT NULL`, `playback_mode=owned_hls\|external_hls\|external_embed\|metadata_only`, `source_status`, `last_resolved_at NULL`, `retry_after NULL`, `version BIGINT DEFAULT 1`; FK kép tới source/playable cùng movie |
| `sync_runs` | `id UUID PK`, `provider`, `mode=discovery\|refresh\|import`, `status=queued\|running\|completed\|partial\|failed`, `checkpoint JSONB`, `created_count`, `updated_count`, `error_count`, `started_at`, `finished_at`, `lease_until`; chi tiết lỗi không chứa URL stream/token |

Ràng buộc cần hiện thực:

- Một phim lẻ có đúng một `playable_items.kind=movie`; unique partial index trên `movie_id WHERE kind='movie'`. Phim bộ dùng `kind=episode`; FK `(season_id,movie_id)` tới `seasons(id,movie_id)`. CHECK phim lẻ có `season_id`/`episode_number` NULL; tập phải có season. Kiểm tra kind khớp `movies.type` trong transaction Catalog (CHECK không đọc bảng khác).
- Unique chỉ bảo đảm tối đa một playable phim lẻ; transaction publish/import kiểm tra có đủ playable/source item. Draft có thể chưa đủ dữ liệu. `source_items.source_status` dùng cùng enum unknown/available/unavailable/error; retry_after thuộc từng item, trạng thái content source là tổng hợp, không khóa mọi server vì một server lỗi.
- Tập có số rõ ràng: unique partial index `(season_id,episode_number) WHERE episode_number IS NOT NULL`. Tập đặc biệt không ép tên thành số; giữ `label`, `sort_order` và mapping ổn định. Không tạo bảng `episodes` thứ hai: tập phim được lưu trong `playable_items`.
- `source_items` có FK `(source_id,movie_id)` và `(playable_id,movie_id)` để ngăn gắn nguồn của phim A vào phim B. UNIQUE `(source_id,playable_id,server_key)`; owned dùng server_key cố định `owned`, thêm content source khi cần bản khác. External thêm UNIQUE `(source_id,server_key,external_episode_key)`; các selector ngoài bắt buộc non-null. Service kiểm tra playback mode/server key khớp source type trong transaction; không đặt CHECK/index predicate đọc bảng khác.
- `content_sources.source_type=owned`: provider và external ID/slug NULL. `third_party`: provider/external ID/slug bắt buộc. ID provider là TEXT, không giả định đó là UUID của PostgreSQL.
- `playableId` chung cho nhiều server của cùng tập; `sourceItemId` khác nhau cho từng server. Không đồng nhất tên server với season. Không tự merge phim khác nguồn chỉ dựa vào tên gần giống; TMDB/IMDB là gợi ý, không phải quyết định tự động.
- Không lưu `link_m3u8`, `link_embed` vào bảng catalog, `video_assets` hay OpenSearch. Adapter metadata phải strip URL playback trước khi cache; raw JSON có URL chỉ sống trong request resolver.
- `is_kids_safe=false` với nội dung chưa phân loại; không suy luận an toàn từ nhãn hoạt hình. Bộ lọc kids áp dụng cả danh sách personalized và tạo playback session.

### 2.4. Streaming — `streaming_db`

- `video_assets(id UUID PK, source_item_id UUID UNIQUE NOT NULL, playable_id UUID NOT NULL, movie_id UUID NOT NULL, raw_object_key TEXT, master_manifest_key TEXT NULL, available_resolutions TEXT[], duration_seconds INT NULL, processing_status, generation INT DEFAULT 1, upload_expires_at, failure_code NULL, created_at, updated_at)`. Chỉ owned; UUID Catalog là tham chiếu logic, không FK xuyên DB.
- Trạng thái asset: `upload_pending → queued → processing → ready | failed`; upload bỏ dở thành `expired`. Ghi trạng thái processing khi worker nhận việc; retry job terminal bằng generation mới.
- `playback_sessions(id UUID PK, ordinal BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, user_id, auth_session_id, profile_id, movie_id, playable_id, source_item_id, source_type, state=reserved|ready|playing|stopped|failed|expired, last_seq BIGINT DEFAULT 0, created_at, expires_at, last_seen_at, started_at NULL, qualified_at NULL)`. Không lưu URL ngoài trong session. Mọi ID ràng buộc với phiên đã tạo, client không tự thay chúng qua progress/event.
- `playback_requests(user_id, idempotency_key, request_hash, session_id, expires_at)` unique `(user_id,idempotency_key)`; không lưu URL ngoài trong response idempotency. Retry cùng key trả cùng session còn hiệu lực và có thể resolve URL mới; body khác hoặc session đã terminal/hết lease trả 409 (client dùng key mới để mở phiên mới). Request đang reserved được single-flight hoặc trả trạng thái đang xử lý, không resolve/tính slot hai lần. Lưu key ít nhất 24 giờ; xử lý key trước kiểm tra quota để retry không bị tính là phiên thứ hai.

Schema sửa lỗi khóa progress cho cả phim lẻ và tập:

```sql
CREATE TABLE watch_progress (
  profile_id UUID NOT NULL,
  playable_id UUID NOT NULL,
  movie_id UUID NOT NULL,
  source_item_id UUID NOT NULL,
  session_ordinal BIGINT NOT NULL,
  last_seq BIGINT NOT NULL,
  position_seconds INTEGER NOT NULL CHECK (position_seconds >= 0),
  duration_seconds INTEGER CHECK (duration_seconds > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, playable_id),
  CHECK (duration_seconds IS NULL OR position_seconds <= duration_seconds)
);
CREATE INDEX idx_progress_profile_updated
  ON watch_progress (profile_id, updated_at DESC);
```

Không dùng biểu thức trong danh sách cột PRIMARY KEY và không dùng episode nullable trong PK. `playableId` luôn có giá trị, kể cả phim lẻ. Theo [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html), PK đòi hỏi các cột không null; các ràng buộc/index đặc biệt phải được định nghĩa đúng loại.

**Ghi tiến độ MVP:** commit PostgreSQL trước khi trả thành công, cập nhật/xóa Redis cache sau commit. Chưa dùng write-behind/BullMQ cho progress; cân nhắc sau benchmark để tránh mất tiến độ đã ACK khi Redis/worker hỏng. Chỉ upsert khi `(session_ordinal,last_seq)` mới hơn bản ghi hiện tại. Vị trí có thể giảm khi tua về trước; không lấy MAX(position). Server cấp ordinal, client tăng seq trong một session; không dùng đồng hồ client để quyết định thứ tự. Session mới chỉ chiếm tiến độ khi nhận update hợp lệ đầu tiên.

Read-cache progress là tùy chọn, TTL khởi điểm 60 giây, update có version gate theo cùng tuple để callback request cũ không ghi đè cache mới. Khi tạo phiên/resume phải đọc PostgreSQL để không dùng cache stale; lỗi cache không biến DB commit thành lỗi phải gửi lại. BIGINT ordinal/seq phải giữ độ chính xác trong xử lý và DTO, không ép sang JavaScript Number ngoài safe integer range.

Duration của nguồn ngoài có thể chưa biết: cho phép null, không giả lập duration=0. Khi đổi source/cut, clamp resume theo duration mới; nếu độ dài khác đáng kể, trả `resumeNeedsConfirmation=true`, không hứa cùng timestamp luôn là cùng cảnh.

### 2.5. Payment — `payment_db`

| Bảng | Dữ liệu tối thiểu |
|---|---|
| `plans` | `id TEXT PK`, `name`, `price NUMERIC(12,2) CHECK >=0`, `currency CHAR(3)`, `duration_days CHECK >0`, `max_concurrent_streams CHECK >0`, `max_resolution`, `active`, `version` |
| `subscriptions` | `id UUID PK`, `user_id UUID NOT NULL`, `plan_id FK plans`, `status=pending\|active\|expired\|cancelled`, `start_at`, `end_at`, `auto_renew DEFAULT false`, `payment_expires_at`, snapshot tên/giá/tiền tệ/thời hạn/giới hạn và `version`; CHECK end > start khi có ngày |
| `payments` | `id UUID PK` cũng là orderId, `user_id`, `subscription_id FK subscriptions`, `provider`, `payment_method`, snapshot `amount/currency`, `status=pending\|success\|failed\|expired\|reconciliation_required\|refunded`, `provider_transaction_id NULL`, `payment_expires_at`, `paid_at`, `last_reconciled_at`, `version`; UNIQUE `(provider,provider_transaction_id)` khi có ID |
| `payment_requests` | `user_id`, `idempotency_key`, SHA-256 `request_hash`, `payment_id UNIQUE`; PK `(user_id,idempotency_key)` |
| `purchase_guards` | `user_id UUID PK`; khóa theo user để serialize subscribe, kích hoạt và đóng order |
| `payment_webhook_receipts` | `provider`, `event_id`, raw payload SHA-256, `payment_id`, `outcome`, stored `response`, `received_at`, `processed_at`; PK `(provider,event_id)` |
| `subscription_reminders` | `subscription_id`, `end_at`, `reminder_type`, stable `event_id`; PK subscription/endAt/type để cron không gửi trùng |
| `mock_provider_orders` | `order_id` FK payment, amount/currency/payment method, provider status/transaction ID; cho phép đối soát trạng thái mock độc lập với local timeout |
| `outbox_events` | Payment event envelope cùng transaction, attempts/lease/error và published timestamp sau Kafka ACK; event G4 gồm success, reconciliation_required và expiring |

Các bảng nghiệp vụ có `updated_at` và NOT NULL cho dữ liệu bắt buộc. Không nhận giá/giới hạn gói từ client. Snapshot tránh thay giá/gói đang dùng khi admin sửa plan. MVP tối đa một subscription pending hoặc active/user: unique partial index trên `user_id WHERE status IN ('pending','active')`. Mua tiếp khi đang active hoặc có order pending khác trả 409; retry cùng key trả order cũ. Khóa purchase_guards trước khóa order theo cùng thứ tự ở mọi luồng, chuyển active đã hết hạn sang expired trong transaction trước khi xét mua mới. Gia hạn/chuyển gói là tính năng sau, không tự cộng dồn tiền/ngày.

Pending có `payment_expires_at` (mặc định mock 30 phút). Job chỉ đóng order và subscription sau khi provider xác nhận failed/expired; timeout mạng không phải chứng cứ giao dịch thất bại. Mock phải cung cấp trạng thái order có thể truy vấn. Receipt success đến muộn sau khi order đã đóng được lưu với trạng thái `reconciliation_required`, cảnh báo và không tự kích hoạt chồng gói; quy trình đối soát/hoàn tiền của provider thật thuộc E2. Không bỏ qua receipt hoặc ACK như thể đã cấp gói thành công.

### 2.6. Worker, notification, recommendation và bảng hạ tầng

- Worker dùng `worker_db.transcode_jobs`: unique `(asset_id,generation)`, `state`, `attempts`, `lease_until`, input/output prefix, lỗi rút gọn. Đủ dữ liệu để restart không mất job.
- Notification dùng `notification_db.notification_deliveries`: unique `(event_id,recipient_id,channel)`, status, attempt, nextRetryAt. Producer gửi event nghiệp vụ, consumer xác định recipient từ notification preferences; không broadcast mỗi lần sửa metadata. MVP mock channel; FCM token/preferences là phần tích hợp thật.
- Recommendation dùng `recommendation_db.watch_events`: `event_id UNIQUE`, `session_id UNIQUE`, `profile_id`, `movie_id`, `occurred_at`, không đếm mỗi progress làm một lượt xem. Có HTTP nội bộ trả gợi ý/trending, không gọi nó là consumer-only.
- Mỗi service cần publish bền vững có `outbox_events(id UUID PK, aggregate_id, aggregate_version, event_type, payload JSONB, occurred_at, published_at NULL, attempts)` cùng DB với nghiệp vụ. Consumer có `processed_events(consumer_name,event_id,processed_at)` PK kép, ghi cùng transaction side effect DB.

## 3. Tích hợp KKPhim và catalog hợp nhất

### 3.1. API ngoài và adapter

Tham chiếu [API KKPhim](https://kkphim.com/api-document), đối chiếu ngày 2026-09-12: base `https://phimapi.com`, JSON GET. Danh mục endpoint, tham số, response shape và mapping chi tiết nằm trong [tài liệu tích hợp KKPhim](kkphim-api.md). Dự án dùng `/danh-sach/phim-moi-cap-nhat?page=...` cho discovery, `/phim/{slug}` cho resolve legacy, `/v1/api/tim-kiem?keyword=...` cho tìm nguồn trong CMS. Legacy detail có `movie`, `episodes[].server_name`, `server_data[]`; v1 detail bọc trong `data.item`. Adapter tách parser theo endpoint/version.

`content-provider` chia hai đường: `fetchMetadata(slug)` strip URL stream trước khi cache; `resolvePlayback(selectors)` gọi detail mới và chỉ giữ URL trong bộ nhớ của request. Catalog sở hữu import/sync; Streaming dùng resolver chung để tránh gọi metadata cache 15 phút khi phát. Không mặc định v1 ổn định hơn legacy hay provider có SLA, quota, URL expiry, DRM/offline.

Đây là thiết kế adapter, chưa phải kết quả kiểm thử API trực tiếp. Giai đoạn tích hợp phải có fixture cho status false/404, timeout, schema khác, field thiếu và URL đổi.

### 3.2. Chiến lược dữ liệu được chọn

**Public catalog/search chỉ đọc catalog nội bộ đã nhập**, trộn cả hai nguồn theo ID chung. Không gộp trực tiếp hai trang tìm kiếm độc lập từ PostgreSQL và KKPhim. Điều này giữ phân trang, favorites, history và OpenSearch nhất quán. Admin discovery có thể gọi API ngoài rồi import; phim chưa import chưa xuất hiện trong public catalog.

- Import idempotent bằng `(provider,external_id)`; slug là alias có thể đổi. Upsert alias có collision phải báo lỗi để xử lý, không gắn nhầm movie. UUID local giữ nguyên qua sync.
- Discovery mặc định dev tắt, có cấu hình bật mỗi 30 phút tối đa 3 trang; đây là lựa chọn tải của dự án, không phải quota của provider. Refresh danh sách đã import theo vòng, tuổi metadata mục tiêu 6 giờ; có manual backfill/checkpoint để phủ mục cũ. Discovery hữu hạn không bảo đảm bắt hết cập nhật.
- Phân trang bằng pagination provider trả, có maxPages và checkpoint theo job; sửa danh sách trong lúc scan có thể gây lặp, upsert xử lý được. Không suy ra phim bị xóa chỉ vì không thấy trong 3 trang đầu. Retry refresh mục lỗi; chỉ xác nhận mất nguồn sau phản hồi detail rõ ràng/recheck, lưu tombstone để giữ ID.
- `metadata_locked` khóa các trường biên tập (title, description, ảnh, thể loại); vẫn refresh selectors/availability của tập/server. `external_updated_at` không đổi có thể bỏ qua metadata, nhưng không bỏ qua refresh tập theo lịch hoặc resolve lúc phát. Provider không cam kết timestamp đổi cho mọi thay đổi link.
- `movies.status`: owned tạo draft, admin publish; KKPhim import thành công auto-publish. Archive thủ công luôn được giữ qua sync. Chỉ phát `movie.published` ở lần chuyển sang published; update metadata phát `movie.updated`, archive phát `movie.archived`.
- `movies.type` là movie/series, khác `content_kind` film/animation/show. Không map mọi `hoathinh` thành series. Dùng cấu trúc tập/TMDB type khi có; trường không đủ rõ chuyển import sang lỗi cần hiệu chỉnh kỹ thuật, không đoán phá schema.
- Season thiếu: tạo season 1 với `is_synthetic=true` cho series, không coi server Vietsub/Thuyết minh là season. Nhóm các server cùng tập bằng số/label rõ ràng; giữ mapping provider selector. Nếu tên mơ hồ, không tự merge; giữ lựa chọn riêng có nhãn, ghi diagnostic. Nếu provider đổi slug/nhãn không thể khớp chắc chắn, giữ bản ghi cũ và báo mapping conflict thay vì đổi playableId đã có history.
- Ảnh tuyệt đối giữ nguyên sau validation; đường dẫn tương đối ghép theo base ảnh của đúng response adapter, không ghép mọi ảnh vào base API. Mô tả HTML sanitize thành plain text. Rating cho phép 10.0; thời lượng text không parse được thì null. Không coi nhãn FHD là danh sách rendition HLS thực tế.
- Search index theo movie UUID/version; normalize chữ hoa/dấu, có fixture tiếng Việt có/không dấu. Reindex từ Catalog DB; consumer bỏ sự kiện version cũ. Kết quả search recheck trạng thái published và kids filter trước trả, tránh lộ nội dung đã archive khi index chậm.

G3 có thể dùng PostgreSQL ILIKE cho tìm kiếm tạm; G7 thay bằng OpenSearch trước nghiệm thu MVP. Public pagination dùng sort có ID tie-break; khi lọc bỏ hit đã archive phải bù hit còn hợp lệ và tính totals theo cùng bộ lọc, không trả total của một truy vấn khác. Offset pagination không bảo đảm snapshot qua nhiều request khi catalog đang thay đổi.

### 3.3. Giới hạn lỗi và cache

Timeout provider 5 giây/lần, tối đa 2 retry cho lỗi mạng/5xx/429 có Retry-After, tổng request playback budget 15 giây. Concurrency mặc định 3 **cho mỗi provider trên toàn deployment** qua Redis semaphore; cache miss dùng single-flight. Các số là cấu hình khởi điểm cần đo, không phải cam kết hiệu năng.

Circuit breaker mở 30 giây sau ngưỡng lỗi, sau đó half-open probe. `source_status=error/unavailable` có `retry_after`, không cấm phát vĩnh viễn dựa vào flag lỗi cũ. Khi đến hạn, một request được re-resolve; update status gửi qua Catalog nội bộ, thất bại ghi status không được biến thành lỗi playback đã resolve thành công.

Provider API base và domain media được cấu hình allowlist; chỉ HTTPS, không userinfo, không URL do client chỉ định. Backend kiểm tra DNS/IP đích và từng redirect của request do mình fetch, chặn loopback/private/link-local và giới hạn số redirect/body size. Media client kiểm tra riêng host/redirect và URI variant/segment/key trong manifest; kiểm tra ở backend không tự bảo vệ request Android. Fixture localhost chỉ được bật trong test/dev bằng cấu hình riêng, production không có ngoại lệ này. Timeout hết budget dừng retry dù chưa đủ số lần.

| Cache | TTL khởi điểm | Quy tắc |
|---|---|---|
| Metadata provider đã strip URL | 15 phút | Playback luôn bypass |
| Catalog detail | 30 phút | Invalidate theo movie/source version |
| Public home/list | 5 phút | Key gồm filter/page/version; không chứa profile |
| Personalized home/history | Không cache cả response MVP | Compose từ dữ liệu riêng; tránh trộn profile |
| Negative provider result | 30 giây | Có recheck, không ghi permanent failure |
| Gói cước | 1 giờ | Snapshot subscription tách biệt, invalidate khi thay plan |
| Progress | Read-cache sau DB commit | Cache hỏng có thể đọc DB; không ACK trước commit |
| Playback response/URL ngoài | Không cache/persist | HTTP `Cache-Control: no-store`, không ghi URL vào log/event |

## 4. Hợp đồng HTTP và Gateway

### 4.1. Chuẩn response và xác thực

Response JSON: `{success, data, error, requestId}`; thành công `error=null`, lỗi `data=null`, error gồm `{code,message,details?}`. Danh sách nằm trong `data={items,page,pageSize,totalItems,totalPages}`; page bắt đầu 1, pageSize mặc định 20/tối đa 50, stable tie-break bằng ID. 204 không có body. Async job trả 202 + jobId; không giữ HTTP mở đến hết sync/transcode.

POST tạo order/playback/upload/import dùng `Idempotency-Key`; cùng user/key/body trả cùng tài nguyên, khác body trả 409. Ràng buộc DB/lease bảo đảm gọi đồng thời không tạo trùng. Hợp đồng OpenAPI đã được ghi cho Catalog trong `catalog-openapi.yaml` và Payment trong `payment-openapi.yaml`; các bảng route dưới đây là chuẩn nghiệp vụ toàn hệ thống.

JWT được verify ở Gateway **và service**. Nội bộ dùng credential định danh service, có audience và allowlist caller theo endpoint; user JWT gốc được chuyển tiếp khi cần kiểm tra ownership. Chặn `/internal/*` ở Gateway; không tin `X-User-Id` do client gửi. Chỉ Auth giữ private key user JWT. Các header auth/token/cookie/URL có query phải redact.

### 4.2. API cho Android

| Method | Path | Auth | Chủ sở hữu / hành vi |
|---|---|---|---|
| POST | `/auth/register` | Public + rate limit | Auth, body email/password/fullName |
| POST | `/auth/login` | Public + rate limit | Auth, thêm deviceId/deviceName, trả accessToken/refreshToken/expiresIn |
| POST | `/auth/refresh` | Refresh token | Auth, rotation |
| POST | `/auth/logout` | Refresh token | Auth, revoke session, 204 idempotent |
| GET | `/auth/.well-known/jwks.json` | Public | Auth, chỉ public keys |
| GET | `/auth/session` | JWT + active session | Gateway trả user/session hiện tại sau khi Auth introspection |
| GET | `/admin/session` | JWT + role admin/content_manager | Gateway, endpoint kiểm tra ranh giới role cho CMS |
| GET | `/profiles` | JWT | Profile, hồ sơ của user |
| POST | `/profiles` | JWT | Profile, name/avatarId/isKids |
| PATCH | `/profiles/:profileId` | JWT + owner | Profile |
| DELETE | `/profiles/:profileId` | JWT + owner | Profile, soft delete, 204 |
| GET | `/profiles/:profileId/favorites` | JWT + owner | Profile + hydrate Catalog |
| PUT | `/profiles/:profileId/favorites/:movieId` | JWT + owner | Profile, idempotent |
| DELETE | `/profiles/:profileId/favorites/:movieId` | JWT + owner | Profile, 204 idempotent |
| GET | `/profiles/:profileId/watch-history` | JWT + owner | Profile gọi Streaming/Catalog |
| GET | `/catalog/home` | Public | Catalog, published, không nhận profileId |
| GET | `/catalog/movies` | Public | Catalog, genre/country/year/sourceType/provider/sort/page/pageSize |
| GET | `/catalog/movies/:movieId` | Public | Catalog, playableItems và sourceItems, không URL phát |
| GET | `/catalog/search` | Public | Catalog, q/filter/page/pageSize trên catalog đã import |
| GET | `/home` | JWT + profile owner | Gateway compose, query profileId; tiếp tục xem + gợi ý + catalog |
| GET | `/subscriptions/plans` | Public | Payment |
| POST | `/subscriptions/subscribe` | JWT + Idempotency-Key | Payment, planId/paymentMethod |
| GET | `/subscriptions/current` | JWT | Payment, subscription hiện tại hoặc null |
| POST | `/payments/webhook/:provider` | Chữ ký provider, không JWT | Payment, verify raw body |
| POST | `/streaming/playback-sessions` | JWT + Idempotency-Key | Streaming, body movieId/playableId/sourceItemId/profileId |
| POST | `/streaming/playback-sessions/:sessionId/heartbeat` | JWT + session owner | Streaming, gia hạn lease |
| POST | `/streaming/playback-sessions/:sessionId/progress` | JWT + session owner | Streaming, seq/positionSeconds/durationSeconds? |
| POST | `/streaming/playback-sessions/:sessionId/events` | JWT + session owner | Streaming, eventId/type/playedSeconds?; started/qualified/failed/stopped |
| POST | `/streaming/playback-sessions/:sessionId/media-auth` | JWT + session owner | Streaming, renew credential owned khi lease còn hiệu lực |

Tạo phiên là POST vì làm thay đổi trạng thái; bỏ hai route GET tạo phiên cũ (`play-url` và `playback`). `sourceItemId` phải thuộc playable/movie trong body; `profileId` phải thuộc user. `isKids` và subscription không lấy từ dữ liệu client tự khai.

GET `/catalog/movies`, `/catalog/movies/:movieId` và `/catalog/search` nhận thêm `profileId` tùy chọn. Khi có profileId, Gateway/Catalog bắt buộc JWT và Profile ownership, lọc kids tại backend; detail không phù hợp trả 404. Android đang chọn profile kids phải luôn gửi profileId. Không có profileId là catalog public tổng quát; tính năng này không phải khóa kiểm soát trẻ em chống chuyển hồ sơ (PIN thuộc phần sau). Cache key bao gồm chế độ kids đã xác minh, không tin flag client. `/catalog/home` luôn public; home theo profile dùng `/home`.

`catalog/home`: `newReleases` theo publishedAt; `topRated` theo rating (không gọi top rating là trending). `trending` từ qualified view 7 ngày, dữ liệu rỗng fallback newReleases và ghi rõ loại section. `/home` gọi composition ở Gateway, tránh vòng Catalog ↔ Streaming.

### 4.3. Admin API và routing

| Method | Path | Service | Role |
|---|---|---|---|
| POST | `/admin/movies` | Catalog | admin/content_manager |
| GET | `/admin/movies` | Catalog | admin/content_manager |
| PATCH | `/admin/movies/:movieId` | Catalog | admin/content_manager |
| POST | `/admin/movies/:movieId/publish` | Catalog | admin/content_manager |
| POST | `/admin/movies/:movieId/archive` | Catalog | admin/content_manager |
| POST | `/admin/movies/:movieId/seasons` | Catalog | admin/content_manager |
| POST | `/admin/movies/:movieId/playable-items` | Catalog | admin/content_manager |
| POST | `/admin/movies/:movieId/content-sources` | Catalog | admin/content_manager |
| POST | `/admin/content-sources/:sourceId/items` | Catalog | admin/content_manager |
| PATCH | `/admin/source-items/:sourceItemId` | Catalog | admin/content_manager, sửa selector/mapping có kiểm tra cùng movie |
| PATCH | `/admin/content-sources/:sourceId/metadata-lock` | Catalog | admin/content_manager |
| GET | `/admin/providers/kkphim/search` | Catalog | admin/content_manager |
| POST | `/admin/providers/kkphim/import` | Catalog | admin/content_manager, body slug/movieId?; gắn vào movie có sẵn khi chỉ định, 202 syncRunId |
| POST | `/admin/providers/kkphim/sync` | Catalog | admin/content_manager, bounded maxPages, 202 syncRunId |
| GET | `/admin/providers/kkphim/sync-runs` | Catalog | admin/content_manager |
| POST | `/admin/videos/uploads` | Streaming | admin/content_manager, sourceItemId/size/checksum |
| POST | `/admin/videos/:assetId/upload-complete` | Streaming | admin/content_manager |
| GET | `/admin/videos/:assetId/status` | Streaming | admin/content_manager |
| POST | `/admin/videos/:assetId/retry` | Streaming | admin/content_manager, chỉ failed |
| GET | `/admin/reports/revenue` | Payment | chỉ admin, from/to |
| GET | `/admin/reports/top-movies` | Recommendation qua Gateway | admin/content_manager |

Gateway định tuyến tường minh `/admin/movies`, `/admin/content-sources`, `/admin/source-items`, `/admin/providers` về Catalog; `/admin/videos` về Streaming; report theo bảng. Import vào movie có sẵn phải kiểm tra loại movie/playable và ánh xạ tập; conflict trả diagnostic để admin sửa mapping, không tự merge theo tên. Route sửa mapping ghi audit, giữ playableId có history; không âm thầm đổi nội dung tập đã phát. `/admin/*` không nằm dưới prefix `/catalog/*`. Route auth/Public match cả **method + path**, không miễn auth toàn prefix admin/webhook.

### 4.4. API nội bộ và phụ thuộc

| Method | Path | Service sở hữu | Caller |
|---|---|---|---|
| POST | `/internal/auth/validate-session` | Auth | Gateway, các API service; kiểm tra user/sid/revoke |
| POST | `/internal/profiles/validate` | Profile | Streaming, Gateway, Catalog; userId/profileId |
| GET | `/internal/catalog/playables/:playableId` | Catalog | Streaming; trạng thái movie, accessTier, kids, source selectors |
| POST | `/internal/catalog/movies/batch` | Catalog | Profile, Gateway, Recommendation; hydrate/filter IDs |
| POST | `/internal/catalog/source-items/:sourceItemId/status` | Catalog | Streaming, optimistic version và thời gian resolve |
| GET | `/internal/subscriptions/users/:userId/entitlement` | Payment | Streaming; active theo now() và endAt |
| GET | `/internal/streaming/profiles/:profileId/progress` | Streaming | Profile, Gateway; đã kiểm tra ownership |
| GET | `/internal/recommendations/:profileId` | Recommendation | Gateway |
| GET | `/internal/trending` | Recommendation | Catalog, Gateway |

Gateway kiểm tra chữ ký/session trước khi proxy `/profiles`; chỉ lấy `userId` từ Auth introspection và ghi đè mọi header cùng tên do client gửi. Profile CRUD yêu cầu service credential của `api-gateway`; validation nội bộ chỉ chấp nhận credential được cấp cho Gateway, Streaming hoặc Catalog. `profile.deleted` được lưu cùng soft-delete trong Profile DB và publish qua outbox; chưa có dependency bắt buộc tới Streaming để CRUD hoạt động.

Profile core không cần Streaming lúc tạo/sửa hồ sơ; history composition được làm sau khi Streaming có API. Recommendation chỉ đọc Catalog batch và event, không truy cập DB Streaming. Service dependency lỗi trả 503 rõ tên dependency trong log, không tự mở quyền tài khoản; riêng recommendation/trending lỗi có thể bỏ section/fallback.

## 5. Luồng playback hai nguồn

### 5.1. Quy tắc chung và response

MVP `accessTier=free` không cần mua gói; đăng nhập vẫn bắt buộc để tạo session. `subscription` cần gói active và `endAt > now()`. Free concurrency mặc định 1; subscriber dùng `maxConcurrentStreams` snapshot. Giới hạn thiết bị đăng nhập (Auth) và simultaneous playback (Streaming) là hai chính sách độc lập.

Giữ slot Redis atomic theo user: dọn lease expired, kiểm tra limit, reserve session cùng thao tác; TTL 90 giây, heartbeat mỗi 30 giây, pause không giữ slot quá TTL nếu không heartbeat. Resolve thất bại giải phóng slot; process chết tự hết TTL. Khi Redis lỗi, không tạo phiên mới vì không thể bảo đảm concurrency. DB/session và Redis không có transaction chung: lưu request ID idempotent, bù trừ và job reconcile các reserved session bị bỏ dở. Heartbeat kiểm tra auth/profile/session/subscription rồi mới gia hạn. Nâng/hạ gói không thay slot theo dữ liệu client.

Response trong envelope chuẩn:

```json
{
  "sessionId": "uuid",
  "playableId": "uuid",
  "sourceItemId": "uuid",
  "sourceType": "third_party",
  "protocol": "hls",
  "playbackUrl": "https://media.example/manifest.m3u8",
  "mediaAuth": null,
  "drm": null,
  "urlExpiresAt": null,
  "leaseExpiresAt": "2026-09-12T12:01:30Z",
  "resumePositionSeconds": 0,
  "resumeNeedsConfirmation": false,
  "subtitles": [],
  "offlineSupported": false
}
```

`urlExpiresAt=null` nghĩa provider không nêu thời hạn, khác lease của app. `mediaAuth` chỉ mô tả cookie/header cho CDN nội bộ khi dùng; không gửi JWT ứng dụng cho media host. Subtitle/resolution chỉ trả nếu có thông tin thực tế, không tự bịa từ nhãn server.

Owned dùng `mediaAuth={type:"cookie",host,path,cookies:[{name,value}],expiresAt}`; host chính xác, path theo asset/generation. Android chỉ gắn cookie vào request media phù hợp host/path, không forward qua redirect sang host khác. Renew trả cùng cấu trúc mediaAuth và expiry mới. `events` chỉ áp dụng transition hợp lệ: started chuyển ready→playing, stopped/failed đóng phiên và nhả slot; duplicate eventId không lặp side effect. Heartbeat/progress không hồi sinh phiên terminal/hết lease. Seq áp dụng riêng progress; client flush progress trước stopped.

### 5.2. Bên thứ ba — Frontend, Backend và provider

```mermaid
sequenceDiagram
    participant App as Android Frontend
    participant GW as Gateway Backend
    participant S as Streaming Backend
    participant D as Auth/Profile/Catalog/Payment Backend
    participant K as KKPhim API
    participant C as Host media bên thứ ba
    App->>GW: POST /streaming/playback-sessions + JWT + ID nội bộ
    GW->>S: Request đã qua xác thực Gateway
    S->>D: Xác thực session, profile, movie/source, entitlement
    D-->>S: Trạng thái và selectors
    alt Tài khoản hoặc dữ liệu không hợp lệ
        S-->>GW: Lỗi 401/403/404/409/503
        GW-->>App: Hiển thị lỗi tương ứng
    else Hợp lệ
        Note over S: Reserve slot atomic; tạo session idempotent
        S->>K: GET /phim/{slug}, không dùng cache URL
        K-->>S: Detail gồm episode/server và URL
        Note over S: Match selector, validate HTTPS/host; lỗi thì release slot
        S-->>GW: Response HLS chuẩn hóa hoặc lỗi nguồn
        GW-->>App: sessionId + playbackUrl, no-store
        App->>C: GET manifest
        C-->>App: Manifest
        loop Trong khi xem
            App->>C: GET variant/segment theo manifest
            C-->>App: Dữ liệu video/audio
            App->>GW: Progress 10–15s, heartbeat 30s
            GW->>S: Commit progress / gia hạn session
        end
    end
```

1. **Frontend:** chọn movie/playable/sourceItem từ public Catalog đã chuẩn hóa. Chọn profile cá nhân; gọi POST tạo session, không gửi URL ngoài tùy ý. **Backend:** check Published, ownership, isKidsSafe, tier, quota. **Bên thứ ba:** chưa nhận request media.
2. **Backend:** lấy selectors Catalog và gọi `resolvePlayback` qua client chung. Tìm đúng server/tập; không chọn phần tử đầu tiên để đoán tập. **KKPhim API:** trả detail và link; API metadata và host media có thể khác chủ thể/hạ tầng.
3. **Backend:** HLS là chế độ MVP. Chỉ có embed trả `PLAYBACK_MODE_UNSUPPORTED` (422), không tự động fallback WebView. Không tạo `video_assets` cho nguồn ngoài, không persist/cache URL; retry cùng request key dùng lại session nhưng resolve fresh.
4. **Frontend:** Media3 nhận response, tải manifest/variant/segment trực tiếp host media; ABR chỉ có nếu manifest cung cấp nhiều rendition. Không chuyển bytes video qua backend. **Host media:** phục vụ các file và quyết định khả dụng thực tế.
5. **Frontend:** progress seq tăng mỗi session, heartbeat độc lập kể cả đang pause nếu muốn giữ phiên, event stopped/failed khi kết thúc. **Backend:** commit progress, giải phóng lease, event dedupe. Android chết/mất mạng không bảo đảm có callback stopped; dùng TTL/reaper thay vì chờ “ngắt kết nối HTTP”.
6. **Lỗi:** refresh token chỉ cho API ứng dụng; 401/403 từ CDN ngoài có thể là link/provider lỗi, không gọi Auth refresh theo mã CDN. Backend có thể re-resolve một lần, tạo lại MediaItem và resume. Không fallback sang nguồn của tập khác. Hết budget trả `EXTERNAL_SOURCE_UNAVAILABLE` 503; nguồn owned vẫn phục vụ được.

Giới hạn kỹ thuật: với URL media bên thứ ba được phát trực tiếp, backend kiểm soát việc cấp phiên và hành vi app, **không bảo đảm thu hồi URL đã lộ, giới hạn rendition tại CDN ngoài hoặc ngăn phát ngoài app**. `maxResolution` trên player ngoài là lựa chọn UX; không hứa đó là hạn chế cưỡng chế ở server. Backend không quan sát trực tiếp lượng media đã xem; progress/playedSeconds là telemetry client.

### 5.3. Nguồn nội bộ và bảo vệ HLS

Resolver owned lookup `video_assets` theo sourceItemId; chưa ready trả `VIDEO_NOT_READY` 409. S3 raw/processed private. Không coi việc gắn JWT vào query URL là bảo vệ nếu media-edge/CDN không xác minh token.

Dev dùng media-edge kiểm tra signed cookie scope theo asset/generation và expiry cho **mọi** master, variant, segment, subtitle/key; origin chỉ edge truy cập. Adapter CloudFront khi triển khai thật dùng signed cookies/custom policy hoặc cơ chế tương đương bao phủ toàn bộ đường dẫn asset. Native Android phải gắn cookie bằng media HTTP client đúng hostname; không dựa vào cookie jar của WebView. Test thiếu/hết hạn cookie ở cả master và segment phải bị từ chối. Xem [CloudFront signed URLs/cookies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-choosing-signed-urls-cookies.html): HLS cần truy cập nhiều file, không chỉ master manifest.

Expiry media credential nội bộ mặc định 15 phút, có POST `/streaming/playback-sessions/:sessionId/media-auth` để renew khi session vẫn active. Endpoint này cùng guard như heartbeat, chỉ owned, không tạo slot mới. Trước khi bật maxResolution theo gói, edge phải giới hạn cả danh sách variant lẫn đường dẫn rendition (không chỉ ẩn nút chọn trên UI). MVP không quảng bá phân tầng chất lượng trước khi test enforcement hoàn tất.

Signed cookie stateless vẫn dùng được đến expiry sau khi phiên bị đóng; TTL lease 90 giây không tự thu hồi cookie 15 phút. App phải dừng phát khi heartbeat bị từ chối. Thu hồi tức thời tại edge cần kiểm tra session/revocation riêng và là phần mở rộng; MVP giới hạn phiên cấp qua API, không cam kết chặn mọi cách dùng lại credential đã cấp.

## 6. Upload và transcode nội bộ

1. **CMS → Streaming:** `POST /admin/videos/uploads` kèm sourceItemId/size/checksum và Idempotency-Key. Streaming kiểm tra source owned, tạo asset upload_pending cùng raw key do server sinh, trả presigned PUT. Một active asset/source item; tạo lại sau expiry dùng cùng asset với generation tăng.
2. **CMS → Object storage:** PUT file trực tiếp. Có URL upload chưa đồng nghĩa file đã upload xong.
3. **CMS → Streaming:** `POST /admin/videos/:assetId/upload-complete`. Streaming HEAD đúng raw key kiểm tra kích thước/checksum và expiry, CAS trạng thái sang queued, ghi outbox `video.uploaded`. Không tin object key tùy ý từ client. Complete lặp không enqueue trùng.
4. **Kafka → Worker:** consumer upsert job unique asset/generation vào worker DB, commit offset sau khi job đã bền vững; worker claim lease và chạy ngoài vòng poll Kafka. Outbox `video.processing` cập nhật asset processing. Tránh long FFmpeg job làm consumer rebalance/làm mất job.
5. **Worker:** download raw, ffprobe input; spawn FFmpeg bằng argument array (không shell interpolation), time/resource limits, output HLS H.264/AAC 480/720/1080 tùy kích thước input, không upscale. Các rendition căn keyframe, master và relative URI hợp lệ. Temp directory riêng job, cleanup thành công/thất bại.
6. **Worker → Storage:** output ở processed bucket key `assets/{assetId}/g{generation}/...`; upload segment/variant trước, master sau cùng. Ghi outbox `video.transcoded` chỉ khi toàn bộ output thành công. Retry không lẫn output các generation.
7. **Streaming consumer:** idempotent/CAS đúng generation, cập nhật ready+manifest+duration/resolutions; phát `video.ready`. Catalog cập nhật source availability projection. Kết quả generation cũ bị bỏ qua.
8. Retry tối đa 3 lần sau lần đầu, backoff 30/60/120 giây lưu trong job, không sleep Kafka handler. Hết retry phát `video.transcode_failed`, Streaming đánh failed, Notification gửi admin mock. Admin retry tạo generation mới. Job lease hết hạn được reclaim; DLQ có công cụ xem/replay, không mất lỗi âm thầm.

Asset lưu `expected_size_bytes`, `expected_checksum`, `checksum_algorithm`; raw key riêng generation, upload request idempotency lưu bền vững trong Streaming. Worker xác minh checksum sau download; không coi ETag multipart hay metadata client tự khai là checksum đáng tin. Khi retry/reclaim cùng generation, dùng attempt token tăng dần và output prefix riêng attempt; chỉ holder lease/token hiện tại được commit kết quả/master pointer. Điều này ngăn worker cũ ghi đè output khi một worker khác đã nhận lại job. Event processing đến sau transcoded trong cùng generation không được hạ ready về processing; version job và transition terminal được kiểm tra ngoài generation. Publish owned yêu cầu ít nhất một source item ready; projection chậm trả lỗi có thể thử lại.

HLS VOD versioned có thể cache manifest lâu sau hoàn tất; không cần TTL manifest ngắn như livestream. Cleanup raw/output lỗi theo retention cấu hình, không xóa output của job đang chạy. `child_process.spawn` gọi FFmpeg CLI, không bắt buộc wrapper chưa được kiểm tra tình trạng bảo trì. DRM packaging/key server và offline nội bộ làm sau MVP.

## 7. Thanh toán, sự kiện và tính nhất quán

### 7.1. Payment mock và webhook

- Subscribe: transaction khóa purchase_guards, kiểm tra idempotency và một pending/active subscription, tạo pending subscription/payment từ snapshot plan; gọi provider sau commit bằng orderId idempotent để retry khi timeout, không giữ DB transaction trong lúc gọi mạng. Worker đối soát pending theo mục 2.5 để order bỏ dở không khóa việc mua gói vĩnh viễn.
- Mock chỉ dev/test, dùng secret HMAC cấu hình và fixture ký đúng; không có verifier luôn trả true trên endpoint public. Production từ chối khởi động nếu payment mock đang bật.
- Webhook `/payments/webhook/:provider` giữ raw body tới Payment; Gateway không JSON stringify lại payload. Verify chữ ký và mapping event/order trước transaction. Mock event ID do fixture cấp; adapter thật ánh xạ ID và quy tắc signature của từng provider.
- Transaction khóa payment/order, check provider/amount/currency, dedupe receipt, CAS pending→success, kích hoạt subscription một lần, ghi `payment.success` outbox. Unique transaction ID đơn lẻ không thay thế transaction/CAS. Webhook trùng cùng event/order trả ACK, không tính lại endAt; transaction ID khác gắn vào order đã paid là conflict để điều tra, không cấp thêm ngày.
- Failed đến sau success không downgrade; refund là trạng thái riêng với xử lý thu hồi subscription được định nghĩa ở giai đoạn thanh toán thật. Webhook không khớp trả mã lỗi theo adapter, log không chứa secret.
- Expiry kiểm tra `endAt > now()` lúc truy vấn entitlement, không phụ thuộc cron chạy kịp. Cron cập nhật expired và reminder trong 3 ngày, dedupe theo subscription/endAt/type. MVP `autoRenew=false`, không mô tả “gia hạn tự động” khi chỉ có cron nhắc.

### 7.2. Envelope và bảng sự kiện chuẩn

Envelope `{eventId,eventType,schemaVersion,aggregateId,aggregateVersion,occurredAt,producer,correlationId,payload}`. eventId UUID; partition key aggregateId; timestamp không thay aggregateVersion. Tên topic lowercase dot-separated; enum trong code sau này chỉ ánh xạ sang đúng tên này.

| Topic | Producer duy nhất | Consumer | Payload chính |
|---|---|---|---|
| `movie.published` | Catalog | Search, Notification | movieId, version |
| `movie.updated` | Catalog | Search | movieId, version |
| `movie.archived` | Catalog | Search, Streaming | movieId, version |
| `movie.source.updated` | Catalog | Streaming, Search | movieId, sourceItemId, sourceStatus, version |
| `video.uploaded` | Streaming | Worker | assetId, generation, rawObjectKey, checksum |
| `video.processing` | Worker | Streaming | assetId, generation |
| `video.transcoded` | Worker | Streaming | assetId, generation, manifestKey, durationSeconds, resolutions |
| `video.transcode_failed` | Worker | Streaming, Notification | assetId, generation, errorCode |
| `video.ready` | Streaming | Catalog | assetId, sourceItemId, generation |
| `payment.success` | Payment | Notification | userId, subscriptionId, paymentId |
| `payment.reconciliation_required` | Payment | Chưa có consumer; vận hành/đối soát sau này | paymentId, subscriptionId, userId, providerTransactionId |
| `subscription.expiring` | Payment | Notification | userId, subscriptionId, endAt, reminderType |
| `profile.deleted` | Profile | Streaming, Recommendation | profileId, userId |
| `playback.qualified` | Streaming | Recommendation | sessionId, profileId, movieId, occurredAt |

Outbox ghi cùng transaction nghiệp vụ, publisher đánh published sau Kafka ACK; có thể phát lặp nên consumer inbox và version gate bắt buộc. Retry bounded, DLQ cùng envelope/error metadata, replay giữ eventId để dedupe. Partition/order không giải quyết transaction xuyên DB. Search đọc metadata hiện tại bằng API Catalog; consumer checkpoint/lag quan sát được.

Version thuộc aggregate của producer, không so trực tiếp version Worker với version asset Streaming. Worker aggregate là job asset/generation, Streaming là asset hoặc session, Catalog là movie/source item; consumer lưu version theo producer/aggregate. Kafka không bảo đảm thứ tự giữa các topic. Side effect gửi ra ngoài DB cần delivery job/idempotency riêng; inbox commit không chứng minh email đã gửi đúng một lần.

Version gate dùng cho projection trạng thái; notification về một sự kiện nghiệp vụ dedupe theo eventId/recipient, không bỏ movie.published chỉ vì movie.updated version cao hơn đến trước. Consumer kiểm tra trạng thái hiện tại khi cần tránh thông báo nội dung đã archive.

Một qualified view: session báo xem tích lũy tối thiểu 30 giây, event có eventId, server chỉ chuyển qualified_at từ NULL một lần. Resume/progress 10–15 giây không làm tăng view count. Trending đếm distinct qualified session trong 7 ngày; recommendation đơn giản lấy phim cùng thể loại chưa xem, fallback trending/new releases. Không gọi rating cao là trending. Mock telemetry có thể bị giả; không dùng làm bằng chứng thanh toán.

## 8. Vận hành và kiểm chứng

- Compose chia profile core/media/observability để laptop không phải chạy mọi thành phần ngay. Health/readiness, DB init per service, volume và bootstrap MinIO buckets/Kafka topics idempotent. Không public cổng service nội bộ ở môi trường triển khai.
- CI từ giai đoạn 0: lint/typecheck/build/unit; integration PostgreSQL/Redis/Kafka/OpenSearch/MinIO theo giai đoạn. Fixture KKPhim chạy local để test cả JSON lẫn media, CI không gọi provider thật. Có schema/contract smoke read-only thủ công sau này; không tính nó là test CI deterministic.
- Test xuyên Gateway trước triển khai: cả movie lẻ và series, cả nguồn; internal upload→complete→transcode→ready→master→variant→segment thực sự fetch/đọc được. Chỉ test VIDEO_NOT_READY không đủ chứng minh phát nội bộ thành công.
- CI publish image chỉ trusted main/tag, PR chạy checks không có registry/deploy secrets. Shared lib/root config/lockfile đổi phải rebuild tất cả app phụ thuộc (chưa có dependency graph thì build tất cả), không chỉ app paths. Git root hiện là `Backend/`; workflow nằm `Backend/.github/workflows/ci.yml` và chạy từ chính root đó.
- Migration từng database có job chạy một lần trước rollout, không chạy đồng thời trong mỗi replica. Thiết kế expand/contract cho thay schema, image SHA immutable; rollback app phải tương thích schema. Restore PostgreSQL/object storage phải diễn tập trước deploy thật.
- Staging/production secrets và media/auth keys theo service. Streaming không giữ JWT private key của Auth. Kubernetes/HPA/KEDA sau benchmark; đánh giá riêng CPU transcode, DB connection pool và Kafka lag.
- Observability: requestId/trace propagation qua HTTP/event; p95 API, error rate theo dependency, provider timeout/circuit state, outbox/DLQ lag, job duration, lease/session count, payment state, buffering/startup theo source. Không log URL playback/cookie/token; metrics không gắn userId/movieId vào label gây cardinality lớn.
- Mục tiêu thử nghiệm ban đầu (chưa phải kết quả đo): API catalog cached p95 <500ms với 50 client đồng thời trên máy staging được ghi cấu hình; resolver ngoài budget 15s; heartbeat TTL 90s; stress progress theo 1 update/10–15s/session. Đo và điều chỉnh trước tuyên bố chịu tải production.

### 8.1. Kết quả rà soát thiết kế revision 2

| Vấn đề bản cũ | Quyết định sửa | Kiểm chứng khi triển khai |
|---|---|---|
| TODO dùng movies.source, backend dùng content_sources | Canonical movie + nhiều source + source_items | Một movie hai nguồn không trùng favorite/history |
| Episode null/COALESCE trong PK progress | playableId bắt buộc, PK profile/playable | Movie lẻ, episode, tua lại, update sai thứ tự |
| External video_assets/URL cache mâu thuẫn | video_assets chỉ owned, fresh resolver | Link thay đổi, không insert asset ngoài |
| GET tạo phiên và nhiều tên API | POST playback-sessions, hợp đồng camelCase | Contract/Gateway route tests |
| Streaming trước Profile/Payment, Gateway quá muộn | Đổi dependency order trong TODO | Mỗi giai đoạn có vertical slice dùng được |
| Metadata live search thiếu ID/phân trang chung | Import/sync metadata trước, public search local | Upsert ID ổn định, pagination, archive |
| Cache error làm khóa nguồn mãi | retryAfter + half-open recovery | Provider hồi phục sau timeout |
| CMS tự publish video.uploaded trước upload hoàn tất | Streaming verify completion + outbox | Complete thiếu file/lặp, worker restart |
| Signed master URL chưa bảo vệ segment | Media-edge policy bao phủ mọi file | Direct segment/origin bypass bị từ chối |
| Webhook unique đơn thuần/mock luôn true | Transaction/CAS/HMAC/idempotency | Trùng, cạnh tranh, sai tiền/chữ ký |
| Đếm progress thành lượt xem | qualified view unique session | Một session nhiều progress chỉ một view |
| CI/CD trước E2E và path filter bỏ sót libs | E2E trước deploy, dependency-aware checks | Thay shared lib/lockfile kích hoạt checks |

Các hợp đồng đã được đối chiếu ở mức tài liệu. G0–G4 hiện có code và bằng chứng tương ứng tại mục 8.2–8.5; các service business còn lại vẫn cần kiểm tra theo từng giai đoạn. Chưa có kết quả test tải hoặc chứng minh provider/CDN tương thích thật; các tiêu chí đó nằm trong TODO, không được đánh dấu hoàn thành chỉ vì đã viết thiết kế.

### 8.2. G0 implementation và bằng chứng nghiệm thu hiện tại

- Workspace pin Node 24.21.0 qua `.nvmrc`, NestJS 11.2.3, TypeORM 0.3.31, TypeScript 5.9.3 và dependency lockfile; tạo đủ chín app cùng năm thư viện. Các service chưa đến giai đoạn vẫn trả health/readiness; Auth và Profile đã có nghiệp vụ G1/G2, Gateway readiness phụ thuộc Auth.
- `shared-dto` cung cấp envelope, exception filter, request ID và health module; `shared-config` từ chối `NODE_ENV` thiếu/sai; `shared-kafka` cung cấp event contract, còn `content-provider` có client metadata KKPhim fixture-compatible và resolver playback riêng cho G5.
- Compose có ba profile, named volumes, cổng host bind loopback và healthcheck dịch vụ. PostgreSQL bootstrap tạo/tái sử dụng tám database/user; Kafka dùng `--if-not-exists`; MinIO tạo hai bucket riêng tư idempotent. Kafka dev một broker chỉ có replication factor 1.
- CI-equivalent trên Node 24.21.0: `npm ci`, lint, typecheck, build, unit tests, HTTP smoke cho Gateway + các service chưa đến giai đoạn, và các E2E theo từng giai đoạn đều pass. G0 smoke xác nhận startup, health/readiness, request ID, error envelope, Gateway fail-closed khi Auth không sẵn sàng và startup lỗi khi thiếu `NODE_ENV`; Catalog readiness/business được kiểm tra trong G3 E2E sau khi PostgreSQL đã sẵn sàng.
- PostgreSQL bootstrap đã tạo đủ tám database/user và chạy lại lần hai không lỗi trên cluster tạm PostgreSQL 16.15. Cluster tạm đã dừng; cluster hệ thống không bị thay đổi.
- Sau khi cài Docker Engine, Compose core được chạy lại ngày 2026-09-12: PostgreSQL 16.4, Redis 7.4.2 và Kafka 4.2.0 healthy; bootstrap tám DB/user và 14 topic chạy liên tiếp hai lượt thành công. Persistence sau restart đã được kiểm tra trong G0 acceptance trước đó. GitHub Actions hosted chưa được trigger vì worktree chưa push và xác thực `gh` không khả dụng; không ghi kết quả local thành CI remote.
- Host Node 26.7.0 không được dùng làm bằng chứng tương thích; toàn bộ code check và E2E ở đây chạy trong image Node 24.21.0.

### 8.3. G2 Profile core — implementation và bằng chứng local

- Profile migration `CreateProfileSchema1700000000001` tạo `profiles`, `profile_quotas`, `outbox_events`, check constraints, active-profile index, pending-outbox index và unique event per deleted profile; TypeORM `synchronize` tắt.
- Gateway expose GET/POST `/profiles` và PATCH/DELETE `/profiles/:profileId`. Guard JWT/Auth hiện hữu cung cấp session đã xác minh; proxy tự gắn service token và userId từ session. Profile DTO reject field dư, controller chỉ chấp nhận caller Gateway và luôn lọc theo `(userId, profileId)`.
- Tạo profile khóa quota row trong transaction; update khóa profile row; delete soft-delete và insert event envelope cùng transaction. Internal validate kiểm tra active + owner, trả `isKids`; CRUD chưa gọi Streaming hay Catalog.
- Profile outbox publisher claim batch bằng `FOR UPDATE SKIP LOCKED`, backoff lỗi Kafka, và đánh published sau producer ACK. Contract được kiểm tra khi broker tắt và sau khi Profile khởi động lại với Kafka.
- `smoke:profile-ci` pass trên PostgreSQL Compose: 6 concurrent POST cho 5×201 + 1×409; giả mạo `x-user-id` không đổi owner; user khác không list/sửa/xóa/validate được profile; thiếu internal token → 401; service ngoài allowlist → 403; deleted profile → validate 404; xóa lặp → 204 và đúng một outbox event.
- Outbox E2E xác nhận event còn unpublished và có retry/error khi Kafka không sẵn sàng, sau đó consumer thật nhận đúng `profile.deleted` khi Kafka hoạt động; row chỉ được đánh published sau ACK. E2E chạy lại migration và xác nhận không còn migration pending.
- Full local run trên Node 24.21.0: lint, typecheck, build, 4 unit tests, G0 HTTP smoke, G1 Auth E2E và G2 Profile E2E đều exit code 0. GitHub Actions workflow đã được thêm job `smoke:profile-ci` sau bootstrap core; remote result còn chờ push/trigger.

### 8.4. G3 Catalog hai nguồn và KKPhim — implementation và bằng chứng local

- Migration Catalog được áp dụng lên `catalog_db` PostgreSQL Compose. Schema tạo phim, taxonomy, seasons, playable items, owned/third-party content sources, source items, durable sync runs, audit log và outbox. CHECK/partial UNIQUE/composite FK bảo vệ rating `0..10`, playable kind, selector uniqueness và liên kết cùng movie; Catalog không tạo `video_assets`.
- Catalog có public list/search/detail/home qua Gateway và Admin APIs theo bảng mục 4.3. User/profileId đi qua Gateway JWT/session, Profile ownership validation và kids filtering; personalized responses là `no-store`, public response không mang profile state. Search G3 hiện dùng PostgreSQL `ILIKE` trên title/originTitle; OpenSearch và tìm kiếm tiếng Việt nâng cao thuộc G7.
- KKPhim provider client đọc fixture legacy và v1, chuẩn hóa phim lẻ/series, rating 10.0, hoạt hình và selector tập/special. Metadata projection chỉ giữ boolean `hasHls/hasEmbed`, không giữ URL phát; resolver playback là interface riêng để G5 gọi detail mới. Smoke live đọc-only ngày 2026-09-12 qua adapter thật đã parse được discovery/search/detail và resolve `external_hls`; smoke không lưu/in URL và không tải manifest/segment nên expiry/CDN compatibility vẫn chưa được chứng minh.
- Admin import/search/discovery/refresh và sync-run status đã được thêm. Job được lưu trong PostgreSQL, worker claim bằng lease/`SKIP LOCKED`, checkpoint theo trang/selector, reclaim lease hết hạn và bounded discovery. Upsert dùng provider external ID, slug thay được, không xóa bản ghi vì discovery vắng mặt, không merge theo tên. `metadata_locked` khóa trường biên tập nhưng vẫn cập nhật selector/availability; auto-publish không mở lại phim archived. Mapping source item kiểm tra cùng movie, giữ playable ID và ghi audit.
- Catalog outbox dùng producer Kafka và chỉ đánh `published_at` sau broker ACK. Public response, Catalog DB, checkpoint và event envelope được E2E kiểm tra không chứa fixture playback URLs. Owned source item mới tạo giữ `unknown`; trạng thái sẵn sàng do Streaming G6 xác nhận.
- Bằng chứng local trên Node `24.21.0` với PostgreSQL/Kafka Compose: `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:unit`, G0 HTTP smoke, G1 Auth E2E, G2 Profile E2E và `npm run smoke:catalog-ci` exit code 0. G3 E2E khởi động Auth/Gateway/Profile/Catalog thật, dùng KKPhim HTTP fixture offline và kiểm tra role, hai nguồn, mapping, profile/kids, lock/archive/slug, lease recovery/checkpoint, DB/public URL isolation và Kafka outbox ACK. GitHub Actions workflow gọi smoke Catalog sau bootstrap; kết quả hosted chưa được quan sát do cần push/trigger.

### 8.5. G4 Payment mock và entitlement — implementation và bằng chứng local

- Migration `CreatePaymentSchema1700000000004` tạo 9 bảng nghiệp vụ/hạ tầng: plans, purchase guards, subscriptions, payments, idempotency requests, webhook receipts, reminders, mock provider orders và outbox. CHECK constraints cùng unique partial indexes bảo vệ status, tiền tệ/giá, một pending/active subscription mỗi user, provider transaction và webhook event. Seed demo chạy idempotent ngoài production. `synchronize` không được bật.
- Payment service cung cấp plans, subscribe, current, webhook và internal entitlement; Gateway proxy nối các route public, JWT/session và `Idempotency-Key`. Webhook giữ nguyên raw bytes đến Payment. Internal entitlement chỉ nhận caller `streaming-service`; giá/tiền tệ/thời hạn/giới hạn được snapshot server-side; free limits cấu hình mặc định một stream/720p. Mock HMAC chỉ được bật ở development/test và startup production từ chối `PAYMENT_MOCK_ENABLED=true`.
- Mua gói khóa purchase guard theo user, so sánh request hash cho idempotency, tạo subscription/payment pending trong transaction rồi khởi tạo order mock sau commit. Webhook verify HMAC constant-time, ràng buộc provider/order/amount/currency, khóa state và receipt, CAS activation, không downgrade khi failed đến sau success, ghi transactional outbox; publisher chỉ đánh ACK sau khi Kafka xác nhận. Job chỉ đóng pending khi mock provider xác nhận failed/expired; hết hạn theo `endAt` được áp dụng trực tiếp lúc đọc entitlement, không phụ thuộc cron. Reminder ba ngày dedupe theo subscription/endAt/type.
- Late success sau khi payment/subscription đã đóng được lưu thành `reconciliation_required`, phát event riêng và không cấp entitlement chồng. Trạng thái này cần quy trình đối soát vận hành ở phase thanh toán provider thật; mock không thực hiện refund hoặc giao dịch tiền thật.
- Bằng chứng trên Node 24.21.0 với PostgreSQL/Kafka Compose: `npm run smoke:payment-ci` exit code 0. Smoke tạo DB PostgreSQL tạm mới, chạy migration từ đầu, xác nhận 9 bảng/seed/CHECK constraint rồi xóa DB probe. E2E khởi động Auth/Gateway/Payment thật; kiểm tra production mock guard, free và paid entitlement, idempotent retry/key conflict, hai key cạnh tranh, HMAC trên payload raw có whitespace, chữ ký/order/số tiền/provider sai, webhook đồng thời và trùng event, một lần activation, Kafka outbox ACK, snapshot giá/limits và endAt bất biến, expiry/reminder dedupe, cho mua lại sau khi active subscription hết hạn, pending timeout không tự coi là failed, provider-confirmed failure và late success reconciliation không kích hoạt. Hợp đồng request/response được ghi trong [payment-openapi.yaml](payment-openapi.yaml). Workflow gọi `smoke:payment-ci`; GitHub Actions hosted chưa được push/trigger, nên đây là bằng chứng local chứ không phải CI hosted.

Tham khảo kỹ thuật: [NestJS workspace](https://docs.nestjs.com/cli/monorepo), [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html), [TypeORM migrations](https://typeorm.io/docs/advanced-topics/migrations/), [Apache Kafka Docker image](https://kafka.apache.org/42/getting-started/docker/), [MinIO health probes](https://min.io/docs/minio/linux/operations/monitoring/healthcheck-probe.html), [OAuth refresh-token security](https://www.rfc-editor.org/rfc/rfc9700.html), [CloudFront signed cookies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-choosing-signed-urls-cookies.html). Các quyết định domain/TTL/thứ tự giai đoạn là thiết kế của dự án, không phải yêu cầu từ những tài liệu ngoài này.
