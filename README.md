# 📰 daily-wechat-brief · 每日微信早报

每天自动抓取 **天气 + 少数派 + Hacker News**，通过 [WxPusher](https://wxpusher.zjiecode.com/) 推送到**个人微信**。

全部免费：Open-Meteo（天气）+ 公开 API/RSS + GitHub Actions + WxPusher 永久免费额度。

---

## 快速开始

### 1. 获取 WxPusher SPT

1. 打开 https://wxpusher.zjiecode.com/  
2. 使用「极简推送 SPT」扫码，复制你的 **SPT**（形如 `SPT_xxx`）  
3. 可用网页测试发送，确认手机微信能收到

### 2. 本地试跑（可选）

```bash
cd D:\Learn\daily-wechat-brief
copy .env.example .env
# 编辑 .env，填入 WXPUSHER_SPT
```

PowerShell 临时注入环境变量再跑：

```powershell
$env:WXPUSHER_SPT="SPT_你的token"
$env:CITY_NAME="青岛"
$env:LATITUDE="36.07"
$env:LONGITUDE="120.38"
node src/index.js
```

### 3. 推到 GitHub 开启定时

```bash
cd D:\Learn\daily-wechat-brief
git init
git add .
git commit -m "feat: daily wechat brief bot"
# 在 GitHub 新建空仓库后：
git remote add origin https://github.com/<你的用户名>/daily-wechat-brief.git
git branch -M main
git push -u origin main
```

然后在仓库设置：

| 位置 | 配置 |
|------|------|
| **Settings → Secrets → Actions** | 新建 `WXPUSHER_SPT` = 你的 SPT |
| **Settings → Variables → Actions**（可选） | `CITY_NAME` / `LATITUDE` / `LONGITUDE` |

到 **Actions** 页，打开 `Daily WeChat Brief`，点 **Run workflow** 手动测一次。

默认每天 **北京时间 08:30** 自动推送。

> 若仓库里还留着旧的 `PUSHPLUS_TOKEN` Secret，可删掉，已不再使用。

---

## 换城市

在 Open-Meteo 或地图查经纬度，例如：

| 城市 | LATITUDE | LONGITUDE |
|------|----------|-----------|
| 青岛 | 36.07 | 120.38 |
| 上海 | 31.23 | 121.47 |
| 北京 | 39.90 | 116.41 |
| 深圳 | 22.54 | 114.06 |
| 杭州 | 30.27 | 120.15 |

填到仓库 Variables，或本地 `.env`。

---

## 项目结构

```text
daily-wechat-brief/
├── .github/workflows/daily.yml   # 定时任务
├── src/index.js                  # 抓取 + 拼装 + 推送
├── .env.example
├── package.json
└── README.md
```

无需安装依赖，Node 18+ 自带 `fetch`。

---

## 常见问题

**收不到消息？**  
- 确认已用微信扫码拿到 SPT，且 `WXPUSHER_SPT` 正确  
- 看 Actions 日志里是否 `推送成功`  
- 免费通道有频率限制，别短时间狂点

**想改推送时间？**  
改 `.github/workflows/daily.yml` 里的 cron（UTC）。例如北京 07:30 → `30 23 * * *`（前一天 UTC）。

**想加星座 / 汇率？**  
在 `src/index.js` 里加一个 `async function`，拼进 `buildContent` 即可。
