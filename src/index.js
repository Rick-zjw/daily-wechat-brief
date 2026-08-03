/**
 * 每日资讯早报
 * - 天气：Open-Meteo（今日 + 未来一周）
 * - 资讯：中国新闻 / 科技新闻 / 全球大事（RSS，含摘要）
 * - 格言：今日诗词 / 一言 API（中文；偶发英文会尝试翻译）
 * - 推送：SMTP 邮件（QQ / Gmail 等）
 */

import tls from 'node:tls'
import net from 'node:net'

const CITY_NAME = process.env.CITY_NAME || '青岛'
const LATITUDE = process.env.LATITUDE || '36.07'
const LONGITUDE = process.env.LONGITUDE || '120.38'
const TIMEZONE = process.env.TIMEZONE || 'Asia/Shanghai'

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.qq.com'
const SMTP_PORT = Number(process.env.SMTP_PORT || 465)
const SMTP_SECURE = process.env.SMTP_SECURE !== 'false' // 465 用 TLS，587 设为 false
// 本地若开了 Clash/代理导致证书校验失败，可设 SMTP_TLS_INSECURE=true
const SMTP_TLS_INSECURE = process.env.SMTP_TLS_INSECURE === 'true'
const SMTP_USER = process.env.SMTP_USER
const SMTP_PASS = process.env.SMTP_PASS
const EMAIL_TO = process.env.EMAIL_TO || SMTP_USER
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER

const WMO = {
  0: '晴',
  1: '主要晴朗',
  2: '局部多云',
  3: '阴天',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  95: '雷暴',
  96: '雷暴伴冰雹',
  99: '强雷暴伴冰雹'
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': 'daily-wechat-brief/1.0',
      Accept: 'application/json, text/xml, */*',
      ...(options.headers || {})
    }
  })
  if (!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`)
  const type = res.headers.get('content-type') || ''
  if (type.includes('json')) return res.json()
  return res.text()
}

function formatDayLabel(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`)
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIMEZONE,
    month: 'numeric',
    day: 'numeric',
    weekday: 'short'
  }).format(d)
}

async function getWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=7`

  const data = await fetchJson(url)
  const cur = data.current
  const daily = data.daily
  const code = cur.weather_code

  const week = daily.time.map((date, i) => ({
    date,
    label: formatDayLabel(date),
    desc: WMO[daily.weather_code[i]] || `天气代码 ${daily.weather_code[i]}`,
    high: Math.round(daily.temperature_2m_max[i]),
    low: Math.round(daily.temperature_2m_min[i]),
    rainProb: daily.precipitation_probability_max[i]
  }))

  return {
    today: {
      desc: WMO[code] || `天气代码 ${code}`,
      temp: Math.round(cur.temperature_2m),
      humidity: cur.relative_humidity_2m,
      wind: cur.wind_speed_10m,
      high: week[0].high,
      low: week[0].low,
      rainProb: week[0].rainProb
    },
    week
  }
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function stripHtml(html) {
  return decodeXmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateText(s, max = 200) {
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function extractTag(block, tag) {
  const cdata = block.match(
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i')
  )
  if (cdata) return cdata[1].trim()
  const normal = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return normal ? normal[1].trim() : ''
}

function extractLink(block) {
  const href = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i)
  if (href) return href[1].trim()
  const text = extractTag(block, 'link')
  if (text && /^https?:\/\//i.test(text)) return text
  const guid = extractTag(block, 'guid')
  if (guid && /^https?:\/\//i.test(guid)) return guid
  return ''
}

function parseRssItems(xml, limit = 10) {
  const items = []
  const blocks = [
    ...(xml.match(/<item[\s\S]*?<\/item>/gi) || []),
    ...(xml.match(/<entry[\s\S]*?<\/entry>/gi) || [])
  ]

  for (const block of blocks) {
    if (items.length >= limit) break
    const title = stripHtml(extractTag(block, 'title'))
    const url = extractLink(block)
    const rawSummary =
      extractTag(block, 'content:encoded') ||
      extractTag(block, 'description') ||
      extractTag(block, 'summary') ||
      extractTag(block, 'content') ||
      ''
    const summary = truncateText(stripHtml(rawSummary), 220)
    if (title && url) {
      items.push({ title, url, summary })
    }
  }
  return items
}

async function fetchRssFeed(url, limit = 10) {
  const xml = await fetchJson(url)
  return parseRssItems(xml, limit)
}

async function fetchNewsFromFeeds(feeds, limit = 10) {
  const collected = []
  const seen = new Set()

  for (const feed of feeds) {
    if (collected.length >= limit) break
    try {
      const items = await fetchRssFeed(feed, limit)
      for (const item of items) {
        const key = item.title.replace(/\s+/g, '').toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        collected.push(item)
        if (collected.length >= limit) break
      }
    } catch (e) {
      console.warn(`RSS 失败，跳过 ${feed}:`, e.message)
    }
  }
  return collected
}

// 中国新闻 / 科技 / 全球大事（多源兜底；国内源优先，保证本地和 Actions 都能抓到）
const FEEDS_CHINA = [
  'https://www.chinanews.com.cn/rss/china.xml',
  'https://www.chinanews.com.cn/rss/scroll-news.xml',
  'https://www.chinanews.com.cn/rss/importnews.xml',
  'https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans'
]

const FEEDS_TECH = [
  'https://36kr.com/feed',
  'https://www.solidot.org/index.rss',
  'https://www.ithome.com/rss/',
  'https://sspai.com/feed'
]

const FEEDS_WORLD = [
  'https://www.chinanews.com.cn/rss/world.xml',
  'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml',
  'https://news.google.com/rss/headlines/section/topic/WORLD?hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
  'https://feeds.bbci.co.uk/news/world/rss.xml'
]

function todayLabel() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  }).format(new Date())
}

// API 全挂时的中文兜底
const FALLBACK_QUOTES = [
  { text: '路漫漫其修远兮，吾将上下而求索。', author: '屈原《离骚》' },
  { text: '天行健，君子以自强不息。', author: '《周易》' },
  { text: '长风破浪会有时，直挂云帆济沧海。', author: '李白' },
  { text: '山重水复疑无路，柳暗花明又一村。', author: '陆游' },
  { text: '会当凌绝顶，一览众山小。', author: '杜甫' }
]

function isMostlyChinese(text) {
  const chars = String(text).replace(/\s/g, '')
  if (!chars) return false
  const cn = (chars.match(/[\u4e00-\u9fff]/g) || []).join('').length
  return cn / chars.length >= 0.5
}

async function translateToChinese(text) {
  // MyMemory 免费翻译（无需 key）；失败则返回原文
  try {
    const url =
      `https://api.mymemory.translated.net/get` +
      `?q=${encodeURIComponent(text)}&langpair=en|zh-CN`
    const data = await fetchJson(url)
    const translated = data?.responseData?.translatedText?.trim()
    if (translated && isMostlyChinese(translated)) return translated
  } catch (e) {
    console.warn('翻译失败，跳过:', e.message)
  }
  return null
}

async function fetchJinrishiciQuote() {
  const data = await fetchJson('https://v1.jinrishici.com/all.json')
  const text = String(data.content || '').trim()
  if (!text || !isMostlyChinese(text)) return null
  const author = [data.author, data.origin].filter(Boolean).join(' · ') || '古诗词'
  return { text, author }
}

async function fetchHitokotoQuote() {
  // i=诗词 d=文学 k=哲学 h=影视（多为中文）
  const data = await fetchJson('https://v1.hitokoto.cn/?c=i&c=d&c=k&c=h')
  let text = String(data.hitokoto || '').trim()
  if (!text) return null

  if (!isMostlyChinese(text)) {
    const translated = await translateToChinese(text)
    if (!translated) return null
    text = translated
  }

  const author = [data.from_who, data.from].filter(Boolean).join(' · ') || '一言'
  return { text, author }
}

async function getDailyQuote() {
  const fetchers = [fetchJinrishiciQuote, fetchHitokotoQuote, fetchJinrishiciQuote]
  for (const fetchQuote of fetchers) {
    try {
      const quote = await fetchQuote()
      if (quote?.text) return quote
    } catch (e) {
      console.warn('格言 API 失败:', e.message)
    }
  }
  const i = new Date().getDate() % FALLBACK_QUOTES.length
  return FALLBACK_QUOTES[i]
}

function renderNewsSection(title, items) {
  const lines = [`## ${title}`, '']
  if (!items.length) {
    lines.push('_暂无内容_')
    lines.push('')
    return lines
  }
  items.forEach((item, i) => {
    lines.push(`### ${i + 1}. [${item.title}](${item.url})`)
    if (item.summary) {
      lines.push(item.summary)
    } else {
      lines.push('_暂无摘要，点击标题查看原文_')
    }
    lines.push('')
  })
  return lines
}

function buildContent({ weather, china, tech, world, quote, dateText }) {
  const lines = []
  const { today, week } = weather

  lines.push(`_${dateText}_`)
  lines.push('')
  lines.push('## 💭 每日格言')
  lines.push(`> 「${quote.text}」`)
  lines.push(`> —— ${quote.author}`)
  lines.push('')

  lines.push(`## 🌤 ${CITY_NAME} · 今日天气`)
  lines.push(`- 现在：**${today.temp}°C** · ${today.desc}`)
  lines.push(
    `- 今日：${today.low}°C ~ ${today.high}°C · 湿度 ${today.humidity}% · 降水概率 ${today.rainProb}% · 风速 ${today.wind} km/h`
  )
  lines.push('')

  lines.push(`## 📅 ${CITY_NAME} · 未来一周`)
  week.forEach((d, i) => {
    const tag = i === 0 ? '今天' : d.label
    lines.push(
      `- **${tag}**：${d.desc} · ${d.low}°C ~ ${d.high}°C · 降水概率 ${d.rainProb}%`
    )
  })
  lines.push('')

  lines.push(...renderNewsSection('🇨🇳 中国新闻', china))
  lines.push(...renderNewsSection('💻 科技新闻', tech))
  lines.push(...renderNewsSection('🌍 全球大事', world))

  lines.push('---')
  lines.push('_由 GitHub Actions 自动发送 · daily-wechat-brief_')
  return lines.join('\n')
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inlineMd(s) {
  return escapeHtml(s)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
}

function markdownToHtml(md) {
  const lines = md.split('\n')
  const out = []
  let inList = false

  const closeList = () => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  for (const line of lines) {
    if (line.startsWith('### ')) {
      closeList()
      out.push(`<h3 style="margin:1.2em 0 0.35em;">${inlineMd(line.slice(4))}</h3>`)
    } else if (line.startsWith('## ')) {
      closeList()
      out.push(`<h2 style="margin-top:1.6em;border-bottom:1px solid #eee;padding-bottom:0.3em;">${inlineMd(line.slice(3))}</h2>`)
    } else if (line.startsWith('# ')) {
      closeList()
      out.push(`<h1>${inlineMd(line.slice(2))}</h1>`)
    } else if (line.startsWith('> ')) {
      closeList()
      out.push(
        `<blockquote style="margin:0.3em 0;padding:0.4em 0.9em;border-left:3px solid #ccc;color:#555;">${inlineMd(line.slice(2))}</blockquote>`
      )
    } else if (line.startsWith('- ')) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inlineMd(line.slice(2))}</li>`)
    } else if (line === '---') {
      closeList()
      out.push('<hr>')
    } else if (/^\d+\.\s+/.test(line)) {
      closeList()
      out.push(`<p>${inlineMd(line)}</p>`)
    } else if (line.trim() === '') {
      closeList()
    } else {
      closeList()
      out.push(`<p style="color:#444;margin:0.2em 0 0.8em;">${inlineMd(line)}</p>`)
    }
  }
  closeList()
  return out.join('\n')
}

function connectSmtp(host, port, secure) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({
          host,
          port,
          servername: host,
          rejectUnauthorized: !SMTP_TLS_INSECURE
        })
      : net.connect({ host, port })
    socket.setEncoding('utf8')
    socket._smtpBuf = ''
    socket.on('data', chunk => {
      socket._smtpBuf += chunk
      if (socket._smtpWait) {
        const wait = socket._smtpWait
        socket._smtpWait = null
        wait()
      }
    })
    socket.once('error', reject)
    socket.once(secure ? 'secureConnect' : 'connect', () => resolve(socket))
  })
}

function smtpResponseComplete(buf) {
  const lines = buf.split(/\r?\n/).filter(l => l.length > 0)
  if (!lines.length) return null
  const last = lines[lines.length - 1]
  if (/^\d{3} /.test(last)) return Number(last.slice(0, 3))
  return null
}

async function readSmtpResponse(socket) {
  for (;;) {
    const code = smtpResponseComplete(socket._smtpBuf)
    if (code !== null) {
      const raw = socket._smtpBuf
      socket._smtpBuf = ''
      return { code, raw }
    }
    await new Promise((resolve, reject) => {
      const onErr = err => reject(err)
      socket._smtpWait = () => {
        socket.off('error', onErr)
        resolve()
      }
      socket.once('error', onErr)
      if (smtpResponseComplete(socket._smtpBuf) !== null) {
        socket._smtpWait = null
        socket.off('error', onErr)
        resolve()
      }
    })
  }
}

async function smtpTalk(socket, cmd, codes) {
  if (cmd !== null) socket.write(cmd + '\r\n')
  const { code, raw } = await readSmtpResponse(socket)
  const allowed = Array.isArray(codes) ? codes : [codes]
  if (!allowed.includes(code)) {
    throw new Error(`SMTP 异常 ${code}: ${raw.trim()}`)
  }
  return raw
}

async function pushByEmail(subject, content) {
  if (!SMTP_USER || !SMTP_PASS) {
    throw new Error('缺少 SMTP_USER / SMTP_PASS，请在 Secrets 或 .env 中配置')
  }
  if (!EMAIL_TO) {
    throw new Error('缺少 EMAIL_TO，请在 Secrets 或 .env 中配置')
  }

  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;line-height:1.6;max-width:640px;margin:0 auto;padding:16px;">
${markdownToHtml(content)}
</body></html>`

  const boundary = `boundary_${Date.now()}`
  const mime = [
    `From: ${EMAIL_FROM}`,
    `To: ${EMAIL_TO}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(content, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
    ''
  ].join('\r\n')

  const socket = await connectSmtp(SMTP_HOST, SMTP_PORT, SMTP_SECURE)
  try {
    await smtpTalk(socket, null, 220)
    await smtpTalk(socket, 'EHLO localhost', 250)
    await smtpTalk(socket, 'AUTH LOGIN', 334)
    await smtpTalk(socket, Buffer.from(SMTP_USER).toString('base64'), 334)
    await smtpTalk(socket, Buffer.from(SMTP_PASS).toString('base64'), 235)
    await smtpTalk(socket, `MAIL FROM:<${SMTP_USER}>`, 250)
    await smtpTalk(socket, `RCPT TO:<${EMAIL_TO}>`, 250)
    await smtpTalk(socket, 'DATA', 354)
    socket.write(mime + '\r\n.\r\n')
    await smtpTalk(socket, null, 250)
    await smtpTalk(socket, 'QUIT', [221, 250])
  } finally {
    socket.end()
  }

  return { to: EMAIL_TO, subject }
}

async function main() {
  console.log('开始生成每日早报...')

  const [weather, china, tech, world, quote] = await Promise.all([
    getWeather(),
    fetchNewsFromFeeds(FEEDS_CHINA, 10),
    fetchNewsFromFeeds(FEEDS_TECH, 10),
    fetchNewsFromFeeds(FEEDS_WORLD, 10),
    getDailyQuote()
  ])

  console.log(
    `抓取完成：天气 ${weather.week.length} 天 · 中国 ${china.length} · 科技 ${tech.length} · 全球 ${world.length}`
  )

  const dateText = todayLabel()
  // 主题保留日期；正文不再重复大标题，以格言开场
  const subject = `Rick的每日早报 · ${dateText}`
  const content = buildContent({ weather, china, tech, world, quote, dateText })

  console.log('----- 预览 -----')
  console.log('主题:', subject)
  console.log('格言:', `「${quote.text}」—— ${quote.author}`)
  console.log(content)
  console.log('---------------')

  if (process.env.SKIP_EMAIL === '1') {
    console.log('已设置 SKIP_EMAIL=1，跳过发送邮件')
    return
  }

  const result = await pushByEmail(subject, content)
  console.log('邮件发送成功:', result)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
