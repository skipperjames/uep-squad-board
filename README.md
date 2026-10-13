# uep-squad-board

**UE 三人小队（我 / 阿泽 / 小满）的团队看板数据仓库。**

| 文件 | 用途 |
|---|---|
| `team.js` | 看板植入组件（同事一行 script 引入） |
| `board.json` | 团队数据（看板首次同步自动创建，无需手动建） |
| `index.html` | 本说明页（开启 Pages 后自动成为首页） |
| `_headers` | 让 board.json 可被跨域读取 |

## 同事怎么用（两行）

```html
<div id="niko-team" data-me="a"></div>
<script src="https://skipperjames.github.io/uep-squad-board/team.js"></script>
```

`data-me`：`me`=我 · `a`=阿泽 · `b`=小满

## 一次性设置

1. **公开**：Settings → General → 拉到底 → Change repository visibility → Public
2. **开启 Pages**：Settings → Pages → Source = `main` / `/ (root)` → Save
3. **建 token**：Fine-grained token，只勾本仓库，Contents = Read and write
4. **发 token** 给三人，填进 `data-token`

## 数据同步原理

- **卡片级三方合并**：按卡片 `id` 逐张比 `updatedAt`，新的赢 → 你改 A、同事改 B，互不覆盖
- **SHA 冲突自动重试**：PUT 撞车 → 重拉 + 重合并 + 重推
- **800ms 节流**：拖拽高频写入合并成一次推送
- **离线兜底**：localStorage 一直保留，云端挂了照常用
