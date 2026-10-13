# uep-squad-board

**UE 三人小队（我 / 月饼 / 邢锦）的团队看板 —— 组件仓（公开）。**

> ⚠️ 这个仓**只放组件**。团队数据在**私有仓** `skipperjames/niko-team-data` 的 `board.json`，靠 token 读写。

| 文件 | 用途 |
|---|---|
| `team.js` | 看板植入组件（NIKO / 任何页面一行 script 引入） |
| `index.html` | 本说明页（开启 Pages 后自动成为首页） |

## 怎么用

NIKO 里直接打开「🎮 团队看板」即可（切页自动加载组件，数据仓已写死指向 `niko-team-data`）。

独立页面用法：

```html
<div id="niko-team" data-me="a" data-repo="skipperjames/niko-team-data"></div>
<script src="https://skipperjames.github.io/uep-squad-board/team.js"></script>
```

- `data-me`：`me` = 我 · `a` = 月饼 · `b` = 邢锦
- `data-token`：数据仓的 fine-grained token（或页面里 ⚙️ 粘一次，只存本机 localStorage，不上云）
- `data-repo`：数据仓（不写则用 team.js 里的默认值，同样指向私有仓）

## 数据同步原理

- **卡片级三方合并**：按卡片 `id` 逐张比 `updatedAt`，新的赢 → 你改 A、同事改 B，互不覆盖
- **SHA 冲突自动重试**：PUT 撞车 → 重拉 + 重合并 + 重推
- **800ms 节流**：拖拽高频写入合并成一次推送
- **离线兜底**：localStorage 一直保留，云端挂了照常用
- **数据仓私有**：没配 token 只看到本机缓存 —— 这是刻意的，团队数据不公开

## 一次性设置（2026-10-13 已配好）

1. 本仓 **Public** + Pages（Source = `main` / `/ (root)`）— 已完成
2. 数据仓 `skipperjames/niko-team-data` **Private** — 已完成
3. Fine-grained token：只勾**数据仓**，Contents = Read and write — 已完成，三人共用一把
4. 各人把 token 粘进自己的页面 / NIKO 的 ⚙️ 同步设置 — 待各自做一次
