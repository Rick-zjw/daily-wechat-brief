/**
 * 每日资讯早/晚报
 * - 开场：按星期 / 节日切换问候语（早/晚场文案不同）
 * - 天气：Open-Meteo（今日）
 * - 金价：国际现货金一句话（美元/盎司 + 折合人民币/克）
 * - 黄历：今日宜忌 + 今日/未来七天节日（国内 + 国外主要国家，含节气）
 * - 历史上的今天：免费中文接口（维基百科备用）
 * - 资讯：中国新闻 / 科技新闻 / 全球大事（RSS；早/晚场错开选取）
 * - 格言：今日诗词 / 一言 API（中文；偶发英文会尝试翻译）
 * - 推送：SMTP 邮件（北京时间 08:30 / 18:10 各一次）
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

function getDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]))
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day)
  }
}

function addDays(parts, n) {
  const dt = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + n))
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate()
  }
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatDayLabel(parts) {
  const d = new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 12))
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short'
  }).format(d)
}

function normalizeAlmanacItems(text) {
  if (!text) return ''
  return String(text)
    .replace(/[|｜.．、，,/／]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitFestivalText(text) {
  if (!text || /无数据|无/.test(text)) return []
  return String(text)
    .split(/[|｜\s、，,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => s !== '无数据' && s !== '无')
}

// 公历常见节日（国内 + 国际日/国外常见节，补全接口可能漏掉的小节日）
const SOLAR_FESTIVALS = {
  '01-01': ['元旦', '新年'],
  '01-06': ['主显节'],
  '01-10': ['中国人民警察节'],
  '01-25': ['罗伯特·彭斯之夜'],
  '02-02': ['世界湿地日', '土拨鼠日'],
  '02-14': ['情人节'],
  '03-03': ['全国爱耳日'],
  '03-05': ['学雷锋纪念日'],
  '03-08': ['国际妇女节'],
  '03-12': ['植树节'],
  '03-14': ['圆周率日', '白色情人节'],
  '03-15': ['国际消费者权益日'],
  '03-17': ['圣帕特里克节'],
  '03-21': ['世界森林日', '世界睡眠日', '世界诗歌日'],
  '03-22': ['世界水日'],
  '03-23': ['世界气象日'],
  '03-24': ['世界防治结核病日'],
  '04-01': ['愚人节'],
  '04-07': ['世界卫生日'],
  '04-22': ['世界地球日'],
  '04-23': ['世界读书日', '莎士比亚纪念日'],
  '04-26': ['世界知识产权日'],
  '05-01': ['劳动节'],
  '05-04': ['青年节', '星球大战日'],
  '05-05': ['墨西哥五日节'],
  '05-08': ['世界红十字日'],
  '05-12': ['国际护士节'],
  '05-15': ['国际家庭日'],
  '05-18': ['国际博物馆日'],
  '05-20': ['网络情人节'],
  '05-31': ['世界无烟日'],
  '06-01': ['儿童节'],
  '06-05': ['世界环境日'],
  '06-06': ['全国爱眼日', '瑞典国庆日'],
  '06-08': ['世界海洋日'],
  '06-12': ['俄罗斯国庆日'],
  '06-14': ['世界献血日', '美国国旗日'],
  '06-19': ['美国解放日'],
  '06-21': ['夏至', '国际瑜伽日', '世界音乐日'],
  '06-23': ['国际奥林匹克日'],
  '06-26': ['国际禁毒日'],
  '07-01': ['建党节', '香港回归纪念日', '加拿大国庆日'],
  '07-04': ['美国独立日'],
  '07-07': ['七七事变纪念日'],
  '07-11': ['世界人口日'],
  '07-14': ['法国国庆日'],
  '08-01': ['建军节', '瑞士国庆日'],
  '08-03': ['男人节'],
  '08-09': ['新加坡国庆日'],
  '08-12': ['国际青年日'],
  '08-15': ['日本宣布无条件投降日', '印度独立日', '韩国光复节'],
  '08-17': ['印度尼西亚独立日'],
  '08-19': ['中国医师节'],
  '08-26': ['全国律师咨询日'],
  '08-31': ['马来西亚独立日'],
  '09-03': ['中国人民抗日战争胜利纪念日'],
  '09-07': ['巴西独立日'],
  '09-10': ['教师节'],
  '09-11': ['美国爱国日'],
  '09-15': ['国际民主日'],
  '09-16': ['国际臭氧层保护日', '墨西哥独立日'],
  '09-18': ['九一八事变纪念日'],
  '09-20': ['全国爱牙日'],
  '09-21': ['国际和平日'],
  '09-27': ['世界旅游日'],
  '09-30': ['烈士纪念日'],
  '10-01': ['国庆节', '国际音乐日'],
  '10-03': ['德国统一日', '韩国开天节'],
  '10-04': ['世界动物日'],
  '10-05': ['世界教师日'],
  '10-09': ['世界邮政日'],
  '10-10': ['世界精神卫生日', '台湾双十节'],
  '10-12': ['西班牙国庆日', '哥伦布日'],
  '10-13': ['世界保健日'],
  '10-16': ['世界粮食日'],
  '10-17': ['国际消除贫困日'],
  '10-24': ['联合国日', '程序员节'],
  '10-26': ['奥地利国庆日'],
  '10-31': ['万圣节'],
  '11-01': ['万圣节翌日', '诸圣节'],
  '11-02': ['万灵节'],
  '11-05': ['英国烟火节'],
  '11-08': ['中国记者节'],
  '11-09': ['全国消防日'],
  '11-11': ['光棍节', '停战纪念日', '退伍军人节'],
  '11-17': ['国际大学生节'],
  '11-19': ['国际男人节'],
  '11-25': ['国际消除对妇女的暴力日'],
  '11-28': ['阿尔巴尼亚独立日'],
  '11-30': ['苏格兰圣安德鲁节'],
  '12-01': ['世界艾滋病日', '罗马尼亚国庆日'],
  '12-03': ['国际残疾人日'],
  '12-04': ['国家宪法日'],
  '12-06': ['芬兰独立日', '西班牙宪法日'],
  '12-10': ['世界人权日', '诺贝尔日'],
  '12-12': ['墨西哥圣母节'],
  '12-13': ['南京大屠杀死难者国家公祭日'],
  '12-16': ['巴林国庆日'],
  '12-18': ['卡塔尔国庆日'],
  '12-20': ['澳门回归纪念日'],
  '12-21': ['跨年日', '冬至'],
  '12-24': ['平安夜'],
  '12-25': ['圣诞节'],
  '12-26': ['节礼日']
}

// 主要国家法定假日（Nager.Date，含感恩节/复活节等不固定日期）
const FOREIGN_HOLIDAY_COUNTRIES = [
  ['US', '美国'],
  ['JP', '日本'],
  ['KR', '韩国'],
  ['GB', '英国'],
  ['FR', '法国'],
  ['DE', '德国'],
  ['CA', '加拿大'],
  ['AU', '澳大利亚'],
  ['IT', '意大利'],
  ['ES', '西班牙'],
  ['RU', '俄罗斯'],
  ['SG', '新加坡'],
  ['TH', '泰国'],
  ['IN', '印度'],
  ['BR', '巴西'],
  ['MX', '墨西哥'],
  ['NL', '荷兰'],
  ['SE', '瑞典'],
  ['NZ', '新西兰'],
  ['PH', '菲律宾']
]

const HOLIDAY_NAME_ZH = {
  "New Year's Day": '元旦',
  'New Year Holiday': '新年假期',
  'Coming of Age Day': '成人节',
  'Foundation Day': '建国纪念日',
  "The Emperor's Birthday": '天皇诞辰',
  'Vernal Equinox Day': '春分',
  'Shōwa Day': '昭和之日',
  'Constitution Memorial Day': '宪法纪念日',
  "Greenery Day": '绿之日',
  "Children's Day": '儿童节',
  'Marine Day': '海之日',
  'Mountain Day': '山之日',
  'Respect for the Aged Day': '敬老之日',
  'Autumnal Equinox Day': '秋分',
  'Sports Day': '体育之日',
  'Culture Day': '文化之日',
  "Labour Thanksgiving Day": '勤劳感谢之日',
  'Independence Movement Day': '三一节',
  "Buddha's Birthday": '佛诞',
  'Memorial Day': '阵亡将士纪念日',
  'Liberation Day': '光复节',
  'National Foundation Day': '开天节',
  'Hangul Day': '韩文日',
  'Christmas Day': '圣诞节',
  'Boxing Day': '节礼日',
  'Good Friday': '耶稣受难日',
  'Easter Sunday': '复活节',
  'Easter Monday': '复活节星期一',
  'Ascension Day': '耶稣升天节',
  'Whit Monday': '圣灵降临节翌日',
  'Corpus Christi': '基督圣体节',
  'Martin Luther King, Jr. Day': '马丁·路德·金纪念日',
  'Presidents Day': '总统日',
  "Washington's Birthday": '总统日',
  "Lincoln's Birthday": '林肯诞辰',
  'Independence Day': '独立日',
  'Labour Day': '劳动节',
  'Labor Day': '劳动节',
  'Columbus Day': '哥伦布日',
  'Veterans Day': '退伍军人节',
  'Thanksgiving Day': '感恩节',
  'Thanksgiving': '感恩节',
  "Saint Patrick's Day": '圣帕特里克节',
  "St. Patrick's Day": '圣帕特里克节',
  'Bastille Day': '法国国庆日',
  'German Unity Day': '德国统一日',
  'Canada Day': '加拿大国庆日',
  'Australia Day': '澳大利亚日',
  'ANZAC Day': '澳新军团日',
  "Queen's Birthday": '女王诞辰',
  "King's Birthday": '国王诞辰',
  'Remembrance Day': '停战纪念日',
  'Armistice Day': '停战纪念日',
  "All Saints' Day": '诸圣节',
  'Assumption Day': '圣母升天节',
  'Epiphany': '主显节',
  'Carnival': '狂欢节',
  'Republic Day': '共和国日',
  'Constitution Day': '宪法日',
  'National Day': '国庆日',
  'Unity Day': '统一日',
  'Freedom Day': '自由日',
  'Victory Day': '胜利日',
  'Defender of the Fatherland Day': '祖国保卫者日',
  "International Women's Day": '国际妇女节',
  'May Day': '劳动节',
  'Spring and Labour Day': '劳动节',
  'Russia Day': '俄罗斯日',
  'Day of National Unity': '民族团结日',
  'Cinco de Mayo': '墨西哥五日节',
  'Day of the Dead': '亡灵节',
  'Diwali': '排灯节',
  'Deepavali': '排灯节',
  Holī: '胡里节',
  Holi: '胡里节',
  Songkran: '泼水节',
  'Makha Bucha': '万佛节',
  'Visakha Bucha': '卫塞节',
  'Chinese New Year': '春节',
  'Hari Raya Puasa': '开斋节',
  'Hari Raya Haji': '古尔邦节',
  'Eid al-Fitr': '开斋节',
  'Eid al-Adha': '古尔邦节',
  'Vesak Day': '卫塞节',
  'Summer Bank Holiday': '夏季银行假日',
  'Spring Bank Holiday': '春季银行假日',
  'Early May Bank Holiday': '五月初银行假日',
  'Picnic Day': '野餐日',
  'Civic Holiday': '公民日',
  'Bank Holiday': '银行假日',
  'Public Holiday': '公共假日'
}

function translateHolidayName(name) {
  if (!name) return ''
  return HOLIDAY_NAME_ZH[name] || name
}

function dedupeFestivals(list) {
  const seen = new Set()
  const unique = []
  for (const name of list) {
    if (!name || seen.has(name)) continue
    seen.add(name)
    unique.push(name)
  }
  return unique
}

function formatForeignFestivals(items) {
  // items: [{ country, nameZh }]
  const byName = new Map()
  for (const { country, nameZh } of items) {
    if (!nameZh) continue
    if (!byName.has(nameZh)) byName.set(nameZh, [])
    const countries = byName.get(nameZh)
    if (!countries.includes(country)) countries.push(country)
  }
  return [...byName.entries()].map(([name, countries]) => {
    if (countries.length === 1) return `${countries[0]}·${name}`
    if (countries.length <= 4) return `${name}（${countries.join('、')}）`
    return `${name}（${countries.slice(0, 3).join('、')}等${countries.length}国）`
  })
}

async function fetchForeignHolidaysByDate(years) {
  const byDate = new Map() // YYYY-MM-DD -> [{ country, nameZh }]

  await Promise.all(
    FOREIGN_HOLIDAY_COUNTRIES.map(async ([code, countryZh]) => {
      for (const year of years) {
        try {
          const list = await fetchJson(
            `https://date.nager.at/api/v3/PublicHolidays/${year}/${code}`
          )
          if (!Array.isArray(list)) continue
          for (const h of list) {
            if (!h?.date || !h?.name) continue
            // 只要全国性节日，避免各省/州银行假日刷屏
            if (h.global === false) continue
            const nameZh = translateHolidayName(h.name)
            if (!byDate.has(h.date)) byDate.set(h.date, [])
            byDate.get(h.date).push({ country: countryZh, nameZh })
          }
        } catch (e) {
          console.warn(`国外节日失败 ${code}/${year}:`, e.message)
        }
      }
    })
  )

  return byDate
}

// 农历常见节日（按「月+日」中文，如 正月初一）
const LUNAR_FESTIVALS = {
  正月初一: ['春节'],
  正月初七: ['人日'],
  正月十五: ['元宵节'],
  二月初二: ['龙抬头'],
  二月十九: ['观音诞'],
  三月初三: ['上巳节'],
  四月初八: ['佛诞'],
  五月初五: ['端午节'],
  六月初六: ['天贶节', '姑姑节'],
  六月十九: ['观音成道'],
  六月廿四: ['关公诞'],
  七月初七: ['七夕节'],
  七月十五: ['中元节'],
  七月三十: ['地藏节'],
  八月十五: ['中秋节'],
  九月初九: ['重阳节'],
  十月初一: ['寒衣节'],
  十月十五: ['下元节'],
  腊月初八: ['腊八节'],
  腊月廿三: ['北方小年'],
  腊月廿四: ['南方小年'],
  腊月三十: ['除夕']
}

async function getWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=1`

  const data = await fetchJson(url)
  const cur = data.current
  const daily = data.daily
  const code = cur.weather_code

  return {
    today: {
      desc: WMO[code] || `天气代码 ${code}`,
      temp: Math.round(cur.temperature_2m),
      humidity: cur.relative_humidity_2m,
      wind: cur.wind_speed_10m,
      high: Math.round(daily.temperature_2m_max[0]),
      low: Math.round(daily.temperature_2m_min[0]),
      rainProb: daily.precipitation_probability_max[0]
    }
  }
}

async function fetchAlmanacDay(parts, foreignByDate = new Map()) {
  const sun = `${parts.y}-${parts.m}-${parts.d}`
  const date = `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`
  const json = await fetchJson(
    `https://www.36jxs.com/api/Commonweal/almanac?sun=${encodeURIComponent(sun)}`
  )
  if (!json?.data) throw new Error(`黄历接口无数据: ${sun}`)
  const data = json.data
  const lunarKey = `${data.LMonth || ''}${data.LDay || ''}`
  const mmdd = `${pad2(parts.m)}-${pad2(parts.d)}`
  const domestic = dedupeFestivals([
    ...splitFestivalText(data.GJie),
    ...splitFestivalText(data.LJie),
    ...splitFestivalText(data.SolarTermName),
    ...(SOLAR_FESTIVALS[mmdd] || []),
    ...(LUNAR_FESTIVALS[lunarKey] || [])
  ])
  const foreign = formatForeignFestivals(foreignByDate.get(date) || [])
  // 与国内条目去重：已有「圣诞节 / 新加坡国庆日」时，不再重复国外同名
  const domesticSet = new Set(domestic)
  const foreignUnique = foreign.filter(name => {
    if (domesticSet.has(name)) return false
    const bare = name.replace(/^[^·]+·/, '').replace(/（[^）]+）$/, '')
    if (domesticSet.has(bare)) return false
    const withCountry = name.match(/^(.+)·(.+)$/)
    if (withCountry) {
      const [, country, fest] = withCountry
      if (domesticSet.has(`${country}${fest}`)) return false
      if (domesticSet.has(`${fest}（${country}）`)) return false
    }
    return true
  })

  return {
    parts,
    date,
    label: formatDayLabel(parts),
    lunar: `${data.LMonth || ''}${data.LDay || ''}`.trim(),
    yi: normalizeAlmanacItems(data.Yi),
    ji: normalizeAlmanacItems(data.Ji),
    festivals: [...domestic, ...foreignUnique]
  }
}

async function fetchApihzToday() {
  // 接口盒子公共 ID/KEY 可能被限流；有自有密钥更稳
  const id = process.env.APIHZ_ID || '88888888'
  const key = process.env.APIHZ_KEY || '88888888'
  const json = await fetchJson(
    `https://cn.apihz.cn/api/time/getday.php?id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`
  )
  if (!json?.yi && !json?.ji) {
    throw new Error(json?.msg || '接口盒子黄历无宜忌数据')
  }
  return {
    yi: normalizeAlmanacItems(json.yi),
    ji: normalizeAlmanacItems(json.ji),
    lunar: `${json.nyue || ''}${json.nri || ''}`.trim(),
    festivals: [
      ...splitFestivalText(json.jieri),
      ...splitFestivalText(json.YIFESTIVAL),
      ...splitFestivalText(json.jieqi)
    ]
  }
}

async function getAlmanac() {
  const today = getDateParts()
  const days = []
  for (let i = 0; i < 8; i++) {
    days.push(addDays(today, i))
  }

  const years = [...new Set(days.map(d => d.y))]
  let foreignByDate = new Map()
  try {
    foreignByDate = await fetchForeignHolidaysByDate(years)
  } catch (e) {
    console.warn('国外节日总表获取失败:', e.message)
  }

  // 串行请求，避免公益接口被限流
  const results = []
  for (const parts of days) {
    try {
      results.push(await fetchAlmanacDay(parts, foreignByDate))
    } catch (e) {
      console.warn(`黄历失败 ${parts.y}-${parts.m}-${parts.d}:`, e.message)
      const date = `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`
      const domestic = [...(SOLAR_FESTIVALS[`${pad2(parts.m)}-${pad2(parts.d)}`] || [])]
      const foreign = formatForeignFestivals(foreignByDate.get(date) || [])
      results.push({
        parts,
        date,
        label: formatDayLabel(parts),
        lunar: '',
        yi: '',
        ji: '',
        festivals: dedupeFestivals([...domestic, ...foreign])
      })
    }
  }

  const todayInfo = results[0]

  // 今日宜忌优先用接口盒子（字段更贴近常见黄历文案）
  try {
    const apihz = await fetchApihzToday()
    if (apihz.yi) todayInfo.yi = apihz.yi
    if (apihz.ji) todayInfo.ji = apihz.ji
    if (apihz.lunar) todayInfo.lunar = apihz.lunar
    for (const name of apihz.festivals) {
      if (!todayInfo.festivals.includes(name)) todayInfo.festivals.push(name)
    }
  } catch (e) {
    console.warn('接口盒子黄历不可用，沿用备用源:', e.message)
  }

  const upcoming = results.slice(1)
    .map(d => ({
      date: d.date,
      label: d.label,
      lunar: d.lunar,
      festivals: d.festivals
    }))
    .filter(d => d.festivals.length > 0)

  return {
    yi: todayInfo.yi || '暂无',
    ji: todayInfo.ji || '暂无',
    lunar: todayInfo.lunar,
    todayFestivals: todayInfo.festivals,
    upcoming
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

/** 早报 / 晚报：可用 BRIEF_SLOT=morning|evening|auto 强制指定 */
function resolveBriefSlot() {
  const forced = String(process.env.BRIEF_SLOT || 'auto').toLowerCase()
  if (forced === 'morning' || forced === 'evening') return forced
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      hour: 'numeric',
      hour12: false
    }).format(new Date())
  )
  // 北京时间 12 点前算早报，之后算晚报
  return hour < 12 ? 'morning' : 'evening'
}

function feedsForSlot(feeds, slot) {
  // 晚场倒序优先，换一批源先入库，降低与早场撞车概率
  return slot === 'evening' ? [...feeds].reverse() : [...feeds]
}

/**
 * 同一批 RSS 池里，早/晚场交错取稿，避免两次推送标题一模一样。
 * morning: 偶数位；evening: 奇数位优先，不够再用剩余。
 */
function selectNewsForSlot(pool, slot, limit = 10) {
  if (!pool.length) return []
  if (slot === 'morning') {
    return pool.filter((_, i) => i % 2 === 0).slice(0, limit)
  }
  const odds = pool.filter((_, i) => i % 2 === 1)
  const evens = pool.filter((_, i) => i % 2 === 0)
  return [...odds, ...evens].slice(0, limit)
}

async function fetchNewsPool(feeds, poolSize = 28) {
  const collected = []
  const seen = new Set()
  // 每个源多抓一些，拼成更大候选池
  const perFeed = Math.max(8, Math.ceil(poolSize / Math.max(feeds.length, 1)) + 4)

  for (const feed of feeds) {
    if (collected.length >= poolSize) break
    try {
      const items = await fetchRssFeed(feed, perFeed)
      for (const item of items) {
        const key = item.title.replace(/\s+/g, '').toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        collected.push(item)
        if (collected.length >= poolSize) break
      }
    } catch (e) {
      console.warn(`RSS 失败，跳过 ${feed}:`, e.message)
    }
  }
  return collected
}

async function fetchNewsFromFeeds(feeds, limit = 10, slot = 'morning') {
  const pool = await fetchNewsPool(feedsForSlot(feeds, slot), Math.max(limit * 3, 28))
  return selectNewsForSlot(pool, slot, limit)
}

// 中国新闻 / 科技 / 全球大事（多源兜底；国内源优先，保证本地和 Actions 都能抓到）
const FEEDS_CHINA = [
  'https://www.chinanews.com.cn/rss/china.xml',
  'https://www.chinanews.com.cn/rss/scroll-news.xml',
  'https://www.chinanews.com.cn/rss/importnews.xml',
  'https://www.chinanews.com.cn/rss/finance.xml',
  'https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans'
]

const FEEDS_TECH = [
  'https://36kr.com/feed',
  'https://www.solidot.org/index.rss',
  'https://www.ithome.com/rss/',
  'https://sspai.com/feed',
  'https://www.geekpark.net/rss'
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

/** 北京时间星期：0=周日 … 6=周六 */
function getWeekdayIndex(date = new Date()) {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short'
  }).format(date)
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 0
}

// 节日开场优先于星期开场；命中 todayFestivals 中任意关键字即可
const FESTIVAL_GREETINGS = [
  { keys: ['春节', '大年初一'], morning: '春节快乐，新岁启程，万事顺意。', evening: '春节快乐，灯火团圆，今晚也要开心。' },
  { keys: ['除夕'], morning: '除夕将至，年味渐浓，记得给自己放个假。', evening: '除夕快乐，守岁团圆，愿岁岁平安。' },
  { keys: ['元宵节', '元宵'], morning: '元宵节快乐，汤圆甜一点，心情也甜一点。', evening: '元宵夜赏灯，记得抬头看看月亮。' },
  { keys: ['清明'], morning: '清明时节，适合走走停停，记得带把伞。', evening: '清明夜静，给惦念的人留一盏心灯。' },
  { keys: ['端午节', '端午'], morning: '端午节安康，粽香四溢，记得吃粽子。', evening: '端午安康，艾草清香，今晚也要好好休息。' },
  { keys: ['七夕'], morning: '七夕快乐，人间值得，也愿你被温柔以待。', evening: '七夕夜星河漫漫，愿有人陪你看月亮。' },
  { keys: ['中秋节', '中秋'], morning: '中秋快乐，愿月圆人也圆。', evening: '中秋夜月色正好，记得抬头看一眼。' },
  { keys: ['重阳'], morning: '重阳登高日，愿步步高升、安康顺意。', evening: '重阳夜，给长辈打个电话也很好。' },
  { keys: ['国庆节', '国庆'], morning: '国庆快乐，山河无恙，日子有光。', evening: '国庆假期愉快，今晚放松一下也不错。' },
  { keys: ['元旦', '新年'], morning: '元旦快乐，新的一年从今天开始发光。', evening: '元旦快乐，这一年，愿你被温柔接住。' },
  { keys: ['劳动节'], morning: '劳动节快乐，休息也是生产力。', evening: '劳动节快乐，今晚属于你自己。' },
  { keys: ['情人节', '网络情人节'], morning: '情人节快乐，爱自己也算数。', evening: '情人节快乐，今晚给喜欢的人留一句好话。' },
  { keys: ['圣诞节', '平安夜'], morning: '圣诞快乐，愿你被善意环绕。', evening: '平安夜里，愿你心安、梦甜。' },
  { keys: ['万圣节'], morning: '万圣节快乐，今天也可以小小地捣个蛋。', evening: '万圣夜到了，不给糖就捣蛋？' },
  { keys: ['愚人节'], morning: '愚人节快乐，今天多笑一点，少被骗一点。', evening: '愚人节收工，今晚真相只有一个：好好休息。' },
  { keys: ['男人节'], morning: '男人节快乐，今天也要善待自己。', evening: '男人节快乐，辛苦一天，记得给自己点赞。' },
  { keys: ['妇女节'], morning: '妇女节快乐，愿每个她都被世界温柔以待。', evening: '妇女节快乐，今晚花开给你。' },
  { keys: ['儿童节'], morning: '儿童节快乐，保留一点童心刚刚好。', evening: '儿童节快乐，今晚允许自己幼稚一点点。' },
  { keys: ['教师节'], morning: '教师节快乐，传道授业，向光而行。', evening: '教师节快乐，向所有照亮过你的人致敬。' },
  { keys: ['建军节'], morning: '八一建军节，致敬守护与担当。', evening: '建军节快乐，今晚也愿山河安宁。' },
  { keys: ['建党节'], morning: '七一纪念日，初心如磐，步履不停。', evening: '七一将尽，愿理想照进日常。' }
]

const WEEKDAY_GREETINGS = {
  morning: {
    0: '周日早上好，慢一点也没关系，享受周末尾声。',
    1: '周一加油，新的一周从好状态开始。',
    2: '周二继续推进，稳稳地往前走就好。',
    3: '周三了，一周过半，给自己一点小奖励。',
    4: '周四坚持住，胜利在望。',
    5: '周五快到了，收尾也是一种能力。',
    6: '周六早上好，把节奏交给自己。'
  },
  evening: {
    0: '周日晚报来了，明天又是新一周，今晚早些歇。',
    1: '周一收工了，给自己一点缓冲时间。',
    2: '周二晚上好，今天的事今天放下也行。',
    3: '周三夜，过半了，明天继续不慌不忙。',
    4: '周四晚上好，离周五只差一觉。',
    5: '周五晚上好，辛苦一周，周末你好。',
    6: '周六晚报，周末尚早，慢慢过。'
  }
}

function buildOpeningGreeting(slot, festivals = []) {
  const joined = festivals.join('、')
  for (const item of FESTIVAL_GREETINGS) {
    if (item.keys.some(k => joined.includes(k))) {
      return slot === 'evening' ? item.evening : item.morning
    }
  }
  const wd = getWeekdayIndex()
  const table = WEEKDAY_GREETINGS[slot] || WEEKDAY_GREETINGS.morning
  return table[wd] || table[1]
}

async function fetchHistoryFromXxapi() {
  const data = await fetchJson('https://v2.xxapi.cn/api/history')
  if (!Array.isArray(data?.data) || !data.data.length) return []
  return data.data
    .map(line => {
      const raw = String(line || '').trim()
      // 「2002年08月03日 事件」→ year + text
      const m = raw.match(/^(\d{1,4})年\d{1,2}月\d{1,2}日\s*(.+)$/)
      if (m) return { year: Number(m[1]), text: m[2].trim() }
      return raw ? { year: null, text: raw } : null
    })
    .filter(Boolean)
}

async function fetchHistoryFromWikipedia(parts) {
  const data = await fetchJson(
    `https://api.wikimedia.org/feed/v1/wikipedia/zh/onthisday/events/${parts.m}/${parts.d}`
  )
  if (!Array.isArray(data?.events)) return []
  return data.events
    .map(ev => ({
      year: ev.year ?? null,
      text: String(ev.text || '').trim()
    }))
    .filter(ev => ev.text)
}

async function getHistoryToday(limit = 4) {
  const parts = getDateParts()
  let events = []
  try {
    events = await fetchHistoryFromXxapi()
  } catch (e) {
    console.warn('历史上的今天主源失败:', e.message)
  }
  if (!events.length) {
    try {
      events = await fetchHistoryFromWikipedia(parts)
    } catch (e) {
      console.warn('历史上的今天维基备用失败:', e.message)
    }
  }

  // 优先近现代事件，再补足条数
  const scored = events
    .map(ev => ({
      ...ev,
      text: truncateText(ev.text, 90),
      _score: typeof ev.year === 'number' ? ev.year : 0
    }))
    .sort((a, b) => b._score - a._score)

  const picked = []
  const seen = new Set()
  for (const ev of scored) {
    const key = ev.text.replace(/\s+/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    picked.push({ year: ev.year, text: ev.text })
    if (picked.length >= limit) break
  }
  return picked
}

async function getGoldPrice() {
  // 国际现货金（美元/盎司）+ 美元兑人民币 → 折合元/克
  let usdPerOz = null
  let updatedAt = ''
  try {
    const gold = await fetchJson('https://api.gold-api.com/price/XAU')
    usdPerOz = Number(gold?.price)
    updatedAt = gold?.updatedAt || ''
    if (!Number.isFinite(usdPerOz) || usdPerOz <= 0) usdPerOz = null
  } catch (e) {
    console.warn('金价主源失败:', e.message)
  }

  if (usdPerOz == null) {
    try {
      const data = await fetchJson('https://mintedmetal.com/api/prices.json')
      usdPerOz = Number(data?.metals?.gold?.price)
      updatedAt = data?.updatedAt || ''
      if (!Number.isFinite(usdPerOz) || usdPerOz <= 0) usdPerOz = null
    } catch (e) {
      console.warn('金价备用源失败:', e.message)
    }
  }

  if (usdPerOz == null) return null

  let cnyPerUsd = null
  try {
    const fx = await fetchJson('https://api.frankfurter.app/latest?from=USD&to=CNY')
    cnyPerUsd = Number(fx?.rates?.CNY)
    if (!Number.isFinite(cnyPerUsd) || cnyPerUsd <= 0) cnyPerUsd = null
  } catch (e) {
    console.warn('汇率获取失败，仅展示美元金价:', e.message)
  }

  const TROY_OZ_GRAMS = 31.1034768
  const cnyPerGram =
    cnyPerUsd != null ? (usdPerOz * cnyPerUsd) / TROY_OZ_GRAMS : null

  return {
    usdPerOz,
    cnyPerGram,
    cnyPerUsd,
    updatedAt
  }
}

function formatGoldLine(gold) {
  if (!gold) return null
  const usd = gold.usdPerOz.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  })
  if (gold.cnyPerGram != null) {
    const cny = gold.cnyPerGram.toLocaleString('zh-CN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    })
    return `国际现货金约 **$${usd}/盎司** · 折合约 **¥${cny}/克**`
  }
  return `国际现货金约 **$${usd}/盎司**`
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

function buildContent({
  weather,
  almanac,
  china,
  tech,
  world,
  quote,
  dateText,
  greeting,
  history,
  gold
}) {
  const lines = []
  const { today } = weather

  lines.push(`_${dateText}_`)
  lines.push('')
  if (greeting) {
    lines.push(`> ${greeting}`)
    lines.push('')
  }

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

  const goldLine = formatGoldLine(gold)
  if (goldLine) {
    lines.push('## 💰 金价一瞥')
    lines.push(`- ${goldLine}`)
    lines.push('')
  }

  lines.push('## 📜 今日黄历')
  if (almanac.lunar) {
    lines.push(`- 农历：${almanac.lunar}`)
  }
  lines.push(`- 宜：${almanac.yi}`)
  lines.push(`- 忌：${almanac.ji}`)
  lines.push(
    `- 今日节日：${almanac.todayFestivals.length ? almanac.todayFestivals.join('、') : '无'}`
  )
  lines.push('')

  lines.push('## 🎉 未来七天节日')
  if (!almanac.upcoming.length) {
    lines.push('_未来七天暂无节日_')
  } else {
    for (const d of almanac.upcoming) {
      const lunar = d.lunar ? `（农历${d.lunar}）` : ''
      lines.push(`- **${d.label}**${lunar}：${d.festivals.join('、')}`)
    }
  }
  lines.push('')

  lines.push('## 📅 历史上的今天')
  if (!history?.length) {
    lines.push('_暂无条目_')
  } else {
    for (const ev of history) {
      const year = ev.year != null ? `**${ev.year}年** · ` : ''
      lines.push(`- ${year}${ev.text}`)
    }
  }
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
  const slot = resolveBriefSlot()
  const slotLabel = slot === 'morning' ? '早报' : '晚报'
  console.log(`开始生成每日${slotLabel}...（BRIEF_SLOT=${slot}）`)

  const [weather, almanac, china, tech, world, quote, history, gold] = await Promise.all([
    getWeather(),
    getAlmanac(),
    fetchNewsFromFeeds(FEEDS_CHINA, 10, slot),
    fetchNewsFromFeeds(FEEDS_TECH, 10, slot),
    fetchNewsFromFeeds(FEEDS_WORLD, 10, slot),
    getDailyQuote(),
    getHistoryToday(4),
    getGoldPrice()
  ])

  const greeting = buildOpeningGreeting(slot, almanac.todayFestivals)

  console.log(
    `抓取完成：${slotLabel} · 开场「${greeting}」· 宜「${almanac.yi}」· 今日节日 ${almanac.todayFestivals.length} · 历史 ${history.length} · 金价 ${gold ? `$${Math.round(gold.usdPerOz)}` : '无'} · 未来有节日 ${almanac.upcoming.length} 天 · 中国 ${china.length} · 科技 ${tech.length} · 全球 ${world.length}`
  )

  const dateText = todayLabel()
  // 主题保留日期；正文以开场问候 + 格言开篇
  const subject = `Rick的每日${slotLabel} · ${dateText}`
  const content = buildContent({
    weather,
    almanac,
    china,
    tech,
    world,
    quote,
    dateText,
    greeting,
    history,
    gold
  })

  console.log('----- 预览 -----')
  console.log('主题:', subject)
  console.log('场次:', slotLabel)
  console.log('开场:', greeting)
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
