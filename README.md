# 📰 daily-wechat-brief · 每日资讯早报

每天自动抓取 **青岛天气（今日+一周）+ 中国新闻10条 + 科技新闻10条 + 全球大事10条**（均带摘要），通过 **SMTP 邮件** 发到你的邮箱。

全部免费：Open-Meteo（天气）+ 公开 RSS + GitHub Actions + 邮箱 SMTP。

---

## 快速开始

### 1. 配置邮箱 SMTP（以 QQ 邮箱为例）

1. 登录 [QQ 邮箱](https://mail.qq.com/) → **设置 → 账户**  
2. 找到 **POP3/IMAP/SMTP**，开启 **SMTP 服务**  
3. 按提示生成 **授权码**（不是 QQ 登录密码）  
4. 记下：邮箱地址 + 授权码

其他邮箱把 `SMTP_HOST` 改成对应地址即可，例如 163：`smtp.163.com`。

### 2. 本地试跑（可选）

```bash
cd D:\Learn\daily-wechat-brief
copy .env.example .env
# 编辑 .env，填入 SMTP_USER / SMTP_PASS / EMAIL_TO
```

PowerShell：

```powershell
$env:SMTP_HOST="smtp.qq.com"
$env:SMTP_PORT="465"
$env:SMTP_USER="你的QQ邮箱@qq.com"
$env:SMTP_PASS="授权码"
$env:EMAIL_TO="你的QQ邮箱@qq.com"
$env:CITY_NAME="青岛"
$env:LATITUDE="36.07"
$env:LONGITUDE="120.38"
node src/index.js
```

### 3. 推到 GitHub 开启定时

在仓库 **Settings → Secrets → Actions** 新建：

| Secret | 说明 |
|--------|------|
| `SMTP_USER` | 发件邮箱，如 `xxx@qq.com` |
| `SMTP_PASS` | SMTP 授权码 |
| `EMAIL_TO` | 收件邮箱（可填自己） |
| `SMTP_HOST` | 可选，默认代码里是 `smtp.qq.com`；建议也配上 |
| `SMTP_PORT` | 可选，默认 `465` |
| `EMAIL_FROM` | 可选，默认等于 `SMTP_USER` |

**Settings → Variables → Actions**（可选）：`CITY_NAME` / `LATITUDE` / `LONGITUDE`

到 **Actions** 页，打开 `Daily WeChat Brief`，点 **Run workflow** 手动测一次。

默认每天 **北京时间 08:30** 自动发送。

> 旧的 `WXPUSHER_SPT` / `PUSHPLUS_TOKEN` Secret 可删掉。

---

## 换城市

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
├── src/index.js                  # 抓取 + 拼装 + 发邮件
├── .env.example
├── package.json
└── README.md
```

无需安装依赖，Node 18+ 即可。

---

## 常见问题

**收不到邮件？**  
- 确认用的是 **授权码**，不是登录密码  
- QQ 邮箱必须先在网页开启 SMTP  
- 看 Actions / 本地日志是否 `邮件发送成功`  
- 检查垃圾箱

**想改发送时间？**  
改 `.github/workflows/daily.yml` 里的 cron（UTC）。例如北京 07:30 → `30 23 * * *`（前一天 UTC）。

**想加星座 / 汇率？**  
在 `src/index.js` 里加一个 `async function`，拼进 `buildContent` 即可。
