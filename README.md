# 📰 daily-wechat-brief · 每日资讯早/晚报

每天北京时间自动推送两封邮件：

| 场次 | 时间 | 内容 |
|------|------|------|
| **早报** | 08:00 | 问候 + 格言 · **历史上的今天** · **冷知识** · **金价** · 天气 · **明日技术名词** · **少数派/爱范儿** · 中国/科技/全球新闻各 **10** 条 |
| **晚报** | 18:00 | 问候 + 格言 · 天气速览 · **明日技术名词** · **HN / GitHub 热点 3 条** · 「今日新增」新闻各 **5** 条 |

全部免费：Open-Meteo、维基/公开接口、多源金价、RSS、GitHub Actions、邮箱 SMTP。

---

## 快速开始

### 1. 配置邮箱 SMTP

**Gmail（推荐）**

1. 开启 [两步验证](https://myaccount.google.com/signinoptions/two-step-verification)
2. 生成 [应用专用密码](https://myaccount.google.com/apppasswords)
3. 填入 `.env` 的 `SMTP_USER` / `SMTP_PASS`

**QQ 邮箱**

1. 登录 [QQ 邮箱](https://mail.qq.com/) → **设置 → 账户**
2. 开启 **SMTP 服务**，生成**授权码**（不是登录密码）

其他邮箱改 `SMTP_HOST` 即可，例如 163：`smtp.163.com`。

### 2. 本地试跑

```powershell
cd D:\Learn\daily-wechat-brief
copy .env.example .env
# 编辑 .env

$env:SKIP_EMAIL="1"
$env:BRIEF_SLOT="morning"   # 或 evening
node src/index.js
```

### 3. 推到 GitHub 开启定时

在仓库 **Settings → Secrets → Actions** 新建：`SMTP_USER` / `SMTP_PASS` / `EMAIL_TO`（以及可选的 `SMTP_HOST` 等）。

**Variables（可选）**：`CITY_NAME` / `LATITUDE` / `LONGITUDE`

Actions 里 `Daily WeChat Brief` 可手动跑，并选择 `auto` / `morning` / `evening`。

定时（UTC → 北京时间）：

- `0 0 * * *` → **08:00** 早报  
- `0 10 * * *` → **18:00** 晚报  

定时触发时 `BRIEF_SLOT=auto`，脚本按北京时间 12 点前后自动分早晚。

> 注意：GitHub Actions 的 `schedule` **只认默认分支 `main`**；本地改完需合并/推到 `main` 才会生效。定时任务也可能延迟几分钟到几十分钟。

---

## 换城市

| 城市 | LATITUDE | LONGITUDE |
|------|----------|-----------|
| 青岛 | 36.07 | 120.38 |
| 上海 | 31.23 | 121.47 |
| 北京 | 39.90 | 116.41 |
| 深圳 | 22.54 | 114.06 |
| 杭州 | 30.27 | 120.15 |

---

## 项目结构

```text
daily-wechat-brief/
├── .github/workflows/daily.yml
├── src/index.js
├── .env.example
├── package.json
└── README.md
```

Node 18+，无需安装依赖。

---

## 常见问题

**收不到邮件？** 用授权码/应用专用密码；看日志是否 `邮件发送成功`；检查垃圾箱。

**想改时间？** 改 `daily.yml` 的 cron（UTC）。

**本地对比早/晚：**

```powershell
$env:SKIP_EMAIL="1"
$env:BRIEF_SLOT="morning"; node src/index.js
$env:BRIEF_SLOT="evening"; node src/index.js
```
