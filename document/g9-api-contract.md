# Đối chiếu API G9

Ngày đối chiếu: **2026-09-13**. Đây là contract của backend MovieApp tại Gateway và các API nội bộ cần thiết cho service-to-service. Kiểm tra tự động nằm ở `test/g9-contract.mjs`; nó đọc source Gateway, OpenAPI Catalog/Payment, thiết kế backend và TODO.

| Nhóm | Gateway/public contract | Nguồn đối chiếu |
|---|---|---|
| Auth và profile | `/auth/*`, `/profiles`, favorites, watch-history | Controller Gateway, thiết kế backend mục 4.1/4.2 |
| Catalog | `/catalog/home`, `/catalog/movies`, `/catalog/search`, `/catalog/movies/:movieId`; Admin `/admin/movies`, source/item và provider import/sync | [catalog-openapi.yaml](catalog-openapi.yaml), Gateway Catalog controller |
| Playback | `POST /streaming/playback-sessions`, heartbeat, progress, events, media-auth; upload Admin | Gateway Streaming controller, thiết kế backend mục 4.4 |
| Payment | `/subscriptions/plans`, subscribe/current và `/payments/webhook/{provider}` | [payment-openapi.yaml](payment-openapi.yaml), Gateway Payment controller |
| Home | `GET /home?profileId=...` | Gateway Home controller, thiết kế backend mục 4.5 |

Các route nội bộ Catalog, Streaming, Payment, Notification và Recommendation không được thêm vào Gateway. Contract G9 kiểm tra route public/API documented nêu trên, token/caller boundary qua các E2E liên quan, và raw webhook bytes/HMAC bằng Payment E2E.

## KKPhim fixture reconciliation

Adapter được nghiệm thu bằng fixture cục bộ legacy/v1, gồm phim lẻ, series, server/tập/special, URL HLS, URL embed, đổi slug và metadata lock. Canonical ID dùng `_id`; slug chỉ là alias; đổi URL/server buộc resolver đọc detail mới và không tạo `video_assets` cho nguồn ngoài. E2E tải manifest/segment từ HTTPS fixture thay vì chỉ so chuỗi URL, sau đó kiểm tra progress, favorites/history, source archive/out-of-order và provider 503 recovery.

Fixture không đại diện cho SLA, quota, redirect hay CDN production của KKPhim. Không gọi Internet trong G9; smoke live và Android Media3 device test là công việc riêng khi có môi trường phù hợp.
