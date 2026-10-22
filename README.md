# uep-squad-board

**UE 三人小队（我 / 月饼 / 邢锦）的团队看板 —— 组件仓（公开）。**

> ⚠️ 这个仓只放组件。团队数据在私有仓 `skipperjames/niko-team-data` 的 `board.json`，靠 token 读写。

| 文件 | 用途 |
|---|---|
| `team.js` | 看板植入组件（NIKO / 任何页面一行 script 引入） |
| `index.html` | 本说明页（开启 Pages 后自动成为首页） |

## 怎么用

NIKO 里直接打开「🎮 团队看板」即可。独立页面用法：

```html
<div id="niko-team" data-me="a" data-repo="skipperjames/niko-team-data"></div>
<script src="https://skipperjames.github.io/uep-squad-board/team.js"></script>
```

- `data-me`：`me` = 我 · `a` = 月饼 · `b` = 邢锦
- `data-token`：数据仓的 fine-grained token（或页面里点 ⚙️ 粘一次，只存在本机）
- `data-repo`：数据仓（不写则使用 team.js 默认值）

当前组件版本为 `v2.15.1-20261022`。游戏开发看板保留「任务看板」「BUG 追踪」「开发日志」三个核心页签；空的「里程碑」「工时统计」「资产流程」页签及其关联数据已移除。旧本地或云端快照中的三类集合、回收站记录、删除标记以及任务里的里程碑关联会在同步或加载时清理，不影响现有任务、BUG 和日志。

`v2.15.1` 修复了移除工时模块后，同步合并仍调用已删除函数而阻断拉取和上传的问题。保留原有字段合并、冲突暂停、SHA 重试和失败保留本机数据的处理。

同时修复任务删除确认前提前解除前置关联的问题：取消删除不改变任务或依赖，确认删除后才按原有流程解除关联并同步。

## 数据同步原理

- **卡片级三方合并**：按卡片 `id` 逐张比 `updatedAt`，新的赢 → 你改 A、同事改 B，互不覆盖
- **SHA 冲突自动重试**：PUT 撞车 → 重拉 + 重合并 + 重推
- **800ms 节流**：拖拽高频写入合并成一次推送
- **离线兜底**：localStorage 一直保留，云端挂了照常用
- **数据仓私有**：没配 token 只看到本机缓存

## 一次性设置（2026-10-13 已配好）

1. 本仓 **Public** + Pages（Source = `main` / `/ (root)`）
2. 数据仓 `skipperjames/niko-team-data` **Private**
3. Fine-grained token：只勾数据仓，Contents = Read and write
4. 各人把 token 粘进自己的页面 / NIKO 的 ⚙️ 同步设置
