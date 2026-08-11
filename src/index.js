/**
 * 每日资讯早/晚报
 * - 早报：问候 + 格言 + 历史上的今天 + 冷知识 + 金价 + 天气 + 技术名词 + 生活精选 + 新闻×10
 * - 晚报：问候 + 格言 + 天气速览 + 技术名词 + HN/GitHub 热点 + 今日新增新闻×5
 * - 推送：SMTP 邮件（北京时间 08:00 / 18:00）
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

/** 开场问候用的少量公历节日（不再依赖黄历接口） */
const GREETING_SOLAR = {
  '01-01': ['元旦', '新年'],
  '02-14': ['情人节'],
  '03-08': ['妇女节'],
  '04-01': ['愚人节'],
  '05-01': ['劳动节'],
  '05-04': ['青年节'],
  '05-20': ['网络情人节'],
  '06-01': ['儿童节'],
  '07-01': ['建党节'],
  '08-01': ['建军节'],
  '08-03': ['男人节'],
  '09-10': ['教师节'],
  '10-01': ['国庆节'],
  '10-31': ['万圣节'],
  '11-11': ['光棍节'],
  '12-24': ['平安夜'],
  '12-25': ['圣诞节']
}

function todayGreetingFestivals() {
  const { m, d } = getDateParts()
  return GREETING_SOLAR[`${pad2(m)}-${pad2(d)}`] || []
}

/** 每日一个技术名词（按「明天」日期轮换，早报预习、晚报复习） */
const TECH_TERMS = [
  { term: '耦合', en: 'Coupling', def: '模块之间互相依赖的程度。耦合越高，改 A 越容易牵连 B；设计上通常追求「高内聚、低耦合」。' },
  { term: '内聚', en: 'Cohesion', def: '一个模块内部职责有多「抱团」。内聚高意味着这个模块在做一件清晰的事，而不是大杂烩。' },
  { term: '接口', en: 'Interface', def: '约定「能做什么」，不规定「怎么做」。调用方只依赖约定，实现可以替换（HTTP API、TypeScript interface、Java interface 都是这个思想）。' },
  { term: '抽象', en: 'Abstraction', def: '隐藏细节、露出本质。好的抽象让你用更少概念完成更多事；坏的抽象则制造额外心智负担。' },
  { term: '封装', en: 'Encapsulation', def: '把数据与操作它的逻辑收在一起，并限制外部乱摸内部状态。目的是降低误用与牵一发动全身。' },
  { term: '重构', en: 'Refactoring', def: '在不改变对外行为的前提下，改善代码结构，让它更好读、更好改。重构不是加功能，而是还技术债。' },
  { term: '幂等', en: 'Idempotent', def: '同一操作执行一次和执行多次，效果相同。支付回调、重试请求特别依赖幂等，避免重复扣款。' },
  { term: '副作用', en: 'Side Effect', def: '函数除了返回值以外，还改了外部世界（写库、发请求、改全局变量）。副作用越多，越难测试与推理。' },
  { term: '纯函数', en: 'Pure Function', def: '同样输入永远得到同样输出，且无副作用。纯函数好测、好缓存，也更容易并行。' },
  { term: '不可变', en: 'Immutability', def: '数据创建后不再被修改，要改就生成新副本。能减少隐蔽共享状态带来的 bug。' },
  { term: '并发', en: 'Concurrency', def: '系统能同时推进多个任务（未必真在同一瞬间执行）。关键是任务切换与协调，不等于并行。' },
  { term: '并行', en: 'Parallelism', def: '多个任务在同一时刻真正一起跑（多核/多机）。并行是一种加速手段，并发是一种组织结构。' },
  { term: '竞态条件', en: 'Race Condition', def: '结果依赖不可控的执行时序。两个请求同时改同一余额，就可能写出「看起来随机」的错账。' },
  { term: '死锁', en: 'Deadlock', def: '多个持有者互相等待对方释放资源，于是永远等下去。常见于锁顺序不一致。' },
  { term: '乐观锁', en: 'Optimistic Locking', def: '先假设不冲突，提交时用版本号/条件更新检查；冲突就重试。读多写少时常比悲观锁更香。' },
  { term: '悲观锁', en: 'Pessimistic Locking', def: '先锁住再改，防止别人同时动同一行。冲突频繁时更稳，但吞吐可能变差。' },
  { term: '事务', en: 'Transaction', def: '一组操作要么全部成功，要么全部回滚。经典目标是 ACID：原子、一致、隔离、持久。' },
  { term: '最终一致性', en: 'Eventual Consistency', def: '不保证此刻处处相同，但保证在没有新更新后，副本们最终会一致。分布式系统常见取舍。' },
  { term: '缓存', en: 'Cache', def: '用更快的介质保存热点结果，换延迟。核心难题是失效：什么时候认为这份数据过期了？' },
  { term: '缓存击穿', en: 'Cache Breakdown', def: '热点 key 突然失效，大量请求打穿到数据库。常用互斥重建或逻辑过期缓解。' },
  { term: '缓存穿透', en: 'Cache Penetration', def: '查询根本不存在的数据，缓存与库都没有，每次都打到库。可用布隆过滤器或缓存空值。' },
  { term: '缓存雪崩', en: 'Cache Avalanche', def: '大量 key 同时过期或缓存整体宕机，流量洪峰打向后端。过期时间加抖动、多级缓存可减缓。' },
  { term: '负载均衡', en: 'Load Balancing', def: '把请求分摊到多台实例。算法有轮询、加权、最少连接等；还要考虑会话与健康检查。' },
  { term: '限流', en: 'Rate Limiting', def: '限制单位时间内的请求量，保护系统不被打垮。令牌桶、漏桶、滑动窗口都是常见实现。' },
  { term: '熔断', en: 'Circuit Breaker', def: '下游持续失败时，快速失败并暂停调用，避免雪崩；过一段时间再试探恢复。' },
  { term: '降级', en: 'Degradation', def: '系统吃紧时主动关掉非核心能力，保主流程可用。例如详情页先不展示推荐。' },
  { term: '重试', en: 'Retry', def: '失败后再试一次。必须配合退避与幂等，否则可能把故障放大成风暴。' },
  { term: '超时', en: 'Timeout', def: '等待超过阈值就放弃。没有超时的调用，会把故障无限传播给调用链上游。' },
  { term: '消息队列', en: 'Message Queue', def: '用异步传递解耦生产者与消费者，削峰填谷。要清楚至少一次 / 至多一次 / 恰好一次语义。' },
  { term: '事件驱动', en: 'Event-Driven', def: '组件通过事件通信，而不是直接互相调用。好处是解耦，代价是流程更难一眼看懂。' },
  { term: '领域驱动设计', en: 'DDD', def: '用业务语言建模，把复杂业务拆成限界上下文。核心不是图案，而是对齐业务与代码边界。' },
  { term: '单体', en: 'Monolith', def: '功能集中在一个可部署单元。简单场景 tar 很香；团队与规模上来后，发布与扩展会变痛。' },
  { term: '微服务', en: 'Microservices', def: '按业务能力拆成可独立部署的服务。换来自治与扩展，也换来分布式复杂性。' },
  { term: 'BFF', en: 'Backend for Frontend', def: '为特定前端（App/Web）定制的后端聚合层，减少前端拼装，也避免一个通用 API 伺候所有端。' },
  { term: '网关', en: 'API Gateway', def: '流量入口：鉴权、路由、限流、观测常放这里。它是边界，不该变成第二个单体。' },
  { term: 'REST', en: 'REST', def: '以资源与 HTTP 语义组织 API 的风格。好的 REST 强调清晰资源与统一接口，不只是「用了 JSON」。' },
  { term: 'RPC', en: 'Remote Procedure Call', def: '像调用本地函数一样调用远程服务。性能与强类型友好，但要处理网络失败与版本兼容。' },
  { term: 'GraphQL', en: 'GraphQL', def: '客户端声明需要哪些字段，服务端按需返回。减少 over-fetch，但要把复杂查询与缓存想清楚。' },
  { term: 'Webhook', en: 'Webhook', def: '对方有事件时主动回调你的 HTTP 接口。务必验签、幂等，并快速响应后异步处理。' },
  { term: 'CI/CD', en: 'CI/CD', def: '持续集成与持续交付/部署：自动构建测试，再可靠地发布。目标是让上线变成日常而非仪式。' },
  { term: '技术债', en: 'Technical Debt', def: '为了短期速度留下的结构代价。可以借，但要付利息——不还就会拖慢所有后续改动。' },
  { term: '观察性', en: 'Observability', def: '能否从输出推断系统内部状态。日志、指标、链路追踪是三件套，用来回答「为什么慢/为什么错」。' },
  { term: 'SLO', en: 'Service Level Objective', def: '服务承诺的可量化目标，如可用性 99.9%。没有 SLO，稳定性讨论容易变成感觉之争。' },
  { term: '错误预算', en: 'Error Budget', def: 'SLO 允许的失败额度。预算充足可加快发布；花光了就该优先稳，而不是继续堆功能。' },
  { term: '蓝绿部署', en: 'Blue-Green Deployment', def: '两套环境切换流量完成发布，出问题可快速切回。代价是资源占用更高。' },
  { term: '金丝雀发布', en: 'Canary Release', def: '先放一小部分真实流量验证新版本，再逐步放大。用真实用户当「矿工鸟」。' },
  { term: '特征开关', en: 'Feature Flag', def: '用配置控制功能开闭，让发布与放量解耦。也能做紧急止血，但要治理旗标膨胀。' },
  { term: '依赖注入', en: 'Dependency Injection', def: '不在内部 new 依赖，而从外部传入。便于替换实现与单测，是控制反转的一种常见形式。' },
  { term: '控制反转', en: 'IoC', def: '「谁调用谁」的控制权反转：框架调用你的代码，而不是你处处指挥框架。DI 是其常见手段。' },
  { term: '设计模式', en: 'Design Pattern', def: '可复用的设计经验命名。有用，但不要为了「看起来专业」硬套模式。' },
  { term: '反模式', en: 'Anti-Pattern', def: '看起来像解法、长期却制造麻烦的做法。例如上帝对象、复制粘贴编程、过度工程。' },
  { term: '上帝对象', en: 'God Object', def: '一个类知道/做了太多事。难测、难改、谁都不敢动——拆职责通常是出路。' },
  { term: '单一职责', en: 'SRP', def: '一个模块应该只有一个引起它变化的理由。不是「只能有一个函数」，而是变化原因要单一。' },
  { term: '开闭原则', en: 'OCP', def: '对扩展开放、对修改关闭。理想状态是加能力多靠新增代码，少去挖老代码的坑。' },
  { term: '里氏替换', en: 'LSP', def: '子类型必须能替换父类型而不破坏程序正确性。继承用错时最容易违反。' },
  { term: '接口隔离', en: 'ISP', def: '不要强迫调用方依赖它用不到的方法。小而专的接口，胜过大而全的「胖接口」。' },
  { term: '依赖倒置', en: 'DIP', def: '高层模块不要依赖低层实现，双方都依赖抽象。这是可测试与可替换的基础。' },
  { term: 'ORM', en: 'Object-Relational Mapping', def: '用对象操作映射到关系数据库。提升效率，但要懂 SQL，否则容易写出隐藏的性能陷阱。' },
  { term: 'N+1 查询', en: 'N+1 Query', def: '先查列表，再在循环里逐条查关联，导致 1+N 次查询。典型性能杀手，预加载可解。' },
  { term: '索引', en: 'Index', def: '加速查找的数据结构，但会增加写入成本与空间。没有银弹索引，要匹配真实查询模式。' },
  { term: '范式', en: 'Normalization', def: '减少数据冗余与更新异常的设计方法。过度范式化可能换来复杂 JOIN，需权衡。' },
  { term: '反范式', en: 'Denormalization', def: '故意保留冗余以换读取性能。适合读多写少，但要设计好同步与一致性策略。' },
  { term: '分库分表', en: 'Sharding', def: '把数据按规则拆到多个库/表。能扩展容量，却让事务、关联查询与运维复杂很多。' },
  { term: 'CQRS', en: 'Command Query Responsibility Segregation', def: '写模型与读模型分离。复杂领域里可读可写各自优化，但同步成本上升。' },
  { term: '事件溯源', en: 'Event Sourcing', def: '存事件流而非只存最终状态，状态可重放得到。审计友好，心智与存储成本更高。' },
  { term: 'Saga', en: 'Saga', def: '长流程分布式事务的一种模式：用一串本地事务 + 补偿动作，代替大而难的 XA。' },
  { term: '两阶段提交', en: '2PC', def: '协调者先准备再提交的分布式事务协议。一致性强，但阻塞与单点问题让它在高并发下吃力。' },
  { term: 'CAP', en: 'CAP Theorem', def: '分布式系统在分区发生时，一致性与可用性难以两全。工程上是取舍，不是三选二口号。' },
  { term: 'BASE', en: 'BASE', def: '基本可用、软状态、最终一致。对比 ACID，更贴近大规模互联网系统的现实约束。' },
  { term: 'TLS', en: 'Transport Layer Security', def: '传输层加密与身份校验，HTTPS 的基础。证书、握手、协议版本都会影响安全与性能。' },
  { term: 'OAuth', en: 'OAuth', def: '授权框架：让第三方在不拿到你密码的情况下，获得有限访问权限。常见于「用 GitHub 登录」。' },
  { term: 'JWT', en: 'JSON Web Token', def: '一种可验证的令牌格式，常用于无状态认证。好处是易扩展，风险是撤销与密钥管理。' },
  { term: 'XSS', en: 'Cross-Site Scripting', def: '把恶意脚本注入到页面，在他人浏览器执行。输入转义与 CSP 是基本防线。' },
  { term: 'CSRF', en: 'Cross-Site Request Forgery', def: '诱使已登录用户的浏览器发起非本意请求。SameSite Cookie、CSRF Token 可缓解。' },
  { term: 'SQL 注入', en: 'SQL Injection', def: '把用户输入拼进 SQL 从而篡改查询。参数化查询是正道，拼接字符串是悬崖。' },
  { term: '单元测试', en: 'Unit Test', def: '测最小可测单元，快且稳。好单元测试描述行为，而不是绑死实现细节。' },
  { term: '集成测试', en: 'Integration Test', def: '测多个真实部件协作（DB、HTTP、队列）。比单测慢，但能抓到「接线」问题。' },
  { term: '契约测试', en: 'Contract Test', def: '验证服务之间的接口约定是否被破坏。微服务里用来防止「我改了你崩了」。' },
  { term: '回归测试', en: 'Regression Test', def: '确保老功能没被新改动弄坏。自动化回归是敢重构的底气。' },
  { term: '代码异味', en: 'Code Smell', def: '不一定是 bug，但暗示设计可能有问题的信号：超长函数、重复逻辑、神秘命名等。' },
  { term: '结对编程', en: 'Pair Programming', def: '两人共用一台电脑协作。短期看似慢，常能换来更少缺陷与更快知识传递。' },
  { term: '代码评审', en: 'Code Review', def: '合并前同行检查。目标是共享质量与知识，而不是挑刺表演。' },
  { term: '语义化版本', en: 'SemVer', def: '主.次.修订：不兼容变更 / 兼容新功能 / 兼容修复。让依赖升级可预期。' },
  { term: '单体仓库', en: 'Monorepo', def: '多项目放一个仓库。利于统一工具链与原子跨库改动，也需要更强的工程约束。' },
  { term: '树摇', en: 'Tree Shaking', def: '打包时移除未使用的导出代码。前提是 ESM 与副作用边界清晰。' },
  { term: '懒加载', en: 'Lazy Loading', def: '用到再加载，降低首屏成本。路由拆分、图片占位都是常见形式。' },
  { term: '防抖', en: 'Debounce', def: '高频触发时只认「停下来之后」那一次。搜索输入框很适合。' },
  { term: '节流', en: 'Throttle', def: '固定间隔最多执行一次。滚动监听、按钮连点常用。' },
  { term: '虚拟列表', en: 'Virtualization', def: '只渲染可视区域附近的列表项。长列表性能优化利器。' },
  { term: 'SSR', en: 'Server-Side Rendering', def: '在服务器生成 HTML 再发给浏览器。利于首屏与 SEO，也带来服务端复杂度。' },
  { term: 'CSR', en: 'Client-Side Rendering', def: '浏览器下载 JS 后再渲染页面。交互灵活，首屏与 SEO 需要额外策略。' },
  { term: '水合', en: 'Hydration', def: 'SSR 出来的静态 HTML 被前端框架接管、绑定事件的过程。水合失败会表现为「点了没反应」。' },
  { term: 'WebSocket', en: 'WebSocket', def: '全双工长连接，适合聊天、协作、实时推送。要处理重连、心跳与背压。' },
  { term: 'SSE', en: 'Server-Sent Events', def: '服务器单向推流到浏览器。比 WebSocket 简单，适合通知与进度条。' },
  { term: 'CDN', en: 'Content Delivery Network', def: '把静态资源放到离用户更近的节点。降延迟，也要处理好缓存刷新。' },
  { term: 'DNS', en: 'Domain Name System', def: '把域名解析成 IP。看似基础设施，配置错误时能让你「全世界以为你挂了」。' },
  { term: '容器', en: 'Container', def: '把应用与依赖打包进一致运行环境。Docker 是代表；关键是可重复交付。' },
  { term: '编排', en: 'Orchestration', def: '管理大量容器的调度、自愈与发布。Kubernetes 是事实标准之一。' },
  { term: '基础设施即代码', en: 'IaC', def: '用代码描述服务器与网络配置，而不是点控制台。可评审、可回滚、可复制。' },
  { term: 'GitOps', en: 'GitOps', def: '以 Git 为真相来源驱动部署：仓库变更即期望状态。审计清晰，回滚也像 revert。' },
  { term: '左移', en: 'Shift Left', def: '把测试、安全、质量检查尽量提前到开发早期做，修复成本通常更低。' },
  { term: '右移', en: 'Shift Right', def: '在生产环境持续验证：监控、混沌工程、渐进发布。承认真实流量才是最终考场。' },
  { term: '混沌工程', en: 'Chaos Engineering', def: '主动注入故障，验证系统是否按预期降级。不是捣乱，而是有实验假设的演练。' },
  { term: '旁路缓存', en: 'Cache-Aside', def: '应用先读缓存，未命中再读库并回填。最常见缓存模式，失效策略要自己管。' },
  { term: '读写分离', en: 'Read/Write Splitting', def: '主库写、从库读以扩展读能力。必须处理复制延迟导致的「刚写完读不到」。' },
  { term: '连接池', en: 'Connection Pool', def: '复用数据库/HTTP 连接，避免频繁建连。池太小排队，池太大又压垮后端。' },
  { term: '背压', en: 'Backpressure', def: '下游处理不过来时，向上游传递「慢一点」的信号。没有背压，内存与延迟会爆炸。' },
  { term: '零拷贝', en: 'Zero-Copy', def: '减少数据在内存中的无谓复制，提升 I/O 性能。内核发送文件是经典场景。' },
  { term: '垃圾回收', en: 'Garbage Collection', def: '自动回收不再使用的内存。方便，但停顿与调优是运行时必须理解的成本。' },
  { term: '内存泄漏', en: 'Memory Leak', def: '不再需要的内存却无法释放。长时间运行服务会越来越慢直至 OOM。' },
  { term: '栈与堆', en: 'Stack vs Heap', def: '栈多用于函数调用与局部，堆用于动态分配。搞不清生命周期，就容易悬空或泄漏。' },
  { term: '时间复杂度', en: 'Time Complexity', def: '算法耗时随输入规模如何增长。O(n) 与 O(n²) 在数据变大时体感天差地别。' },
  { term: '空间复杂度', en: 'Space Complexity', def: '算法额外内存随输入如何增长。有时用空间换时间，有时正好相反。' },
  { term: '哈希', en: 'Hash', def: '把任意数据映射成固定长度摘要。用于字典、去重、校验；加密哈希还要求难逆推。' },
  { term: '盐', en: 'Salt', def: '哈希密码前加入的随机值，让相同密码也有不同摘要，抵御彩虹表。' },
  { term: '对称加密', en: 'Symmetric Encryption', def: '加解密用同一密钥。快，但密钥分发与保管是难点。' },
  { term: '非对称加密', en: 'Asymmetric Encryption', def: '公钥加密、私钥解密（或反过来做签名）。慢，常与对称加密搭配使用。' },
  { term: '数字签名', en: 'Digital Signature', def: '用私钥签名、公钥验签，证明「是谁说的」且「没被改过」。' },
  { term: '零信任', en: 'Zero Trust', def: '默认不信任内外网，持续验证身份与设备。边界防火墙不再是唯一防线。' },
  { term: '最小权限', en: 'Least Privilege', def: '只给完成工作所需的最少权限。泄露时爆炸半径更小。' },
  { term: '特性切换', en: 'Feature Toggle', def: '同特征开关：用开关控制功能曝光。发布更安全，也要定期清理死亡开关。' },
  { term: '约定优于配置', en: 'Convention over Configuration', def: '框架给合理默认，减少样板配置。效率高，但团队要共享同一套约定。' },
  { term: 'YAGNI', en: 'You Aren\'t Gonna Need It', def: '不要为「也许以后用得上」过度设计。真需要时再加，往往更准。' },
  { term: 'KISS', en: 'Keep It Simple, Stupid', def: '简单能用的方案优先。复杂系统最贵的往往不是写，而是理解与维护。' },
  { term: 'DRY', en: 'Don\'t Repeat Yourself', def: '避免知识重复。但过早抽象也可能更糟——重复三次再抽，有时更稳。' },
  { term: '关注点分离', en: 'Separation of Concerns', def: '不同的事放到不同的地方。UI、业务、存储搅在一起时，改动成本会指数上升。' }
]

function getTechTermForDate(parts) {
  // 用年积日做稳定轮换，避免随机导致早报晚报不一致
  const start = Date.UTC(parts.y, 0, 0)
  const now = Date.UTC(parts.y, parts.m - 1, parts.d)
  const dayOfYear = Math.round((now - start) / 86400000)
  const item = TECH_TERMS[((dayOfYear % TECH_TERMS.length) + TECH_TERMS.length) % TECH_TERMS.length]
  return {
    ...item,
    dateLabel: `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`
  }
}

/** 明天的技术名词（早报预习明天，晚报也可带上） */
function getTomorrowTechTerm() {
  const tomorrow = addDays(getDateParts(), 1)
  return getTechTermForDate(tomorrow)
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rsquo;/gi, '’')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
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

function formatYmd(parts) {
  return `${parts.y}${pad2(parts.m)}${pad2(parts.d)}`
}

function cleanXinwenTitle(title) {
  return String(title || '')
    .replace(/^\[视频\]/, '')
    .replace(/^完整版(?:\[视频\])?/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isXinwenFullEpisode(title) {
  const t = cleanXinwenTitle(title)
  return /《?新闻联播》?\s*\d{8}/.test(t) || /新闻联播.*19\s*:\s*00/.test(t)
}

function parseXinwenDayPage(html) {
  const items = []
  const re =
    /href="(https:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/VIDE[^"]+)"[^>]*(?:title|alt)="([^"]+)"/gi
  let m
  while ((m = re.exec(html))) {
    const url = m[1]
    const title = cleanXinwenTitle(m[2])
    if (!title || isXinwenFullEpisode(title)) continue
    items.push({ title, url })
  }
  const seen = new Set()
  return items.filter(it => {
    if (seen.has(it.url)) return false
    seen.add(it.url)
    return true
  })
}

function extractXinwenSummary(html) {
  const text = stripHtml(html)
  const main = text.match(
    /主要内容\s*(?:央视网消息\s*(?:[（(]新闻联播[）)])?\s*[：:]?\s*)?(.{40,500})/
  )
  if (main) return truncateText(main[1].trim(), 220)
  const brief = text.match(/视频简介\s*(.{20,400})/)
  if (brief) return truncateText(brief[1].trim(), 220)
  return ''
}

async function fetchXinwenItemSummary(url) {
  try {
    const html = await fetchJson(url, {
      headers: { Accept: 'text/html,*/*' }
    })
    if (typeof html !== 'string') return ''
    return extractXinwenSummary(html)
  } catch (e) {
    console.warn(`新闻联播条目摘要失败 ${url}:`, e.message)
    return ''
  }
}

/**
 * 抓取指定日期《新闻联播》分条目录（央视网栏目日页）。
 * 失败时向前再试几天，避免周末/延迟入库导致早报空白。
 */
async function fetchXinwenLianboList(daysBack = 1, lookback = 3) {
  const today = getDateParts()
  for (let i = daysBack; i <= daysBack + lookback - 1; i++) {
    const parts = addDays(today, -i)
    const ymd = formatYmd(parts)
    const pageUrl = `https://tv.cctv.com/lm/xwlb/day/${ymd}.shtml`
    try {
      const html = await fetchJson(pageUrl, {
        headers: { Accept: 'text/html,*/*' }
      })
      if (typeof html !== 'string') continue
      const items = parseXinwenDayPage(html)
      if (items.length) {
        return { dateLabel: `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`, ymd, items }
      }
      console.warn(`新闻联播 ${ymd} 日页无条目，继续回退`)
    } catch (e) {
      console.warn(`新闻联播日页失败 ${pageUrl}:`, e.message)
    }
  }
  return null
}

/**
 * 早/晚场错开取联播要点：早报取靠前，晚报优先取未在早报出现过的条目。
 */
function selectXinwenForSlot(items, slot, limit = 5) {
  if (!items.length) return []
  if (items.length <= limit) return items.slice(0, limit)
  if (slot === 'morning') return items.slice(0, limit)

  const morning = items.slice(0, limit)
  const morningUrls = new Set(morning.map(it => it.url))
  const rest = items.filter(it => !morningUrls.has(it.url))
  if (rest.length >= limit) return rest.slice(0, limit)
  if (rest.length) {
    // 条数不够时，用靠后条目补齐，再不够才回落到早报条目
    const need = limit - rest.length
    const tailFill = items.slice(-limit).filter(it => !rest.some(r => r.url === it.url))
    return [...rest, ...tailFill, ...morning].slice(0, limit)
  }
  const odds = items.filter((_, i) => i % 2 === 1)
  const evens = items.filter((_, i) => i % 2 === 0)
  return [...odds, ...evens].slice(0, limit)
}

async function enrichXinwenItems(items, dateLabel) {
  const summaries = await Promise.all(items.map(it => fetchXinwenItemSummary(it.url)))
  return items.map((it, i) => ({
    title: it.title,
    url: it.url,
    summary:
      summaries[i] ||
      truncateText(`《新闻联播》${dateLabel} 要点：${it.title}`, 220)
  }))
}

/** 中国新闻：前 5 条优先《新闻联播》，其余用 RSS 补齐；联播失败则全走 RSS */
async function fetchChinaNews(limit = 10, slot = 'morning') {
  const lianboCount = Math.min(5, limit)
  let head = []
  try {
    const lianbo = await fetchXinwenLianboList(1, 3)
    if (lianbo?.items?.length) {
      const picked = selectXinwenForSlot(lianbo.items, slot, lianboCount)
      head = await enrichXinwenItems(picked, lianbo.dateLabel)
      console.log(
        `新闻联播 ${lianbo.dateLabel}：目录 ${lianbo.items.length} 条，${slot === 'morning' ? '早报' : '晚报'}选用 ${head.length} 条`
      )
    } else {
      console.warn('新闻联播未取到条目，中国新闻前段回退为 RSS')
    }
  } catch (e) {
    console.warn('新闻联播抓取异常，回退 RSS:', e.message)
  }

  const restNeed = Math.max(0, limit - head.length)
  if (!restNeed) return head

  const headKeys = new Set(head.map(it => it.title.replace(/\s+/g, '').toLowerCase()))
  const rss = await fetchNewsFromFeeds(FEEDS_CHINA, Math.max(restNeed * 2, 12), slot)
  const rest = []
  for (const item of rss) {
    const key = item.title.replace(/\s+/g, '').toLowerCase()
    if (headKeys.has(key)) continue
    rest.push(item)
    if (rest.length >= restNeed) break
  }
  return [...head, ...rest]
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

function buildOpeningGreeting(slot) {
  const joined = todayGreetingFestivals().join('、')
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

async function getHistoryToday(limit = 5) {
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

async function tryGoldUsdPerOz(label, fn) {
  try {
    const usdPerOz = await fn()
    if (Number.isFinite(usdPerOz) && usdPerOz > 0) return usdPerOz
  } catch (e) {
    console.warn(`金价源失败（${label}）:`, e.message)
  }
  return null
}

async function getGoldPrice() {
  // 多源兜底：任一返回美元/盎司即可；再折算人民币/克
  const usdPerOz =
    (await tryGoldUsdPerOz('gold-api.com', async () => {
      const gold = await fetchJson('https://api.gold-api.com/price/XAU')
      return Number(gold?.price)
    })) ||
    (await tryGoldUsdPerOz('goldprice.dev', async () => {
      const data = await fetchJson(
        'https://api.goldprice.dev/v1/prices?symbol=XAU-USD-SPOT'
      )
      return Number(data?.price ?? data?.data?.price ?? data?.rates?.XAU)
    })) ||
    (await tryGoldUsdPerOz('mintedmetal', async () => {
      const data = await fetchJson('https://mintedmetal.com/api/prices.json')
      return Number(data?.metals?.gold?.price)
    })) ||
    (await tryGoldUsdPerOz('croncopia', async () => {
      const data = await fetchJson(
        'https://cdn.jsdelivr.net/gh/croncopia/commodity-prices/latest/metals/gold.json'
      )
      return Number(data?.price?.troy_ounce ?? data?.price)
    })) ||
    (await tryGoldUsdPerOz('aurumrates', async () => {
      const data = await fetchJson('https://aurumrates.com/api/v1/spot')
      return Number(data?.data?.gold?.price)
    })) ||
    (await tryGoldUsdPerOz('goldprice.org', async () => {
      const data = await fetchJson('https://data-asg.goldprice.org/dbXRates/USD')
      return Number(data?.items?.[0]?.xauPrice)
    }))

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
    cnyPerUsd
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
    return `国际现货金约 **$${usd}/盎司** · 折合约 **¥${cny}/克**（参考，非投资建议）`
  }
  return `国际现货金约 **$${usd}/盎司**（参考）`
}

const WIKI_UA = 'daily-wechat-brief/1.0 (personal digest; Node.js)'

const FALLBACK_COLD_FACTS = [
  {
    title: '静默螺旋',
    extract:
      '人们若觉得自己的观点是少数，往往会选择沉默；沉默又让他人误判「多数意见」，于是少数意见越来越难发声。',
    url: 'https://zh.wikipedia.org/wiki/%E6%B2%89%E9%BB%98%E8%9E%BA%E6%97%8B'
  },
  {
    title: '邓巴数',
    extract:
      '人类能够维持稳定社交关系的人数大约在 150 人左右——大脑皮层大小似乎给「熟人圈」设了上限。',
    url: 'https://zh.wikipedia.org/wiki/%E9%82%93%E5%B7%B4%E6%95%B0'
  },
  {
    title: '巴纳姆效应',
    extract:
      '人们很容易把足够模糊、通用的性格描述当成「精准说中自己」，星座与伪心理测试常利用这一点。',
    url: 'https://zh.wikipedia.org/wiki/%E5%B7%B4%E7%BA%B3%E5%A7%86%E6%95%88%E5%BA%94'
  },
  {
    title: '蔡加尼克效应',
    extract:
      '未完成的任务比已完成的任务更容易被记住——大脑会一直惦记「还没做完的那件事」。',
    url: 'https://zh.wikipedia.org/wiki/%E8%94%A1%E5%8A%A0%E5%B0%BC%E5%85%8B%E6%95%88%E5%BA%94'
  },
  {
    title: '旁观者效应',
    extract: '在场的人越多，每个人出手帮助的概率反而可能越低——责任被「稀释」了。',
    url: 'https://zh.wikipedia.org/wiki/%E6%97%81%E8%A7%82%E8%80%85%E6%95%88%E5%BA%94'
  }
]

/** 一条冷知识 / 百科词条（维基随机，失败用兜底） */
async function getColdFact() {
  try {
    const data = await fetchJson('https://zh.wikipedia.org/api/rest_v1/page/random/summary', {
      headers: { 'User-Agent': WIKI_UA, 'Api-User-Agent': WIKI_UA }
    })
    const title = String(data?.title || '').trim()
    const extract = truncateText(String(data?.extract || '').replace(/\s+/g, ' '), 180)
    if (title && extract) {
      return {
        title,
        extract,
        url: data.content_urls?.desktop?.page || data.content_urls?.mobile?.page || ''
      }
    }
  } catch (e) {
    console.warn('维基随机词条失败:', e.message)
  }
  const { d } = getDateParts()
  return FALLBACK_COLD_FACTS[d % FALLBACK_COLD_FACTS.length]
}

/** 少数派 / 爱范儿 生活精选 1～2 条 */
async function getLifestylePicks(limit = 2) {
  const feeds = [
    ['https://sspai.com/feed', '少数派'],
    ['https://www.ifanr.com/feed', '爱范儿']
  ]
  const collected = []
  const seen = new Set()

  for (const [feed, source] of feeds) {
    if (collected.length >= limit) break
    try {
      const items = await fetchRssFeed(feed, 4)
      for (const item of items) {
        const key = item.title.replace(/\s+/g, '').toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        collected.push({
          ...item,
          summary: item.summary ? `${source} · ${item.summary}` : source
        })
        break
      }
    } catch (e) {
      console.warn(`生活精选失败 ${source}:`, e.message)
    }
  }
  return collected.slice(0, limit)
}

/** 晚报：Hacker News ≈2 + GitHub Trending，共 3 条 */
async function getGeekHot(limit = 3) {
  const items = []

  try {
    const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json')
    if (Array.isArray(ids)) {
      for (const id of ids.slice(0, 10)) {
        if (items.length >= 2) break
        try {
          const story = await fetchJson(
            `https://hacker-news.firebaseio.com/v0/item/${id}.json`
          )
          if (!story?.title) continue
          items.push({
            title: story.title,
            url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
            summary: `Hacker News · ${story.score || 0} points`
          })
        } catch {
          // 单条失败跳过
        }
      }
    }
  } catch (e) {
    console.warn('Hacker News 失败:', e.message)
  }

  try {
    const trending = await fetchRssFeed(
      'https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml',
      6
    )
    for (const item of trending) {
      if (items.length >= limit) break
      const key = item.title.replace(/\s+/g, '').toLowerCase()
      if (items.some(x => x.title.replace(/\s+/g, '').toLowerCase() === key)) continue
      items.push({
        title: item.title,
        url: item.url,
        summary: item.summary ? `GitHub Trending · ${item.summary}` : 'GitHub Trending'
      })
    }
  } catch (e) {
    console.warn('GitHub Trending 失败:', e.message)
  }

  if (items.length < limit) {
    try {
      const hnRss = await fetchRssFeed('https://hnrss.org/frontpage', 5)
      for (const item of hnRss) {
        if (items.length >= limit) break
        const key = item.title.replace(/\s+/g, '').toLowerCase()
        if (items.some(x => x.title.replace(/\s+/g, '').toLowerCase() === key)) continue
        items.push({
          title: item.title,
          url: item.url,
          summary: item.summary ? `Hacker News · ${item.summary}` : 'Hacker News'
        })
      }
    } catch (e) {
      console.warn('HN RSS 兜底失败:', e.message)
    }
  }

  return items.slice(0, limit)
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
  const q = truncateText(String(text || '').trim(), 450)
  if (!q) return null
  try {
    const url =
      `https://api.mymemory.translated.net/get` +
      `?q=${encodeURIComponent(q)}&langpair=en|zh-CN`
    const data = await fetchJson(url)
    const translated = data?.responseData?.translatedText?.trim()
    if (translated && isMostlyChinese(translated)) return translated
  } catch (e) {
    console.warn('翻译失败，跳过:', e.message)
  }
  return null
}

/** 标题/摘要若基本是英文，译成中文；失败则保留原文 */
async function localizeNewsItem(item) {
  let title = item.title || ''
  let summary = item.summary || ''

  if (title && !isMostlyChinese(title)) {
    const t = await translateToChinese(title)
    if (t) title = t
  }
  if (summary && !isMostlyChinese(summary)) {
    const s = await translateToChinese(summary)
    if (s) summary = truncateText(s, 220)
  }
  return { ...item, title, summary }
}

async function localizeNewsItems(items) {
  // 逐条翻译，降低免费接口限流概率
  const out = []
  for (const item of items) {
    out.push(await localizeNewsItem(item))
  }
  return out
}

/**
 * 全球大事：中文源优先；英文稿自动翻译。
 * 晚场仍错开选取，但不会把 BBC 英文源翻到最前灌满候选池。
 */
async function fetchWorldNews(limit = 10, slot = 'morning') {
  const zhFeeds = FEEDS_WORLD.filter(f => !/bbci\.co\.uk\/news\/world/i.test(f))
  const enFeeds = FEEDS_WORLD.filter(f => /bbci\.co\.uk\/news\/world/i.test(f))
  const ordered = [...feedsForSlot(zhFeeds, slot), ...enFeeds]
  const pool = await fetchNewsPool(ordered, Math.max(limit * 3, 28))
  const picked = selectNewsForSlot(pool, slot, limit)
  const localized = await localizeNewsItems(picked)
  const translated = localized.filter(
    (it, i) => it.title !== picked[i].title || it.summary !== picked[i].summary
  ).length
  if (translated) console.log(`全球大事：已翻译 ${translated} 条英文稿`)
  return localized
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

function renderTechTermSection(techTerm) {
  if (!techTerm?.term) return ['_暂无_', '']
  return [
    `> **${techTerm.term}**（${techTerm.en}）`,
    `>`,
    `> ${techTerm.def}`,
    ''
  ]
}

function buildContent({
  weather,
  china,
  tech,
  world,
  quote,
  dateText,
  greeting,
  slot,
  history = [],
  coldFact = null,
  gold = null,
  lifestyle = [],
  geekHot = [],
  techTerm = null
}) {
  const lines = []
  const { today } = weather
  const isEvening = slot === 'evening'
  const goldLine = formatGoldLine(gold)

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

  if (isEvening) {
    lines.push(`## 🌤 ${CITY_NAME} · 此刻`)
    lines.push(
      `- **${today.temp}°C** · ${today.desc} · ${today.low}°C ~ ${today.high}°C · 降水概率 ${today.rainProb}%`
    )
    lines.push('')

    lines.push('## 📘 明日技术名词')
    lines.push(...renderTechTermSection(techTerm))

    lines.push(...renderNewsSection('🔥 极客热点 · HN / GitHub', geekHot))

    lines.push('_以下为今日新增资讯（与早报错开选取）_')
    lines.push('')
    lines.push(...renderNewsSection('🇨🇳 中国新闻 · 今日新增', china))
    lines.push(...renderNewsSection('💻 科技新闻 · 今日新增', tech))
    lines.push(...renderNewsSection('🌍 全球大事 · 今日新增', world))
  } else {
    lines.push('## 📅 历史上的今天')
    if (!history.length) {
      lines.push('_暂无内容_')
      lines.push('')
    } else {
      for (const ev of history) {
        const year = ev.year != null ? `**${ev.year}年** · ` : ''
        lines.push(`- ${year}${ev.text}`)
      }
      lines.push('')
    }

    if (coldFact?.title) {
      lines.push('## 💡 今日冷知识')
      if (coldFact.url) {
        lines.push(`> **[${coldFact.title}](${coldFact.url})** — ${coldFact.extract}`)
      } else {
        lines.push(`> **${coldFact.title}** — ${coldFact.extract}`)
      }
      lines.push('')
    }

    if (goldLine) {
      lines.push('## 🥇 今日金价')
      lines.push(`- ${goldLine}`)
      lines.push('')
    }

    lines.push(`## 🌤 ${CITY_NAME} · 今日天气`)
    lines.push(`- 现在：**${today.temp}°C** · ${today.desc}`)
    lines.push(
      `- 今日：${today.low}°C ~ ${today.high}°C · 湿度 ${today.humidity}% · 降水概率 ${today.rainProb}% · 风速 ${today.wind} km/h`
    )
    lines.push('')

    lines.push('## 📘 明日技术名词')
    lines.push('_明天工作可能会用上：_')
    lines.push('')
    lines.push(...renderTechTermSection(techTerm))

    lines.push(...renderNewsSection('🍃 生活精选 · 少数派 / 爱范儿', lifestyle))

    lines.push(...renderNewsSection('🇨🇳 中国新闻', china))
    lines.push(...renderNewsSection('💻 科技新闻', tech))
    lines.push(...renderNewsSection('🌍 全球大事', world))
  }

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
  const isEvening = slot === 'evening'
  // 早报每类 10 条；晚报做减法，每类 5 条「今日新增」
  const newsLimit = isEvening ? 5 : 10
  console.log(
    `开始生成每日${slotLabel}...（BRIEF_SLOT=${slot}，新闻每类 ${newsLimit} 条）`
  )

  const techTerm = getTomorrowTechTerm()

  const [weather, china, tech, world, quote, extras] = await Promise.all([
    getWeather(),
    fetchChinaNews(newsLimit, slot),
    fetchNewsFromFeeds(FEEDS_TECH, newsLimit, slot),
    fetchWorldNews(newsLimit, slot),
    getDailyQuote(),
    isEvening
      ? getGeekHot(3).then(geekHot => ({
          history: [],
          coldFact: null,
          gold: null,
          lifestyle: [],
          geekHot
        }))
      : Promise.all([
          getHistoryToday(5),
          getColdFact(),
          getGoldPrice(),
          getLifestylePicks(2)
        ]).then(([history, coldFact, gold, lifestyle]) => ({
          history,
          coldFact,
          gold,
          lifestyle,
          geekHot: []
        }))
  ])

  const greeting = buildOpeningGreeting(slot)

  console.log(
    isEvening
      ? `抓取完成：${slotLabel} · 开场「${greeting}」· 名词「${techTerm.term}」· 极客热点 ${extras.geekHot.length} · 中国 ${china.length} · 科技 ${tech.length} · 全球 ${world.length}`
      : `抓取完成：${slotLabel} · 开场「${greeting}」· 名词「${techTerm.term}」· 历史 ${extras.history.length} · 冷知识 ${extras.coldFact ? 1 : 0} · 金价 ${extras.gold ? `$${Math.round(extras.gold.usdPerOz)}` : '无'} · 生活 ${extras.lifestyle.length} · 中国 ${china.length} · 科技 ${tech.length} · 全球 ${world.length}`
  )

  const dateText = todayLabel()
  // 主题保留日期；正文以开场问候 + 格言开篇
  const subject = `Rick的每日${slotLabel} · ${dateText}`
  const content = buildContent({
    weather,
    china,
    tech,
    world,
    quote,
    dateText,
    greeting,
    slot,
    techTerm,
    ...extras
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
