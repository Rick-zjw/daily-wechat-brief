/**
 * 每日微信早报
 * - 天气：Open-Meteo（免费免 key）
 * - 资讯：Hacker News Top + 少数派 RSS
 * - 推送：PushPlus → 个人微信
 */

const CITY_NAME = process.env.CITY_NAME || '上海'
const LATITUDE = process.env.LATITUDE || '31.23'
const LONGITUDE = process.env.LONGITUDE || '121.47'
const TIMEZONE = process.env.TIMEZONE || 'Asia/Shanghai'
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN

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

async function getWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=1`

  const data = await fetchJson(url)
  const cur = data.current
  const daily = data.daily
  const code = cur.weather_code
  const desc = WMO[code] || `天气代码 ${code}`

  return {
    desc,
    temp: Math.round(cur.temperature_2m),
    humidity: cur.relative_humidity_2m,
    wind: cur.wind_speed_10m,
    high: Math.round(daily.temperature_2m_max[0]),
    low: Math.round(daily.temperature_2m_min[0]),
    rainProb: daily.precipitation_probability_max[0]
  }
}

async function getHackerNews(limit = 5) {
  const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json')
  const top = ids.slice(0, limit)
  const items = await Promise.all(
    top.map(id => fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`))
  )
  return items
    .filter(Boolean)
    .map((item, i) => ({
      rank: i + 1,
      title: item.title,
      url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
      score: item.score
    }))
}

function parseRssItems(xml, limit = 5) {
  const items = []
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || []
  for (const block of blocks) {
    if (items.length >= limit) break
    const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) ||
      block.match(/<title>(.*?)<\/title>/i) || [])[1]
    const link = (block.match(/<link>(.*?)<\/link>/i) || [])[1]
    if (title && link) {
      items.push({
        title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
        url: link.trim()
      })
    }
  }
  return items
}

async function getSspai(limit = 5) {
  try {
    const xml = await fetchJson('https://sspai.com/feed')
    return parseRssItems(xml, limit)
  } catch (e) {
    console.warn('少数派 RSS 失败，跳过:', e.message)
    return []
  }
}

function todayLabel() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  }).format(new Date())
}

function buildContent({ weather, hn, sspai }) {
  const lines = []
  lines.push(`## 🌤 ${CITY_NAME}天气`)
  lines.push(
    `- 现在：**${weather.temp}°C** · ${weather.desc}`
  )
  lines.push(
    `- 今日：${weather.low}°C ~ ${weather.high}°C · 湿度 ${weather.humidity}% · 降水概率 ${weather.rainProb}% · 风速 ${weather.wind} km/h`
  )
  lines.push('')

  if (sspai.length) {
    lines.push('## 📱 少数派')
    sspai.forEach((item, i) => {
      lines.push(`${i + 1}. [${item.title}](${item.url})`)
    })
    lines.push('')
  }

  lines.push('## 🔥 Hacker News')
  hn.forEach(item => {
    lines.push(`${item.rank}. [${item.title}](${item.url}) （↑${item.score}）`)
  })
  lines.push('')
  lines.push('---')
  lines.push('_由 GitHub Actions 自动推送 · daily-wechat-brief_')

  return lines.join('\n')
}

async function pushToWechat(title, content) {
  if (!PUSHPLUS_TOKEN) {
    throw new Error('缺少 PUSHPLUS_TOKEN，请在 Secrets 或 .env 中配置')
  }

  const res = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: PUSHPLUS_TOKEN,
      title,
      content,
      template: 'markdown'
    })
  })

  const data = await res.json()
  if (data.code !== 200) {
    throw new Error(`PushPlus 失败: ${JSON.stringify(data)}`)
  }
  return data
}

async function main() {
  console.log('开始生成每日早报...')

  const [weather, hn, sspai] = await Promise.all([
    getWeather(),
    getHackerNews(5),
    getSspai(5)
  ])

  const title = `📰 每日早报 · ${todayLabel()}`
  const content = buildContent({ weather, hn, sspai })

  console.log('----- 预览 -----')
  console.log(title)
  console.log(content)
  console.log('---------------')

  const result = await pushToWechat(title, content)
  console.log('推送成功:', result)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
