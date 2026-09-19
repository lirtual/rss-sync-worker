# RSS 免费计划运行与发布手册

## 部署前核查

1. 确认 `main` 与线上 Worker 当前版本；检查是否存在 API 热修复/运行时变量覆盖。保留原部署版本及 D1 备份（若有迁移）。
2. 绑定：`DB` 指向现有 `rss-sync-worker` D1；`REFRESH_QUEUE` 指向 `rss-sync-refresh`；保持正式 Worker 名称和两条 Cron，不新增存储/付费资源。
3. 非敏感变量：`DAILY_DISPATCH_BUDGET=1600`、`REEDER_TRACE=0`。先确认 Cloudflare 控制台实际值；仓库配置不能证明线上已生效。
4. 敏感变量：仅使用已有 `USERNAME` 与 `PASSWORD`，Reader 和 Admin 共用非空 `PASSWORD`。不要新增独立的 Admin/Reader Secret；在 Cloudflare 只核对 Secret 是否存在，不读取、记录或提交其明文。
5. `npm run check` 与真实 Reeder 冒烟必须全部完成，再考虑生产部署；PR/CI 通过不代表线上已更新。

## 额度与故障信号

| 指标 | 来源 | 初始阈值 |
| --- | --- | --- |
| Cloudflare Queue operations（日，账户） | Dashboard/Usage | 达到 70% 或按当前速率预计越线 |
| D1 rows_read/rows_written（日，账户） | D1 usage 与单次结果 `meta` | 达到 70% |
| D1 数据库存储 | D1 dashboard | 超过 300 MB |
| 最早到期 Feed 延迟 | **低频** `/admin/status` | 超过 2h |
| Queue backlog 与 oldest age | Queue metrics | 连续 >15 分钟不能消化 |
| Worker CPU p95/p99、异常 | Workers Observability | 接近免费限值或出现 CPU 异常 |

`/health` 继续轻量，不接入按分钟执行全表 `/admin/status` 扫描的外部巡检。仅在已有监测系统确实接入、触发路径经过实测后才标注“自动告警”；否则上述阈值为人工监测操作目标。

## 派发错误说明

`delivery-uncertain` 意味着 Queue 发送响应缺失或报错，**不等于消息未被接受**。不要手动减预算、删除派发 token 或立即重发。观察 Queue 和 Feed 派发截止时间；如本日预算临近阈值，优先暂停重复人工刷新并调查；到期后允许正常 Cron 恢复。

## 发布后验证

对比完整 UTC 日（优先 24–48h）的实际行读写、Queue 操作、CPU p95/p99、刷新成功/失败和 Reeder 文章可见性。验证新订阅、手动刷新、取消订阅、未读、收藏、Logo、OPML；若出现停更或状态异常，恢复上一个版本并保持数据完整，不盲目删除 Queue 消息或 D1 表。

## 延后事项

P2 的索引/CPU 和双 Cron 合并只有在明确瓶颈与账户名额需求出现后单独实施；批量消费无法按比例降低按消息计量的队列操作费。
