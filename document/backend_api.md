# API Backend cho Frontend MovieApp

Ngày đối chiếu: **2026-09-14**. Tài liệu này là contract tích hợp frontend với **API Gateway** của Backend hiện tại. Nó được tổng hợp từ controller/DTO Gateway, Catalog, Profile, Payment, Streaming và contract G9.

## 1. Quy ước chung

- Base URL local: `http://127.0.0.1:3000`.
- Frontend chỉ gọi Gateway. Không gọi trực tiếp các service ở cổng `3001`–`3009`, Kafka, Redis, PostgreSQL, MinIO hay OpenSearch.
- Request JSON dùng `Content-Type: application/json`; mọi UUID là chuỗi UUID chuẩn.
- Khi đã đăng nhập, gửi `Authorization: Bearer <accessToken>`. Gateway không dùng CORS credential/cookie để xác thực API; dùng bearer token.
- Gateway sinh `x-request-id` nếu client không có. UI có thể lưu giá trị `requestId` trong response lỗi để tra log.
- Response thành công, trừ `204 No Content` và JWKS, đều theo envelope:

```json
{
  "success": true,
  "data": {},
  "error": null,
  "requestId": "uuid"
}
```

- Response lỗi có cùng shape, `data: null`:

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "HTTP_400",
    "message": "Mô tả lỗi",
    "details": {}
  },
  "requestId": "uuid"
}
```

`details` là optional. Frontend nên hiển thị `error.message` cho người dùng và chỉ dùng `error.code` cho logic UI đã được đặc tả.

### Xử lý HTTP đáng chú ý

| Status | Ý nghĩa cho frontend |
|---|---|
| `200`, `201`, `202` | Đọc `data`. `202` nghĩa là job đã vào hàng đợi, chưa hoàn tất. |
| `204` | Thành công, không parse JSON. |
| `400` | Body/query/header không hợp lệ hoặc thiếu `Idempotency-Key`. |
| `401` | Token thiếu, hết hạn, refresh token không hợp lệ, hoặc profile không được xác thực. Thử refresh một lần rồi quay về login nếu thất bại. |
| `403` | Có token nhưng không có role `admin`/`content_manager`. |
| `404` | Đối tượng không tồn tại, đã archive, không thuộc profile/user, hoặc provider không có dữ liệu. |
| `409` | Xung đột trạng thái/idempotency/quota; không tự tạo request mới khi chưa hiểu `error.code`. |
| `422` | Dữ liệu hợp lệ về cấu trúc nhưng không dùng được, ví dụ source chưa sẵn sàng. |
| `429` | Rate limit Auth; dùng retry/backoff theo `Retry-After` nếu server trả header. |
| `503` | Dependency/provider tạm không khả dụng; cho phép retry giới hạn với GET, hoặc cùng idempotency key với POST idempotent. |

### Cache và CORS

- Catalog public không có `profileId`: `Cache-Control: public, max-age=300`.
- Catalog có `profileId`, tất cả Auth/Profile/Payment/Playback/Admin/Home: `Cache-Control: no-store`.
- CORS được giới hạn bởi `ALLOWED_ORIGINS` trong `Backend/.env`. Local demo dùng `http://localhost:8080`; thêm origin frontend thực tế trước khi chạy.

## 2. Kiểu dữ liệu dùng lặp lại

### Movie

```ts
type Movie = {
  id: string;
  title: string;
  originTitle: string | null;
  description: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  releaseYear: number | null;
  type: 'movie' | 'series';
  contentKind: 'film' | 'animation' | 'show';
  status: 'draft' | 'published' | 'archived';
  accessTier: 'free' | 'subscription';
  isKidsSafe: boolean;
  averageRating: number;
  publishedAt: string | null;
  version: string;
  createdAt: string;
  updatedAt: string;
};
```

Public API chỉ trả phim `published`. Metadata có thể null, vì provider không luôn cung cấp đủ thông tin. `posterUrl`/`backdropUrl` là URL ảnh, không phải media playback URL.

### Phân trang

```ts
type Page<T> = {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};
```

`page` bắt đầu từ 1; `pageSize` tối đa 50.

### Profile và playback selector

```ts
type Profile = {
  id: string;
  name: string;
  avatarId: number | null;
  isKids: boolean;
  createdAt: string;
  updatedAt: string;
};

type PlayableItem = {
  id: string;
  kind: 'movie' | 'episode';
  seasonId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  label: string;
  sortOrder: number;
  durationSeconds: number | null;
  archivedAt: null;
};

type SourceItem = {
  id: string;                 // content source ID
  sourceType: 'owned' | 'third_party';
  provider: string | null;    // ví dụ: "kkphim"
  sourceStatus: 'unknown' | 'available' | 'unavailable' | 'error';
  sourceItemId: string | null;
  playableId: string | null;
  serverKey: string | null;
  serverLabel: string | null;
  playbackMode: 'owned_hls' | 'external_hls' | 'external_embed' | 'metadata_only' | null;
};
```

`movieId`, `playableId`, `sourceItemId`, `profileId` là bốn ID bắt buộc khi tạo playback session. Không tự đoán chúng từ title, slug, URL hay thứ tự mảng.

## 3. Auth và session

Không cần bearer token cho `register`, `login`, `refresh`, `logout`, JWKS. Các endpoint Auth bị rate limit.

| Method / path | Body | `data` chính | Ghi chú UI |
|---|---|---|---|
| `POST /auth/register` | `{ email, password, fullName }` | `{ id, email, fullName, role }` | Password 12–128 ký tự. User mới có role `user`. |
| `POST /auth/login` | `{ email, password, deviceId, deviceName? }` | `TokenPair` | `deviceId` 1–128 ký tự, ổn định theo thiết bị/browser. |
| `POST /auth/refresh` | `{ refreshToken }` | `TokenPair` | Refresh token dùng một lần và được rotate. Nếu reuse, auth session bị revoke. |
| `POST /auth/logout` | `{ refreshToken }` | `204` | Xóa access/refresh token ở frontend sau khi thành công, hoặc ngay khi người dùng logout. |
| `GET /auth/session` | bearer | `{ active, userId, sessionId, role?, email?, fullName? }` | Dùng khi khôi phục app. |
| `GET /admin/session` | bearer, role admin/content_manager | Session hiện tại | Dùng để kiểm tra quyền CMS. |
| `GET /auth/.well-known/jwks.json` | — | JWKS raw JSON | Dành cho verifier, không cần app UI thông thường. |

```ts
type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // giây
  user: { id: string; email: string; fullName: string; role: 'user' | 'admin' | 'content_manager' };
};
```

Frontend nên đặt access token trong memory, không log token hoặc đưa token vào URL. Khi gặp `401`, gọi refresh một lần; nếu refresh không thành công thì xóa state đăng nhập và chuyển về login.

## 4. Profile, favorites và history

Tất cả route trong phần này yêu cầu bearer token. Backend xác định user từ token, không nhận `userId` từ frontend.

| Method / path | Body | `data` |
|---|---|---|
| `GET /profiles` | — | `Profile[]` |
| `POST /profiles` | `{ name, avatarId?, isKids? }` | `Profile` |
| `PATCH /profiles/:profileId` | Một hoặc nhiều trường `{ name?, avatarId?, isKids? }` | `Profile` |
| `DELETE /profiles/:profileId` | — | `204` |
| `GET /profiles/:profileId/favorites` | — | `{ items: Movie[] }` |
| `PUT /profiles/:profileId/favorites/:movieId` | — | `{ profileId, movieId, created }` |
| `DELETE /profiles/:profileId/favorites/:movieId` | — | `204` |
| `GET /profiles/:profileId/watch-history` | — | `{ items: HistoryItem[] }` |

Mỗi user có tối đa 5 profile active. `isKids: true` làm Catalog/Playback lọc phim không an toàn cho trẻ em.

```ts
type HistoryItem = {
  movieId: string;
  playableId: string;
  sourceItemId: string;
  positionSeconds: number;
  durationSeconds: number | null;
  updatedAt: string;
  movie: Movie | null;
  tombstone: boolean;
  // có thể kèm sessionOrdinal, seq từ streaming
};
```

Khi `tombstone: true`, giữ lịch sử nhưng không mở detail/phát phim đó. Mỗi phim chỉ có một `HistoryItem`: playable được xem gần nhất. Tập 1 và phim chỉ có một playable chỉ xuất hiện khi `durationSeconds` có giá trị và `positionSeconds / durationSeconds > 0.02`; tập khác không áp dụng ngưỡng này. Quy tắc chỉ lọc danh sách history/`continue_watching`, không xóa progress hoặc ngăn resume trực tiếp playable đó.

## 5. Catalog public

### Home catalog

`GET /catalog/home?pageSize=24`

Không cần login. `pageSize` 1–20, mặc định 20; job chỉ lưu tối đa 20 item cho mỗi section.

API này **không xếp hạng hoặc gợi ý trong lúc nhận request**. Nó chỉ đọc projection đã lưu sẵn trong Catalog database; mỗi section có tối đa 20 phim.

- Sau mỗi sync/import/refresh KKPhim hoàn tất, job làm mới `new_releases` (theo `external_updated_at` từ KKPhim, fallback thời điểm publish) và `ongoing_series` (series chưa hoàn tất).
- Khi Catalog khởi động và mỗi ngày lúc 00:00, job làm mới `trending`, 4 bảng theo quốc gia (`viet-nam`, `trung-quoc`, `han-quoc`, `nhat-ban`) và tất cả thể loại. Điểm xếp hạng cân bằng độ mới dữ liệu, lượt xem, lượt đánh giá và số sao do KKPhim trả về. Trường lượt xem/lượt đánh giá không có từ provider được lưu là `0`.

Response `data` là mảng section theo thứ tự hiển thị:

```ts
type CatalogHomeSection = {
  type: 'new_releases' | 'trending' | 'ongoing_series' | `country:${string}` | `genre:${string}`;
  name: string;
  items: Movie[];
};

type CatalogHome = CatalogHomeSection[];
```

Ví dụ:

```json
{
  "success": true,
  "data": [
    { "type": "new_releases", "name": "Mới phát hành", "items": [] },
    { "type": "trending", "name": "Top thịnh hành", "items": [] },
    { "type": "country:viet-nam", "name": "Top phim Việt Nam", "items": [] },
    { "type": "ongoing_series", "name": "Phim bộ đang chiếu", "items": [] },
    { "type": "genre:hanh-dong", "name": "Thể loại: Hành động", "items": [] }
  ]
}
```

### Browse và filter

`GET /catalog/genres`

Không cần đăng nhập. Response là `{ items: Array<{ slug: string; name: string }> }`, sắp xếp tăng dần theo tên thể loại. Dùng `slug` làm giá trị cho query `genre` của `/catalog/movies`.

`GET /catalog/countries`

Không cần đăng nhập. Response là `{ items: Array<{ slug: string; name: string }> }`, sắp xếp tăng dần theo tên quốc gia. Dùng `slug` làm giá trị cho query `country` của `/catalog/movies`.

`GET /catalog/movies`

Query optional: `page`, `pageSize`, `q`, `genre`, `country`, `year`, `type`, `contentKind`, `sourceType`, `provider`, `sort`, `profileId`.

| Query | Giá trị |
|---|---|
| `genre`, `country` | slug Catalog, tối đa 120 ký tự |
| `year` | 1800–2200 |
| `type` | `movie`, `series` |
| `contentKind` | `film`, `animation`, `show` |
| `sourceType` | `owned`, `third_party` |
| `provider` | ví dụ `kkphim` |
| `sort` | `newest` (mặc định), `rating`, `title` |
| `profileId` | UUID của profile đang chọn; phải gửi bearer token và áp dụng kids filter |

Response: `Page<Movie>`.

### Search

`GET /catalog/search?q=<text>&page=1&pageSize=24&profileId=<optional UUID>`

`q` tối đa 100 ký tự. Response: `Page<Movie>`. Search luôn chỉ tìm Catalog đã import; không tìm trực tiếp KKPhim.

### Detail và chọn nguồn phát

`GET /catalog/movies/:movieId?profileId=<optional UUID>`

Response là `Movie` cộng các trường:

```ts
type MovieDetail = Movie & {
  genres: Array<{ slug: string; name: string }>;
  countries: Array<{ slug: string; name: string }>;
  playableItems: PlayableItem[];
  sources: SourceItem[];
};
```

`SourceItem` không chứa `link_m3u8`, `link_embed`, external slug hay URL phát. UI chọn `playableId` và `sourceItemId` từ response này, sau đó gọi Playback API.

## 6. Home cá nhân hóa

`GET /home?profileId=:profileId` — yêu cầu bearer token và UUID profile hợp lệ.

```ts
type PersonalizedHome = {
  profileId: string;
  sections: Array<
    | { type: 'continue_watching'; items: HistoryItem[] }
    | { type: 'catalog_new_releases'; items: Movie[] }
    | { type: 'fallback_new_releases'; reason: 'recommendation_unavailable'; items: Movie[] }
    | { type: string; items: Movie[] }
  >;
};
```

Luôn render được `catalog_new_releases`. Recommendation là section tùy chọn; nếu service Recommendation không sẵn sàng, API vẫn trả fallback có `reason: "recommendation_unavailable"`.

## 7. Subscription và payment mock

| Method / path | Quyền / header | Body | `data` |
|---|---|---|---|
| `GET /subscriptions/plans` | public | — | `{ items: Plan[] }` |
| `POST /subscriptions/subscribe` | bearer + `Idempotency-Key` | `{ planId, paymentMethod }` | Payment order mock |
| `GET /subscriptions/current` | bearer | — | Subscription hiện tại hoặc `null` |
| `POST /payments/webhook/mock` | payment provider, raw body + `x-payment-signature` | Không gọi từ app | — |

```ts
type Plan = {
  id: string; name: string; price: number; currency: string;
  durationDays: number; maxConcurrentStreams: number;
  maxResolution: string; version: number;
};
```

```ts
type PaymentMethod = 'card' | 'wallet' | 'bank_transfer';
type PaymentStatus = 'pending' | 'success' | 'failed' | 'expired' | 'reconciliation_required' | 'refunded';

type PaymentOrder = {
  paymentId: string;
  orderId: string; // hiện bằng paymentId, giữ cả hai field theo response thật
  subscriptionId: string;
  status: PaymentStatus;
  paymentExpiresAt: string;
  amount: number;
  currency: string;
  paymentMethod: PaymentMethod;
  planSnapshot: {
    name: string;
    price: number;
    currency: string;
    durationDays: number;
    maxConcurrentStreams: number;
    maxResolution: string;
  };
  provider: { name: string; orderId: string; status: PaymentStatus };
  idempotentReplay: boolean;
  requestId: string;
};

type CurrentSubscription = {
  subscriptionId: string;
  status: 'pending' | 'active';
  startAt: string | null;
  endAt: string | null;
  autoRenew: false;
  plan: {
    name: string;
    price: number;
    currency: string;
    durationDays: number;
    maxConcurrentStreams: number;
    maxResolution: string;
  };
  payment: {
    paymentId: string;
    status: PaymentStatus;
    method: PaymentMethod;
    expiresAt: string;
    createdAt: string;
  };
};
```

`POST /subscriptions/subscribe` trả `201` với `data: PaymentOrder`. `GET /subscriptions/current` trả `200` với `data: CurrentSubscription | null`; chỉ subscription `pending` hoặc `active` và chưa hết hạn được trả, còn expired/cancelled trả `null`. UI chỉ coi gói đã dùng được khi `current.status === 'active'`; endpoint Entitlement nội bộ còn kiểm tra `endAt` ở backend. Payment provider hiện là mock: app chỉ poll `current`, không gọi webhook và không tự chuyển status sang `active`.

`paymentMethod` là `card`, `wallet` hoặc `bank_transfer`. `Idempotency-Key` phải dài 8–120 ký tự thuộc `[A-Za-z0-9._:-]`; giữ nguyên key khi retry đúng cùng payload. Payment hiện là mock, do đó app không tự gọi webhook hoặc giả lập thanh toán thành công.

## 8. Playback và progress

Tất cả route Playback yêu cầu bearer token. Playback session gắn với **auth session hiện tại** và profile; không dùng session ID giữa user/device khác.

### Tạo playback session

`POST /streaming/playback-sessions`

Headers bắt buộc:

```http
Authorization: Bearer <accessToken>
Idempotency-Key: <key-8-to-120-safe-characters>
Content-Type: application/json
```

Body:

```json
{
  "movieId": "uuid",
  "playableId": "uuid",
  "sourceItemId": "uuid",
  "profileId": "uuid"
}
```

Response `201`:

```ts
type PlaybackSession = {
  sessionId: string;
  playableId: string;
  sourceItemId: string;
  sourceType: 'owned' | 'third_party';
  protocol: 'hls';
  playbackUrl: string;
  mediaAuth: MediaAuth | null;
  drm: null;
  urlExpiresAt: string | null;
  leaseExpiresAt: string;
  resumePositionSeconds: number;
  resumeNeedsConfirmation: boolean;
  subtitles: string[];
  offlineSupported: false;
  idempotentReplay: boolean;
};

type MediaAuth = {
  cookieName: 'movie_media_auth';
  cookieValue: string;
  path: string;       // /media/assets/<assetId>/g<generation>/
  expiresAt: string;  // ISO-8601, thời điểm credential hết hạn
};

type PlaybackHeartbeat = {
  sessionId: string;
  leaseExpiresAt: string;
};

type WatchProgress = {
  profileId: string;
  playableId: string;
  movieId: string;
  sourceItemId: string;
  sessionOrdinal: string;
  seq: string;
  positionSeconds: number;
  durationSeconds: number | null;
  updatedAt: string;
};

type PlaybackProgressAck = {
  sessionId: string;
  accepted: true;
  applied: boolean;
  progress: WatchProgress | null;
};

type PlaybackEventAck = {
  sessionId: string;
  eventId: string;
  duplicate: boolean;
  state: 'reserved' | 'ready' | 'playing' | 'stopped' | 'failed' | 'expired';
  qualified: boolean;
};
```

- Dùng cùng key và cùng body để retry an toàn; API trả session đang active với `idempotentReplay: true`.
- Không dùng cùng key với body khác (`409 IDEMPOTENCY_KEY_REUSED`).
- Nếu `resumeNeedsConfirmation: true`, UI hỏi người dùng trước khi seek đến `resumePositionSeconds`.
- `external_hls` (KKPhim) trả URL từ resolver tại thời điểm gọi; không cache URL trong client dài hạn.
- `external_embed` hiện không được hỗ trợ phát, có thể trả `422 PLAYBACK_MODE_UNSUPPORTED`.
- Khi `CONCURRENT_STREAM_LIMIT`, không retry liên tục; đóng/đợi session cũ hoặc hiển thị thông báo quota.
- `subtitles` luôn là mảng URL chuỗi. Owned HLS hiện trả `[]`; external HLS chỉ trả các URL subtitle được backend kiểm tra hợp lệ. Chưa có metadata ngôn ngữ/nhãn/track để làm subtitle picker.

### Owned HLS và media auth cookie

Với `sourceType: "owned"`, Gateway chuyển tiếp `Set-Cookie` từ Streaming service và response cũng có `data.mediaAuth` đúng theo `MediaAuth` ở trên. Cookie là `HttpOnly`, có path giới hạn theo đúng asset/generation trên media-edge; JavaScript không đọc hoặc tự gắn giá trị này vào header. Chỉ để trình duyệt tự gửi cookie cho các request HLS phù hợp.

`POST /streaming/playback-sessions/:sessionId/media-auth` trả `200` với `data: MediaAuth` mới và đồng thời gửi `Set-Cookie` mới. Luôn lấy `expiresAt` từ response renew thành công để lập lịch renew kế tiếp; không dùng TTL cố định trong client. Endpoint này chỉ dùng khi `sourceType` là `owned`.

Hiện `Set-Cookie` **không có thuộc tính `Domain`**; đây là host-only cookie. Nó có `Path` đúng bằng `data.mediaAuth.path`, `HttpOnly`, `SameSite=Lax` và expiry bằng `expiresAt`. Cookie không phân biệt port: local mặc định Gateway `127.0.0.1:3000` và media-edge `127.0.0.1:8081` dùng cùng host nên cookie hợp lệ cho URL `/media/assets/...`. Nếu Gateway và media-edge dùng hostname khác nhau, cookie sẽ không được gửi sang media-edge; deployment đó cần dùng cùng hostname/reverse proxy hoặc thay đổi backend trước khi phát owned HLS.

Cấu hình Gateway hiện tại đặt CORS `credentials: false`. Vì vậy frontend web chạy khác origin (ví dụ `localhost:8080` gọi `127.0.0.1:3000`) **không thể dựa vào cookie cross-origin** để phát owned HLS. Khi làm frontend web production, đặt SPA, Gateway và media-edge sau cùng một origin/reverse proxy là cách tích hợp phù hợp với contract hiện tại. Nếu cần tách origin, phải thay đổi cấu hình CORS/cookie ở backend trước, rồi frontend dùng `fetch(..., { credentials: 'include' })`. Điều này không ảnh hưởng KKPhim/external HLS vì `mediaAuth` của nguồn đó là `null`.

### Trong lúc phát

| Method / path | Body | Cách dùng |
|---|---|---|
| `POST /streaming/playback-sessions/:sessionId/heartbeat` | — | Gửi khoảng 30 giây/lần để gia hạn lease. Response có `leaseExpiresAt`. |
| `POST /streaming/playback-sessions/:sessionId/progress` | `{ seq, positionSeconds, durationSeconds? }` | Gửi 10–15 giây/lần, thêm final progress trước stopped. `seq` là chuỗi số tăng dần. |
| `POST /streaming/playback-sessions/:sessionId/events` | `{ eventId, type, playedSeconds?, reasonCode? }` | Gửi lifecycle event. `eventId` là UUID idempotent. |
| `POST /streaming/playback-sessions/:sessionId/media-auth` | — | Chỉ cho owned HLS; external trả `422 MEDIA_AUTH_NOT_APPLICABLE`. |

`type` event: `started`, `qualified`, `failed`, `stopped`. `qualified` yêu cầu `playedSeconds >= 30`; `stopped`/`failed` giải phóng playback lease. `positionSeconds` không được vượt `durationSeconds` nếu duration có mặt. Progress cũ (`seq` nhỏ hơn hoặc bằng) trả `applied: false` và không ghi đè tiến độ mới.

Ví dụ progress:

```json
{ "seq": "17", "positionSeconds": 125, "durationSeconds": 7200 }
```

Response thành công của từng endpoint trong bảng, nằm bên trong envelope `data`, lần lượt là `PlaybackHeartbeat`, `PlaybackProgressAck`, `PlaybackEventAck` và `MediaAuth` đã định nghĩa ở trên. Không cần dùng `JsonElement` hoặc tự bỏ qua field response để tích hợp các route này.

## 9. Owned media — CMS/admin frontend

Các route sau yêu cầu role `admin` hoặc `content_manager` và bearer token.

| Method / path | Header / body | Kết quả |
|---|---|---|
| `POST /admin/videos/uploads` | `Idempotency-Key`; `{ sourceItemId, sizeBytes, checksumSha256 }` | `201`, trả `{ assetId, generation, uploadExpiresAt, uploadUrl, requiredHeaders, checksumAlgorithm }` |
| `POST /admin/videos/:assetId/upload-complete` | — | `200`, kiểm tra object upload và đưa transcode job vào queue |

`sourceItemId` phải thuộc source `owned` với `owned_hls`. Upload raw bytes trực tiếp vào `uploadUrl` bằng đúng `requiredHeaders`; frontend không upload video qua Gateway. Sau `upload-complete`, polling trạng thái asset chưa có public Gateway endpoint. CMS hiện cần nhận trạng thái qua API quản trị/bổ sung endpoint trước khi làm màn hình processing hoàn chỉnh.

## 10. Catalog CMS/admin

Tất cả route bên dưới yêu cầu role `admin` hoặc `content_manager`.

| Method / path | Body chính | Mục đích |
|---|---|---|
| `GET /admin/movies?page=&pageSize=&status=&q=` | `q` tối đa 100 ký tự, tìm không phân biệt hoa/thường trong `title` và `originTitle`; `status` optional. | `Page<Movie>` gồm draft/published/archived. |
| `GET /admin/movies/:movieId` | — | Chi tiết admin của movie ở mọi trạng thái, gồm genres, countries, playable items và source/source item metadata; không trả URL playback. |
| `POST /admin/movies` | `CreateMovie` | Tạo movie/series owned ở trạng thái draft. |
| `PATCH /admin/movies/:movieId` | Các field mutable của Movie | Sửa metadata. |
| `POST /admin/movies/:movieId/publish` | — | Publish khi có ít nhất một source item available. |
| `POST /admin/movies/:movieId/archive` | — | Archive, không còn public. |
| `POST /admin/movies/:movieId/seasons` | `{ seasonNumber, isSynthetic? }` | Tạo season cho series. |
| `POST /admin/movies/:movieId/playable-items` | `{ kind, seasonId?, episodeNumber?, label, sortOrder?, durationSeconds? }` | Tạo movie playable hoặc episode. |
| `POST /admin/movies/:movieId/content-sources` | `{ sourceType, provider?, externalId?, externalSlug?, metadataLocked? }` | Gắn owned hoặc third-party source. |
| `POST /admin/content-sources/:sourceId/items` | `{ playableId, serverKey, serverLabel, externalEpisodeKey?, externalEpisodeSlug?, playbackMode, sourceStatus? }` | Gắn server/selector vào playable. |
| `PATCH /admin/source-items/:sourceItemId` | `{ serverKey?, serverLabel?, externalEpisodeKey?, externalEpisodeSlug?, playableId? }` | Chỉnh mapping source item. |
| `PATCH /admin/content-sources/:sourceId/metadata-lock` | `{ locked }` | Khóa/mở cập nhật metadata provider. |

`CreateMovie` bắt buộc `{ title, type }`; `type` là `movie` hoặc `series`. Các enum/type/giới hạn chính lấy từ DTO trong source. Chi tiết schema đầy đủ nằm ở [catalog-openapi.yaml](catalog-openapi.yaml).

## 11. KKPhim CMS/admin

| Method / path | Body/query | Kết quả |
|---|---|---|
| `GET /admin/providers/kkphim/search?keyword=&page=` | keyword 1–100 ký tự | Dữ liệu tìm kiếm provider, không có URL playback. |
| `POST /admin/providers/kkphim/import` | `{ slug, movieId? }` | `202`, `{ syncRunId, status: 'queued' }`. Không có `movieId` thì tạo movie nội bộ. |
| `POST /admin/providers/kkphim/sync` | `{ mode?: 'discovery' | 'refresh', maxPages?: 1..10000 }` | `202`, sync run queued. With `discovery`, use `maxPages: 10000` to scan every page currently reported by KKPhim; the worker stops at the provider total. Provider 429/5xx errors requeue the same checkpoint after `CATALOG_SYNC_RETRY_MS`. |
| `GET /admin/providers/kkphim/sync-runs?page=&pageSize=` | — | `Page<SyncRun>`. |

```ts
type SyncRun = {
  id: string;
  provider: 'kkphim';
  mode: 'import' | 'discovery' | 'refresh';
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed';
  parameters: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  createdCount: number;
  updatedCount: number;
  errorCount: number;
  lastErrorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
};
```

Frontend phải poll `sync-runs` sau `202` cho tới `completed`, `partial` hoặc `failed`; không giả định import hoàn tất ngay. Chi tiết shape provider xem [kkphim-api.md](kkphim-api.md).

## 12. Luồng frontend đề xuất

### Khởi động và Home

1. Nếu có token, gọi `GET /auth/session`; nếu inactive hoặc `401`, refresh/login.
2. Gọi `GET /profiles`, để người dùng chọn profile active.
3. Home public: gọi `/catalog/home`; Home cá nhân hóa: gọi `/home?profileId=...` sau khi profile được chọn.
4. Dùng `/catalog/search` và `/catalog/movies` cho browse/filter. Dùng `profileId` khi cần kids filter.

### Xem phim

1. Gọi detail `/catalog/movies/:movieId?profileId=...`.
2. Người dùng chọn playable và server; chỉ cho chọn source có `sourceStatus` là `available` hoặc `unknown`.
3. Tạo UUID idempotency key, gọi `POST /streaming/playback-sessions`.
4. Nếu trả `resumePositionSeconds > 0`, seek hoặc hỏi xác nhận theo `resumeNeedsConfirmation`.
5. Nạp `playbackUrl` vào HLS player. Sau khi player bắt đầu, gửi event `started`.
6. Gửi progress/heartbeat theo chu kỳ. Với `qualified`, chỉ gửi khi thực tế đã phát ít nhất 30 giây.
7. Khi kết thúc, rời màn hình hoặc player error, gửi `stopped` hoặc `failed` với UUID event mới.

### Favorites và history

- Chỉ bật favorite khi đã có profile. `PUT`/`DELETE` là idempotent theo trạng thái cuối.
- Hiển thị history từ `GET /profiles/:profileId/watch-history`; skip item có `tombstone: true`.

## 13. Giới hạn contract hiện tại

- Frontend không gọi Notification/Recommendation service trực tiếp; chỉ đọc recommendation đã được Gateway ghép trong `/home`.
- Không có endpoint Gateway để CMS poll trạng thái owned transcode sau `upload-complete`; cần bổ sung contract nếu frontend CMS cần màn hình tiến trình transcode.
- Không có download/offline API. `offlineSupported` trong playback response hiện luôn `false`.
- `link_embed` của provider không dùng để phát trong contract hiện tại. Nếu chỉ có embed, backend trả `PLAYBACK_MODE_UNSUPPORTED`; không tự nhúng iframe/WebView.
- Playback URL của third-party là động. Không lưu vào database, cache dài hạn, router state, log hoặc analytics.
- Với web frontend tách origin, owned HLS chưa chạy được chỉ bằng API hiện tại do CORS không cho credential; dùng reverse proxy cùng origin hoặc hoàn thiện thay đổi CORS/cookie nêu ở phần Playback.

## 14. Tài liệu nguồn

- [g9-api-contract.md](g9-api-contract.md): phạm vi contract đã đối chiếu ở G9.
- [catalog-openapi.yaml](catalog-openapi.yaml): schema Catalog/Admin chi tiết.
- [payment-openapi.yaml](payment-openapi.yaml): schema Payment mock/webhook chi tiết.
- [kkphim-api.md](kkphim-api.md): mapping và luồng provider KKPhim.
- [backend-chi-tiet.md](backend-chi-tiet.md): kiến trúc và quy tắc backend.
