# RSS Sync Worker — Cloudflare 免费计划优化

- **状态**：实现中；等待 CI、生产配置核对和真实 Reeder 验证。
- **日期**：2026-09-19
- **目标**：减少无效 Queue/D1 用量与漏刷新风险；不更换现有 Cron → Queue → Worker → D1 架构。

## 基线与边界

只读快照：47 个有效订阅、1,763 篇文章、未读 28、D1 文件约 4.9 MiB；快照所处 UTC 日派发 348 条，**不是整日实际用量**。两条 RSS Cron（每五分钟派发与每天 UTC 03:17 维护）、每日预算 1,600、Queue 每批 1 条和并发 4 不变。账户层面 Cron 快照 4/5；其他 Worker 的消耗不可由 RSS 派发量反推。

免费计划的队列约 10,000 operations/day；小消息正常写入/消费/删除约 3 operations/条，1,600 条约 4,800 operations，**未包括重试、其他队列**。D1 每日行读写额度按实际 meta/平台统计核对，不能以 SQL 调用次数代替。

## 任务依赖（此前独立 to-tickets 编号）

- 01 基线与生产版本/配置核对 → 02 派发可靠性、03 生产认证与追踪。
- 02 → 04 无效 D1 写入、05 动态刷新；02/03 → 06 配额观测。
- 02–06 → 07 回归发布与回滚。
- 08 索引/CPU/存储、09 Cron 合并是**条件性**任务；没有证据或空闲名额需求时，不主动实施。

## 核心行为与实现要求

### 派发状态（02）

保留现有 `reserveDispatchSlot → claimDispatch → Queue.send`。未领取 token 时释放**原 UTC 日**已预留预算。若 `claimDispatch` 抛异常，领取是否已提交不确定，则保守保留预算和可能的 token，由派发期限恢复。调用 `Queue.send` 后的异常**不是拒收证明**：应记录 `delivery-uncertain`，不退款、不立即重复发送；消息可能已经进入 Queue。基于 dispatch token 检测重放与过期消息。Admin 手动刷新对该状态返回非成功（503）；Reader 不收到“已确认派发”的虚假提示。保留 at-least-once 语义，不声称 exactly-once。

### 刷新策略（05）

本次插入新文章 30 min；无新增且距上次变化 <24 h 为 60 min；安静 ≥24 h 且 <7 d 为 120 min；安静 ≥7 d 为 240 min。304 与 200/无新增一致，保留 ETag/Last-Modified。Feed 从未有新文章时使用首次成功 bootstrap 时间，不因每次 `last_success_at` 更新而永远停留在 60 min。失败沿用既有 15 min 起至 24 h 的退避。新订阅、手动刷新、取消/恢复订阅保持原行为。

### D1（04）

无重定向且候选字段已空时不写同值；重复标记 read/starred 不写状态行，不重置时间戳；仅更新变化的字段对应时间戳。成功心跳每分钟最多一次，失败及时写入。保留文章去重、已读/收藏隔离和仅删除超过 90 天且已读未收藏的清理策略。不添加索引，除非已比较真实 `rows_read/rows_written`、执行计划与业务结果。

### 凭证与调试（03）

Reader 和 Admin 均使用既有的 `USERNAME/PASSWORD`；Admin Bearer 与 Reader token 均使用 `PASSWORD`。不引入独立 Admin 密钥；密码缺失或空值必须拒绝认证。生产 `REEDER_TRACE=0`，兼容性抓包仅短时开启并及时恢复。

## 测试与放行（07）

`npm run check`（Biome、TypeScript、workerd-backed Vitest/D1、Wrangler dry-run）通过，包含：预算/未知发送、跨 UTC 日、304/200/错误与安静恢复、重复阅读状态、共享密码缺失或空值、重定向 alias、Reeder 订阅/列表/分页/未读/收藏/Logo 回归。对比一个完整 UTC 日的 Queue 实际 ops、D1 实际行读写、CPU p95/p99、错误和最老待刷新时间；缺失即标注“未验证”，不得虚构节省比例。

部署前核对最新 `main`、当前生产版本、所需 Secrets/Vars/Queue/D1/Cron，并保留回滚参考；仅在用户确认生产发布后再部署。优化存在兼容性回归时恢复旧代码或调度，不清空已有文章、未读、收藏或未确认消息。

## 非目标

升级付费计划；新增 KV/R2/Workflows/额外 Cron；重写 Reader/Miniflux 接口；提前实施 P2 索引或合并 Cron；隐式部署/修改生产凭证。

## 官方来源

- [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
