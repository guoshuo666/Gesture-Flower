/* ============================================================================
 * 指尖花开 · 手势控制花朵在指尖绽放
 * ----------------------------------------------------------------------------
 * 技术构成：
 *   1) Three.js  —— 用 THREE.Points + 自定义 ShaderMaterial 渲染 14000 颗粒子
 *   2) GLSL      —— 顶点着色器负责「花苞位置 → 绽放位置」的插值、卷曲、漂浮、
 *                   指尖跟随；片元着色器负责「内核 + 指数光晕」的加法混合发光
 *   3) MediaPipe Hands —— 实时识别手部 21 个关键点
 *   4) 原生 JS   —— tension（手掌张开度）计算、平滑、缓动、UI 与错误处理
 *
 * ★ 性能关键点 ★
 *   粒子的位置【只在初始化时用 JS 循环生成一次】（生成 aBud / aBloom 两组静态
 *   属性），运行时的每一帧都【不做任何 JS 粒子循环】，只更新少量 uniform，
 *   插值由 GPU 顶点着色器并行完成。这是 20000 粒子能跑满 60FPS 的核心原因。
 *
 * 运行：python -m http.server 5500  →  http://localhost:5500
 *
 * 依赖：Three.js r160 与 MediaPipe Hands 均已放在本地 vendor/ 目录，
 *       通过 index.html 的 importmap 与 locateFile 指向本地文件，
 *       因此不依赖 cdn.jsdelivr.net（该域名在部分网络下连接会被重置）。
 * ========================================================================== */

import * as THREE from 'three';

/* ============================================================================
 * 第 0 节 · 全局可调参数（所有魔法数字集中在此，方便调节）
 * ========================================================================== */
const CONFIG = {
  /* ---------- 粒子数量 ----------
   * 【调优】14000 → 9000：原来粒子过密，加法混合叠在一起会糊成一团光斑，
   *   降低密度后单颗粒子的轮廓更清晰，花瓣的通透感明显更好。
   *   粒子总数依然远超需求的 5000 下限，形状不会被破坏。 */
  PARTICLE_COUNT: 9000,

  /* ---------- 花朵半径（世界单位，摄像机在 z = 6.2 处观察） ---------- */
  FLOWER_RADIUS: 1.75,

  /* ---------- 花苞聚拢时的体积半径 ---------- */
  BUD_RADIUS: 0.46,

  /* ---------- 花蕊（中心）粒子占总量的比例 ---------- */
  CORE_RATIO: 0.11,

  /* ---------- 花瓣分层参数
   *   petals     : 该层的花瓣数
   *   radius     : 该层的半径系数（乘以 FLOWER_RADIUS）
   *   zBase      : 该层在 Z 轴上的基础抬升（内层更高，形成杯状层次）
   *   cup        : 花瓣根部的上翘量（值越大花瓣越像小碗）
   *   tipCurl    : 花瓣尖端的向外/向后翻卷量（外层翻卷最明显）
   *   angleOffset: 层与层之间的角度错位（避免花瓣重叠成一条线）
   *   sharp      : 极坐标花瓣函数的锐度指数（越小花瓣越圆润宽大）
   *   ruffle     : 花瓣边缘的波浪褶皱强度
   *   warm       : 该层的暖色偏移（内层更暖更亮）
   * -------------------------------------------------------------------- */
  PETAL_LAYERS: [
    { petals: 9, radius: 1.00, zBase: 0.00, cup: 0.12, tipCurl: 0.34, angleOffset: 0.00, sharp: 0.80, ruffle: 0.055, warm: 0.00 },
    { petals: 7, radius: 0.70, zBase: 0.10, cup: 0.20, tipCurl: 0.16, angleOffset: 0.22, sharp: 0.95, ruffle: 0.045, warm: 0.35 },
    { petals: 5, radius: 0.44, zBase: 0.20, cup: 0.30, tipCurl: 0.05, angleOffset: 0.47, sharp: 1.10, ruffle: 0.035, warm: 0.62 }
  ],

  /* ---------- 【本次微调】花瓣 Z 轴厚度系数（想加厚/变薄只动这一个数字） ----------
   * 作用：统一放大花瓣在 Z 方向的三类形变 —— cup（根部上翘成杯状）、
   *       tipCurl（瓣尖翻卷）、zBase（层间抬升）。
   * 调整前的问题：整朵花的 Z 跨度只有约 0.5 世界单位，而花朵直径是 3.5，
   *       比例约 1:7，所以看起来像一张纸片。
   * 1.8 之后 Z 跨度约 0.9，厚度感明显，同时仍远小于直径，不会变成球。
   * 常用档位：1.0（原始扁片） / 1.8（当前，饱满立体） / 2.5（很厚，偏球状） */
  PETAL_DEPTH_SCALE: 1.8,

  /* ---------- 【本次微调】花瓣随机厚度扰动（± 值） ----------
   * 每颗粒子在 Z 上的随机偏移量，让花瓣有真实的“肉感”而不是零厚度的面。
   * 0.075 → 0.085，配合上面的整体加厚，边缘更有体积。 */
  PETAL_THICKNESS_JITTER: 0.085,

  /* ---------- 点精灵尺寸：gl_PointSize = aSize * uSizeScale * (160 / -z)
   * 【本次微调】POINT_SIZE_SCALE 0.115 → 0.072：
   *   粒子整体缩小约 37%，颗粒更细小精致、更轻盈，不再显得“一粒一粒很重”。
   *   （这是尺寸缩放的唯一入口，gl_PointSize 公式本身未改动。）
   * 【本次微调】POINT_SIZE_MAX 34 → 22：
   *   这是单个粒子的硬上限。粒子变小后若上限不动，个别飞近相机的粒子
   *   仍会膨胀成一大团糊在屏幕上；一并收紧可避免出现突兀的大光斑。 */
  POINT_SIZE_SCALE: 0.072,
  POINT_SIZE_FALLOFF: 160.0,
  POINT_SIZE_MAX: 22.0,

  /* ---------- 整体发光强度（加法混合容易过曝，可用它整体压暗） ---------- */
  GLOW_INTENSITY: 0.55,

  /* ---------- tension 计算参数 ----------
   *   ratio = 平均(腕→指尖) / 平均(腕→掌指关节)
   *   握拳时指尖缩回掌心，ratio ≈ 1.0 ~ 1.2
   *   完全张开时指尖远离手腕，ratio ≈ 2.0 ~ 2.2
   *
   * 【调优】把映射区间从 [1.05, 2.20] 收窄到 [1.02, 1.90]：
   *   归一化公式是 (ratio - FIST) / (OPEN - FIST)，分母就是“全量程”。
   *   分母变小 == 放大比例 == 同样的手部张合幅度会换来更大的 tension 变化，
   *   即用户说的“手挥动时花朵动的幅度更大”。1.90 仍留有余量，
   *   手掌张到最大时不会提前顶到 1.0 而“削顶”。
   * ---------------------------------------------------------- */
  RATIO_FIST: 1.02,           // 握拳基准（越低，轻微张手就能脱离花苞态）
  RATIO_OPEN: 1.90,           // 全开基准（越低，张开时越快达到 tension = 1）
  TENSION_GAMMA: 0.78,        // 响应曲线（<1 让中段更敏感，已由 0.90 调至 0.78）

  /* ---------- 平滑：滑动窗口长度 + 指数平滑系数 ---------- */
  TENSION_WINDOW: 5,          // 取最近 5 帧的均值，抑制单帧跳变
  TENSION_SMOOTH: 0.24,       // 指数平滑（EMA）：s += (raw - s) * 0.24

  /* ---------- 手势阈值与缓动 ---------- */
  BUD_THRESHOLD: 0.32,        // tension < 0.32 → 花苞闭合（spread = 0）
  BLOOM_THRESHOLD: 0.66,      // tension > 0.66 → 完全绽放（spread = 1）

  /* 【调优】缓动系数 0.10 → 0.18：
   *   currentSpread += (target - current) * 0.18
   *   每帧追赶剩余差值的 18%（原来 10%），开合更跟手、更有“手一挥手就回应”的感觉。
   *   之所以没有直接上 0.20，是因为配合上面放大过的灵敏度后，
   *   0.18 已经足够快，再大会让 MediaPipe 的单帧噪声直接可见（花瓣抖）。 */
  EASE_FACTOR: 0.18,

  /* ---------- 指尖跟随 ---------- */
  /* 【调优】跟随幅度 0.42 → 0.62：花朵跟随指尖的位移范围更大，
     手在画面里移动同样的距离，花朵走得更远，不再“黏在原地” */
  POINTER_STRENGTH: 0.62,
  POINTER_SMOOTH: 0.16,       // 【调优】0.12 → 0.16，跟上更快的跟随幅度，避免明显拖尾
  POINTER_Z_GAIN: 0.55,       // 由 landmark.z 换算的深度位移增益

  /* ---------- 花朵自转【已停用】 ----------
   * 【修复二】用户要求绝对禁止自转，主循环里的 rotation.y 累加已整段删除。
   * 这里保留常量为 0 仅作记录：花朵现在完全静止，不随任何时间参数转动。
   * （真正的旋转逻辑已经不存在，改这个值不会有任何效果。） */
  ROTATION_SPEED: 0,

  /* ---------- 相机 ---------- */
  CAMERA_FOV: 55,
  CAMERA_Z: 6.2,

  /* ---------- 手部识别 ---------- */
  MAX_HANDS: 2,               // 最多同时识别两只手（用第一只做控制）
  HANDS_INTERVAL_MS: 32,      // 识别频率上限（约 30 FPS，避免占满 CPU）
  HAND_LOST_TIMEOUT: 700,     // 超过该毫秒数没检测到手，视为手已离开画面
  MIN_DETECTION_CONFIDENCE: 0.6,
  MIN_TRACKING_CONFIDENCE: 0.6,

  /* ---------- 演示模式（无摄像头时）自动开合周期（秒） ---------- */
  DEMO_PERIOD: 9.0,

  /* ==========================================================================
   * 【新增 · 任务一/二/三】比耶文字特效 + 双手银河光桥 + 大面积跟随
   * --------------------------------------------------------------------------
   * 说明：以下都是新参数，没有改动上面任何既有参数
   *      （粒子密度、灵敏度、旋转速度、配色、粒子尺寸全部保持原样）。
   * ========================================================================== */

  /* ---------- 任务三：花朵的大幅度跟随 ----------
   * POINTER_STRENGTH_SCALE：在原有 POINTER_STRENGTH(=0.62) 的基础上再放大。
   *   最终有效跟随幅度 = 0.62 × 2.2 ≈ 1.36，即指尖晃动时花朵能横跨大半个屏幕。
   *   之所以没有直接改 POINTER_STRENGTH，是为了保持你原有的参数不被污染，
   *   想回退只要把这个值改回 1.0 即可。
   * POINTER_SMOOTH_FAST：跟随时使用的更快的平滑系数。
   *   原来 0.16 会造成肉眼可见的“拖尾延迟”，提到 0.42 后基本跟手。 */
  POINTER_STRENGTH_SCALE: 2.2,
  POINTER_SMOOTH_FAST: 0.42,

  /* ---------- 【修复六】比耶手势检测：放宽阈值 + 时间锁防抖 ----------
   * 手指是否伸直，用「腕→指尖距离 ÷ 腕→PIP 关节距离」判断（与手部远近无关）：
   *   伸直时指尖明显更远（约 1.5~1.9）；弯曲时两者接近（约 0.9~1.1）。
   *
   * 上一版用 1.45 / 1.15，容错太窄，导致“有时识别不出来”。
   * 现在放宽到 1.30 / 1.10，并把中间的 [1.10, 1.30] 视为“不确定”区间：
   * 落在不确定区间的指头既不算伸也不算弯，直接判为不达标 —— 宁可漏判也不误判。 */
  PEACE_EXTEND_RATIO: 1.30,     // 比值 ≥ 此值 → 该指算伸直（放宽）
  PEACE_BEND_RATIO: 1.10,       // 比值 ≤ 此值 → 该指算弯曲（放宽）
  PEACE_MIN_FRAMES: 5,          // 需连续 5 帧（约 0.16s @30fps）
  PEACE_HOLD_SEC: 0.15,         // 或持续 0.15 秒（两者满足其一即可触发）
  SPELL_LOCK_SEC: 2.0,          // 触发后 2 秒状态锁：期间手势变形也不消失（防闪烁）
  SPELL_RELEASE_SEC: 0.35,      // 锁定结束后，手势需连续消失这么久才真正退出
  SPELL_REVEAL_SPEED: 0.11,     // （保留以兼容旧参数；实际过渡由 TEXT_FADE_SEC 控制）
  SPELL_REVEAL_IN_SPEED: 0.30,  // （保留以兼容旧参数；实际过渡由 TEXT_FADE_SEC 控制）

  /* ==========================================================================
   * 【重构一】全局平滑参数 —— 所有切换都靠这三个系数做 lerp，禁止硬切
   * --------------------------------------------------------------------------
   * 说明：lerp 每帧的收敛速度与帧率有关，所以主循环里用
   *       alpha = 1 - Math.pow(1 - k, dt * 60) 做帧率归一化（见 animate）。
   *       下面给的 k 是「60fps 下每帧的逼近比例」。
   * ========================================================================== */
  FADE_OUT_SEC: 0.45,          // 花朵让位 / 淡出的时间（秒），对应重构二要求的 0.5 秒内完成
  FADE_IN_SEC: 0.60,           // 花朵恢复显示的时间（秒），略慢一点更柔和
  SCATTER_SEC: 0.50,           // 散开程度 0→1 的时间（秒）
  BRIDGE_FADE_SEC: 0.55,       // 拱桥淡入淡出时间（秒）
  TEXT_FADE_SEC: 0.50,         // 文字显现/消失时间（秒）

  /* ---------- 【重构二】文字尺寸放大 ----------
   * 原来 3.0 只占屏宽约 35%，太小。放大到 4.8（约屏宽 56%），文字更醒目。
   * 相机 z=6.2、FOV 55°、16:10 视口下全宽约 8.6，4.8 不会顶出屏幕。 */
  SPELL_WORLD_WIDTH: 4.8,
  SPELL_FOLLOW_EASE: 0.18,     // 文字跟随手部中心的平滑系数
  SPELL_SIZE_BOOST: 1.25,      // 文字粒子本身的尺寸倍率（比花朵颗粒略大，便于阅读）

  /* ---------- 任务二：用 Canvas 文字采样生成粒子坐标 ----------
   *   先在离屏 Canvas 上画出「天天开心❤」，再读取像素，
   *   把落笔处的像素点按步长抽样成粒子目标位置。 */
  SPELL_PARTICLES: 6000,        // 文字粒子数（独立的 Points 对象，不占用花朵粒子的名额）
  SPELL_TEXT: '天天开心❤',      // 需求指定的内容（爱心可换成 ❤️ 或 ♥）
  SPELL_CANVAS_W: 1024,         // 离屏画布宽（越大采样越精细，显存开销也越大）
  SPELL_CANVAS_H: 360,
  SPELL_BURST: 0.75,            // 爆炸扩散半径（文字成形前的向外炸开幅度）

  /* ---------- 【修复三】双手之间的「银河光桥」 ----------
   * 上一版太小看不清，原因有两个：
   *   ① 两端直接固定在手的位置，两手靠得近时桥就短得几乎看不见
   *   ② 控制点只下垂 0.42，弧度太弱
   *
   * 【重构三】现在改为严格绑定：
   *   · 端点 = 左手食指指尖 Keypoint 8、右手食指指尖 Keypoint 8，
   *     经 NDC 映射后转世界坐标，桥头死死跟着手掌走。
   *   · 不再做整体放大（放大后桥头会离开手掌，正是“歪斜/脱节”的来源）。
   *   · 控制点 Y 由双手距离动态决定，形成拱形，并用 lerp 平滑。
   *
   * 双手距离与弧高：
   *   dist = |L - R|（世界单位）
   *   arch = clamp(dist × BRIDGE_ARCH_RATIO, 0.15, BRIDGE_MAX_ARCH)
   *   C = ( 中点 + (0, arch) )     ← 控制点在中点上方 arch 处
   *   拱顶 θ=0.5 处高度 = 中点 y + arch × 0.5（二次贝塞尔的特性） */
  BRIDGE_PARTICLES: 2600,       // 光桥粒子数
  BRIDGE_ARCH_RATIO: 0.75,      // 控制点高度 = 双手距离 × 该比例（越大弧越高）
  BRIDGE_MAX_ARCH: 3.2,         // 弧度上限，防止双手拉太远时拱桥冲出屏幕
  BRIDGE_SPREAD: 0.10,          // 光桥径向粗细（世界单位，贴合手掌尺寸）
  BRIDGE_ARCH_EASE: 0.10,       // 弧高的 lerp 平滑系数

  /* ---------- 【新增】双手捏合（Pinch）控制拱桥大小 ----------
   * 计算每个手指尖到同手拇指尖的距离，除以掌宽（腕→中指根）做归一化，
   * 得到一个与手部远近无关的“捏合度”，再映射成拱桥缩放系数。
   *
   *   pinchNorm = min(左手 4↔8 距离 / 掌宽, 右手 4↔8 距离 / 掌宽)
   *   s = clamp((pinchNorm - PINCH_MIN) / (PINCH_MAX - PINCH_MIN), 0, 1)
   *   scale = lerp(PINCH_SCALE_NEAR, PINCH_SCALE_FAR, s)     ← 0.45 ~ 1.9
   *
   * 数值参考：捏紧时 4↔8 距离约为掌宽的 0.15~0.30；完全张开可达 0.9~1.3。 */
  PINCH_MIN: 0.18,              // 归一化捏合度下限（捏紧）
  PINCH_MAX: 1.05,              // 归一化捏合度上限（张开）
  PINCH_SCALE_NEAR: 0.45,       // 捏紧时拱桥缩放（变小、收敛）
  PINCH_SCALE_FAR: 1.90,        // 张开时拱桥缩放（放大、发散）
  PINCH_EASE: 0.12,             // 缩放的 lerp 平滑系数（防抖）

  /* ---------- 【新增·交互修复二】捏合 → 拱桥粒子厚度 ----------
   * 需求：双手捏得越紧 → 桥越细；张得越开 → 越粗壮。
   * 与上面的“整体缩放”用同一路捏合度信号，但分别作用：
   *   pinchScale  → 弧高 arch 与径向 spread（桥的“形状”大小）
   *   pinchThickness → 单颗粒子的 gl_PointSize（桥的“笔触”粗细）
   * 两者独立 lerp，互不影响，可以同时生效。 */
  PINCH_THICKNESS_THIN: 0.45,   // 捏紧时的粒子粗细倍率
  PINCH_THICKNESS_THICK: 1.90,  // 张开时的粒子粗细倍率

  /* ==========================================================================
   * 【新增】单指粉白粒子拖尾绘画
   * --------------------------------------------------------------------------
   * 触发手势：只伸出食指(8)，拇指/中指/无名指/小指全部弯曲。
   * 与“比耶”互斥：比耶要求中指(S)也伸直，本手势要求中指弯曲，二者不可能同时成立。
   * ========================================================================== */

  /* 手指伸直度阈值（ext = |腕→TIP| / |腕→PIP|，与手部远近无关）
   * 食指要“伸直”、其余四指要“弯曲”，中间区间一律视为不确定 → 不触发 */
  PAINT_INDEX_UP: 1.30,         // 食指 ≥ 该值视为伸直
  PAINT_OTHER_DOWN: 1.20,       // 其余四指 ≤ 该值视为弯曲

  /* 粒子池容量：预分配，运行时【绝不 new THREE.Points / new BufferAttribute】 */
  PAINT_POOL_SIZE: 1000,
  PAINT_LIFETIME_SEC: 5.0,      // 每颗粒子存活 5 秒

  /* 发射速率：必须满足 EMIT × LIFETIME ≤ POOL
   * 190 × 5 = 950 ≤ 1000 ✔ */
  PAINT_EMIT_PER_SEC: 190,

  /* 粒子外观
   * 【修复四】尺寸整体放大到约 2 倍：原 0.55~1.15 在屏幕上只有 1~2px，
   * 看起来像一堆散点；现在 1.10~2.20，单颗粒子清晰可辨，轨迹更丰满。 */
  PAINT_SIZE_MIN: 1.10,         // 基础尺寸下限（原 0.55）
  PAINT_SIZE_MAX: 2.20,         // 基础尺寸上限（原 1.15）
  PAINT_SPREAD: 0.010,          // 生成位置抖动半径（收紧一点，轨迹更连贯）
  PAINT_Z: 0.12,                // 绘画所在的 Z 平面（略靠前，浮在花朵之上）

  /* 花朵让位：绘画时花朵压到多低（0 = 完全隐藏） */
  PAINT_HIDE_LEVEL: 1.0,
  /* 【修复三】进入/退出绘画模式时花朵的过渡时间。
   * 原 0.35s 在实机上"看起来没反应"，收紧到 0.15s：几乎瞬间让位，退出时也干净。 */
  PAINT_FADE_SEC: 0.15,

  /* ---------- 自适应画质：帧率低于该值时降低渲染分辨率 ---------- */
  FPS_FLOOR: 38,

  /* ==========================================================================
   * 【修复一】拱桥粒子尺寸系数
   * --------------------------------------------------------------------------
   * 拱桥顶点着色器里 gl_PointSize 的基础项来自 aSize（0.55~1.70）。
   * 实测发现桥由 2600 颗粒子叠在一起时，单颗太大就会糊成一条粗光带。
   * 这里加一个全局系数统一缩小 45%（0.55），让桥变成清晰的细小星尘。
   * 与捏合厚度 uThickness(0.45~1.9) 是相乘关系，互不覆盖。
   * ========================================================================== */
  BRIDGE_SIZE_SCALE: 0.55,

  /* ==========================================================================
   * 【修复五】手部坐标平滑 + 丢失宽限
   * --------------------------------------------------------------------------
   * LANDMARK_SMOOTH：每个关键点每帧向新值逼近的比例（低通滤波）。
   *   0.2 是需求指定值：既明显抑制高频抖动，又不会让人手跟上变慢。
   * LANDMARK_SNAP_DIST：瞬移阈值（归一化坐标距离）。
   *   当某个点单帧跳动超过该值时（典型场景：两手被 MediaPipe 交换顺序、
   *   或画面切人），直接吸附到新值而不是慢慢追过去 —— 否则会出现
   *   骨架在两个位置之间"拖影"的诡异画面。
   * HAND_GRACE_FRAMES：丢手宽限帧数。
   *   onResults 约 30fps，8 帧 ≈ 0.27 秒。手稍微一晃/短暂出画时保持上一帧状态，
   *   超过宽限才真正清空并渐隐，彻底消除"一晃就闪"的问题。
   * ========================================================================== */
  LANDMARK_SMOOTH: 0.2,
  LANDMARK_SNAP_DIST: 0.22,
  HAND_GRACE_FRAMES: 8
};

/* ============================================================================
 * 第 1 节 · 通用工具函数
 * ========================================================================== */

/** 数值夹紧到 [min, max] */
function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

/** 线性插值：t = 0 返回 a，t = 1 返回 b */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** GLSL 同款 smoothstep：在 [e0, e1] 之间做 3t²-2t³ 平滑过渡 */
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 异步 sleep */
function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** 二维距离（手部关键点计算专用） */
function dist2D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/* ============================================================================
 * 第 2 节 · DOM 引用（页面元素在 index.html 中定义）
 * ========================================================================== */
const dom = {
  video: document.getElementById('cam'),
  skeletonCanvas: document.getElementById('skeletonCanvas'),
  sceneCanvas: document.getElementById('sceneCanvas'),

  hudCamera: document.getElementById('hudCamera'),
  hudHand: document.getElementById('hudHand'),
  hudFps: document.getElementById('hudFps'),
  hudMode: document.getElementById('hudMode'),

  /* 【UI 极简】左下角数据面板已整体删除（DOM 中不存在这些元素），
     这里保留键只为兼容可能的测试/调试查找；取值结果为 null。
     真正的状态显示集中在底部那一行 setStatus()，见下方 updateStatusBar()。 */
  tensionFill: document.getElementById('tensionFill'),
  tensionValue: document.getElementById('tensionValue'),
  spreadFill: document.getElementById('spreadFill'),
  spreadValue: document.getElementById('spreadValue'),
  pointerValue: document.getElementById('pointerValue'),
  pointerDot: document.getElementById('pointerDot'),

  btnSkeleton: document.getElementById('btnSkeleton'),
  btnCamera: document.getElementById('btnCamera'),
  btnPreview: document.getElementById('btnPreview'),
  btnDemo: document.getElementById('btnDemo'),
  btnReset: document.getElementById('btnReset'),
  btnFullscreen: document.getElementById('btnFullscreen'),

  hintBar: document.getElementById('hintBar'),
  hintText: document.getElementById('hintText'),

  /* 【UI】星尘背景、底部状态条、右上角画中画预览窗 */
  stardustCanvas: document.getElementById('stardustCanvas'),
  camPreview: document.getElementById('camPreview'),
  camPreviewCanvas: document.getElementById('camPreviewCanvas'),
  statusBar: document.getElementById('statusBar'),
  statusText: document.getElementById('statusText'),
  statusDot: document.getElementById('statusDot'),

  bootOverlay: document.getElementById('bootOverlay'),
  bootStartBtn: document.getElementById('bootStartBtn'),
  bootDemoBtn: document.getElementById('bootDemoBtn'),
  bootLoading: document.getElementById('bootLoading'),
  bootLoadingText: document.getElementById('bootLoadingText'),

  errorPanel: document.getElementById('errorPanel'),
  errorTitle: document.getElementById('errorTitle'),
  errorDetail: document.getElementById('errorDetail'),
  errorList: document.getElementById('errorList'),
  errorRetryBtn: document.getElementById('errorRetryBtn'),
  errorDemoBtn: document.getElementById('errorDemoBtn'),
  errorCloseBtn: document.getElementById('errorCloseBtn')
};

/* 手部骨架画布的 2D 上下文 */
const skCtx = dom.skeletonCanvas.getContext('2d');

/* 【重构四】两个新增 2D 画布的上下文（预览画布用于右上角画中画） */
const stardustCtx = dom.stardustCanvas ? dom.stardustCanvas.getContext('2d') : null;
const previewCtx = dom.camPreviewCanvas ? dom.camPreviewCanvas.getContext('2d', { willReadFrequently: false }) : null;

/* ============================================================================
 * 第 3 节 · 全局运行状态
 * ========================================================================== */
const state = {
  running: false,              // 主循环是否运行
  cameraReady: false,          // 摄像头是否就绪
  handsReady: false,           // MediaPipe 模型是否就绪
  demoMode: false,             // 演示模式（无摄像头 / 手动触发）
  showSkeleton: true,          // 是否绘制手部骨架
  showCamera: true,            // 是否显示摄像头背景（C 键，全屏背景层）
  showPreview: true,           // 【新增】是否显示右上角画中画预览（P 键）
  pageHidden: false,           // 页面是否处于后台标签页（后台时暂停手部识别）

  /* --- 手势 / 花朵状态 --- */
  rawTension: 0,               // 本帧原始张开度 0~1
  tensionWindow: [],           // 滑动窗口缓冲（最近 N 帧 raw）
  windowedTension: 0,          // 滑动窗口均值
  smoothTension: 0,            // 指数平滑后的 tension（最终用于判断）
  targetSpread: 0,             // 目标绽放度（0 或 1，或过渡带内的中间值）
  currentSpread: 0,            // 缓动后的实际绽放度（传给着色器的 uSpread）

  /* --- 指尖跟随 --- */
  pointerTarget: new THREE.Vector3(0, 0, 0),   // 目标世界坐标偏移
  pointerCurrent: new THREE.Vector3(0, 0, 0),  // 平滑后的实际偏移

  /* --- 识别结果 --- */
  handLandmarksList: [],       // 所有检测到的手（每只手 21 个点）
  lastHandSeenAt: 0,           // 最后一次检测到手的时间戳
  landmarkCount: 0,

  /* --- 【重构一】全局平滑过渡变量 ---
   * 所有“出现/消失”都只改这些 0~1 的值，再由主循环用 lerp 平滑逼近，
   * 渲染层永远不直接硬切。每个值都保证被 clamp 到 [0,1]，不会溢出。 */
  flowerAlpha: 1,              // 花朵透明度 1=完全显示，0=完全让位
  flowerScatter: 0,            // 花朵散开程度 0=聚拢，1=炸开
  bridgeAlpha: 0,              // 拱桥透明度（对应 shader 的 uStrength）
  spellAlpha: 0,               // 文字透明度（对应 shader 的 uReveal）
  spellFollowPos: new THREE.Vector3(0, 0, 0),  // 文字跟随手部的平滑位置

  /* --- 【新增】比耶文字特效 --- */
  peaceActive: false,          // 本帧是否判定为「比耶」
  peaceHeldFor: 0,             // 比耶已连续保持多少秒
  peaceFrames: 0,              // 【修复六】连续命中帧数（防抖：需 ≥ PEACE_MIN_FRAMES）
  peaceReleasedFor: 0,         // 【修复六】手势消失已持续多少秒（用于退出判定的迟滞）
  spellActive: false,          // 文字特效是否已触发
  spellLockUntil: 0,           // 【修复六】时间锁截止时间戳（2 秒内绝不退出，防闪烁）
  spellTarget: 0,              // 文字透明度的目标值（0 或 1，只设目标，不直接插值）

  /* --- 【附加修复】双手光桥：按左右手分别记录食指指尖 Keypoint 8 --- */
  bridgeTarget: 0,             // 光桥透明度的目标值（0 或 1）
  bridgeArch: 0.4,             // 当前弧高（用 lerp 逼近目标，双手越远越高）

  /* --- 【新增】双手捏合控制拱桥大小 --- */
  pinchNorm: 0,                // 归一化捏合度（与手部远近无关），0=捏紧 1=全张
  pinchScale: 1,               // 平滑后的拱桥缩放系数（内部保证恒为正有限值）
  pinchThickness: 1,           // 【新增】平滑后的拱桥粒子粗细倍率（0.45~1.9）
  pinchRawCount: 0,            // 本帧参与捏合计算的手数（用于日志/调试）

  /* --- 【新增】单指粒子绘画 --- */
  drawActive: false,           // 本帧是否处于绘画手势（只伸食指）
  drawAlpha: 0,                // 绘画模式的显现度 0~1（用于花朵平滑让位）
  drawTarget: 0,               // 绘画显现度目标值
  drawEmitAccum: 0,            // 发射累加器（按 dt 累积，控制发射速率）
  drawPointerWorld: new THREE.Vector3(0, 0, 0),  // 食指指尖的世界坐标（绘画位置）
  drawPointerSmoothed: new THREE.Vector3(0, 0, 0), // 平滑后的画笔位置
  drawLastSpawn: new THREE.Vector3(0, 0, 0),     // 上一次生成粒子的位置
  drawHasLastSpawn: false,      // 是否已有上一次生成点（避免首帧插值到原点）

  /* --- 【修复五】手部坐标平滑与丢失宽限 --- */
  /* smoothList：低通滤波后的关键点（结构同 multiHandLandmarks）。
     所有控制计算（tension / 跟随 / 拱桥端点 / 绘画笔尖 / 骨架绘制）
     统一使用它，绝不直接吃 MediaPipe 的原始坐标。 */
  smoothList: null,
  /* 连续多少帧没有识别到手（用于宽限期判定） */
  handLostFrames: 0,
  /* 【修复三】花朵缩放：绘画时同步收敛，作为透明度淡出之外的第二重保证 */
  flowerScale: 1,
  /* 【致命问题一】是否处于"被强制隐藏"状态（用于退出时瞬间恢复 alpha） */
  flowerForceHidden: false,
  /* 两只手的食指指尖（Keypoint 8）在【屏幕 NDC】下的坐标：
     x ∈ [-1, 1] 屏幕左→右，y ∈ [-1, 1] 屏幕下→上。 */
  handLeftNdc: new THREE.Vector2(0, 0),
  handRightNdc: new THREE.Vector2(0, 0),
  /* 上面两个点的世界坐标版本（每帧由 NDC 换算，桥头直接用它们） */
  handLeftWorld: new THREE.Vector3(0, 0, 0),
  handRightWorld: new THREE.Vector3(0, 0, 0),
  /* 主手手掌中心（世界坐标），文字跟随与光桥共用 */
  handCenterWorld: new THREE.Vector3(0, 0, 0),
  secondHandWorld: new THREE.Vector3(0, 0, 0),
  secondHandSeenAt: 0,
  /* 平滑副本：只用于渲染，不回写状态，避免锚点比真实手慢半拍 */
  bridgeEndA: new THREE.Vector3(0, 0, 0),
  bridgeEndB: new THREE.Vector3(0, 0, 0),
  /* 【排错修复】手是否处于“在场”状态。
     用途：只在「手重新回到画面」的那一瞬间清空滑动窗口，
     避免用每帧的 landmarkCount 去判断而反复触发清窗（那会让平滑彻底失效）。 */
  handPresent: false,

  /* --- 鼠标兜底交互（无摄像头时用手动方式演示） --- */
  mouseActiveAt: 0,            // 最后一次鼠标/触摸移动的时间戳
  forcedTension: null,         // 按住鼠标左键时强制指定的张力（null = 不干预）
  relaxConstraints: false,     // 重试时是否放宽摄像头分辨率约束
  retryCount: 0,               // 启动重试次数

  /* --- 性能统计 --- */
  fps: 0,
  frameCount: 0,
  fpsTimer: 0,
  lowFpsStreak: 0,
  pixelRatio: Math.min(window.devicePixelRatio || 1, 2)
};

/* ============================================================================
 * 第 4 节 · 手部关键点常量（MediaPipe Hands 的 21 点定义）
 * ----------------------------------------------------------------------------
 *   0  手腕 WRIST
 *   1~4   拇指 CMC → MCP → IP → TIP
 *   5~8   食指 MCP → PIP → DIP → TIP
 *   9~12  中指 MCP → PIP → DIP → TIP
 *   13~16 无名指 MCP → PIP → DIP → TIP
 *   17~20 小指 MCP → PIP → DIP → TIP
 * ========================================================================== */
const HAND = {
  WRIST: 0,
  /* 四根手指的掌指关节（MCP）：食指 / 中指 / 无名指 / 小指 */
  MCP_IDS: [5, 9, 13, 17],
  /* 五根手指的指尖（TIP）：拇指 / 食指 / 中指 / 无名指 / 小指 */
  TIP_IDS: [4, 8, 12, 16, 20],
  /* 指尖单独索引（指尖跟随用） */
  INDEX_TIP: 8,
  INDEX_MCP: 5,
  MIDDLE_MCP: 9,
  /* 【新增】拇指指尖：双手捏合（Pinch）计算用，与食指指尖(8)配对 */
  THUMB_TIP: 4,

  /* ---------- 【新增】比耶手势与双手光桥用到的手指关节 ----------
   * 伸直度公式：|腕→TIP| / |腕→PIP|
   *   食指 PIP=6、中指 PIP=10、无名指 PIP=14、小指 PIP=18 */
  INDEX_PIP: 6,
  MIDDLE_TIP: 12,
  MIDDLE_PIP: 10,
  RING_TIP: 16,
  RING_PIP: 14,
  PINKY_TIP: 20,
  PINKY_PIP: 18,

  /* 手掌中点：手腕 + 中指根 + 食指根 + 无名指根。
     用加权平均而不是单取某个点，避免手一转动中心就跳（比只取手腕稳得多）。 */
  PALM_CENTER_IDS: [0, 9, 5, 13]
};

/* 骨架连线表：把 21 个孤立点连成一只手 */
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // 拇指
  [0, 5], [5, 6], [6, 7], [7, 8],          // 食指
  [5, 9], [9, 10], [10, 11], [11, 12],     // 中指
  [9, 13], [13, 14], [14, 15], [15, 16],   // 无名指
  [13, 17], [17, 18], [18, 19], [19, 20],  // 小指
  [0, 17]                                  // 手掌根部闭合
];

/* 手腕(0)、四指 MCP(5/9/13/17)、五指 TIP(4/8/12/16/20) 的点在绘制时会被高亮 */
const HAND_HIGHLIGHT = new Set([0, 4, 8, 12, 16, 20, 5, 9, 13, 17]);

/* ============================================================================
 * 第 5 节 · Three.js：场景 / 相机 / 渲染器 / 着色器
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 5.1 顶点着色器
 * ---------------------------------------------------------------------------
 * 职责：把每颗粒子的「花苞位置 aBud」与「绽放位置 aBloom」按 uSpread 做插值，
 *       并叠加卷曲、呼吸、漂浮、指尖跟随等动态效果，最后算出点尺寸与颜色。
 *       所有计算都在 GPU 上对 14000 个顶点并行执行，JS 每帧零循环。
 * ------------------------------------------------------------------------ */
const VERTEX_SHADER = /* glsl */`
  // 高精度浮点，保证 14000 个粒子位置插值不抖动
  precision highp float;

  /* ===== 每颗粒子的静态属性（由 JS 在初始化时一次性写入，运行时只读） ===== */
  attribute vec3  aBud;        // 花苞（聚拢）状态下的局部坐标
  attribute vec3  aBloom;      // 完全绽放状态下的局部坐标
  attribute vec3  aColorBud;   // 花苞状态下的颜色（冷调：深靛紫）
  attribute vec3  aColorPetal; // 绽放状态下的颜色（暖调：玫粉→白）
  attribute vec4  aParam;      // x = 花瓣序号, y = 径向参数ρ(0花心→1瓣尖), z = 横向参数φ(-1..1), w = 层号(0外→1内)
  attribute float aSeed;       // 每颗粒子的随机种子（用于错开相位）
  attribute float aSize;       // 每颗粒子的基础尺寸系数
  attribute float aTwinkle;    // 闪烁频率

  /* ===== 全局 uniform（每帧由 JS 更新，是本项目唯一的逐帧数据通道） ===== */
  uniform float uSpread;       // 绽放度 0~1（JS 已做缓动，见 EASE_FACTOR）
  uniform float uTime;         // 运行时间（秒）
  uniform vec3  uPointer;      // 指尖偏移（世界单位），实现“花朵跟随手指”
  uniform float uPixelRatio;   // 设备像素比，保证不同屏幕上粒子视觉大小一致
  uniform float uSizeScale;    // 尺寸整体缩放（随视口高度自适应）
  uniform float uFalloff;      // 透视衰减系数（gl_PointSize 公式里的常数）

  /* ===== 【重构一 / 重构二】新增两个驱动变量 =====
   * uGlobalAlpha：全局透明度 0~1。由 JS 用 lerp 平滑逼近，绝不瞬间置 0。
   *   它同时作用于「点尺寸」和「亮度」：尺寸缩小 + 亮度衰减，
   *   于是粒子是“柔和地淡出并收缩”，而不是啪一下消失。
   * uScatter：散开程度 0~1。比耶触发瞬间花朵先向外炸开再淡出，
   *   配合文字粒子的聚合动画，形成“花朵散开 → 重组为文字”的连续观感。 */
  uniform float uGlobalAlpha;
  uniform float uScatter;

  /* 散开方向：每颗粒子一个固定随机方向（JS 初始化时写入，运行时只读） */
  attribute vec3 aScatter;

  /* ===== 传递给片元着色器的插值变量 ===== */
  varying vec3  vColor;
  varying float vIntensity;
  varying float vTwinkle;

  void main() {
    // s：缓动后的绽放度，夹紧到 [0,1] 以防万一
    float s = clamp(uSpread, 0.0, 1.0);

    // 取出本颗粒子的花瓣参数
    float rho   = aParam.y;   // 0 = 花瓣根部（靠花心），1 = 花瓣尖端
    float phi   = aParam.z;   // -1..1 花瓣横向位置（用于边缘褶皱）
    float layer = aParam.w;   // 0 = 最外层，1 = 最内层

    /* ------------------------------------------------------------------
     * 【核心第 1 步】位置插值
     * mix(a, b, t) = a * (1 - t) + b * t
     * s = 0 → 完全落在 aBud（花苞）；s = 1 → 完全落在 aBloom（绽放）
     * 中间状态由 GPU 自己算，JS 不做任何循环。
     * ---------------------------------------------------------------- */
    vec3 pos = mix(aBud, aBloom, s);

    /* ------------------------------------------------------------------
     * 【核心第 2 步】绽放过程中的花瓣“外翻 / 回卷”动态
     * s*(1-s) 在 s=0 与 s=1 时为 0，在 s=0.5 附近最大 →
     * 形成一个“开到一半时花瓣向外扬起”的过程动画。
     * 外层花瓣（aParam.y 大）卷曲更明显。
     * ---------------------------------------------------------------- */
    float curlWave = sin(uTime * 0.9 + aParam.x * 1.7 + aSeed * 6.2831);
    float curlAmt  = (0.10 + 0.16 * rho) * (s * (1.0 - s)) * 4.0;
    pos.z  += curlWave * curlAmt;
    // 沿径向的轻微摆动：normalize(pos.xy) 得到花瓣在 XY 平面上的外法线方向
    vec2 radialDir = normalize(pos.xy + vec2(1e-4, 1e-4));
    pos.xy += radialDir * curlWave * curlAmt * 0.35;

    /* ------------------------------------------------------------------
     * 【核心第 3 步】整体呼吸感：轻微缩放，让花朵“活着”
     * ---------------------------------------------------------------- */
    float breathe = 1.0 + 0.02 * sin(uTime * 1.6);
    pos.xy *= breathe;

    /* ------------------------------------------------------------------
     * 【核心第 4 步】指尖跟随
     * 外围花瓣（rho 大）跟随幅度更大，花心几乎不动 → 产生柔性的“拖拽”感；
     * 花苞状态跟随减弱（乘 0.45），绽放后跟随加强（乘 1.0）。
     * ---------------------------------------------------------------- */
    float follow = (0.35 + 0.65 * rho) * mix(0.45, 1.0, s);
    pos += uPointer * follow;

    /* ------------------------------------------------------------------
     * 【核心第 5 步】漂浮抖动：三个不同频率的正弦叠加，制造生物般的微弱游动
     * ---------------------------------------------------------------- */
    float fl = 0.018 * (0.25 + 0.75 * s);
    pos += vec3(
      sin(uTime * 1.3 + aSeed * 11.0),
      cos(uTime * 1.1 + aSeed * 13.0),
      sin(uTime * 0.8 + aSeed * 17.0)
    ) * fl;

    /* ------------------------------------------------------------------
     * 【核心第 5.5 步】【重构二】散开位移
     * 由 uScatter（0~1）控制：比耶触发时花朵粒子先沿各自随机方向向外炸开，
     * 再配合 uGlobalAlpha 淡出，形成“散开 → 交给文字粒子”的连续过渡。
     * 这里只是叠加一个位移，不改变任何颜色或光晕算法。
     * ---------------------------------------------------------------- */
    pos += aScatter * uScatter;

    /* ------------------------------------------------------------------
     * 【核心第 6 步】标准 MVP 变换
     * ---------------------------------------------------------------- */
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    /* ------------------------------------------------------------------
     * 【核心第 7 步】点精灵尺寸
     *  · 透视衰减：距离越远点越小（uFalloff / -z）
     *  · 绽放时略放大（1 + 0.55 * s），呼应“花开变大”的直觉
     *  · 闪烁：每颗粒子有独立频率，形成呼吸般的光点
     *  · uPixelRatio 保证在高 DPI 屏上视觉尺寸一致
     *  · 【重构一】再乘 uGlobalAlpha：淡出时尺寸同步收缩到 0，
     *    这样视觉上是“消散”而不是“变色”
     * ---------------------------------------------------------------- */
    float twinkle = 0.75 + 0.45 * sin(uTime * aTwinkle + aSeed * 20.0);
    gl_PointSize = aSize * uSizeScale * uPixelRatio
                 * (1.0 + 0.55 * s)
                 * (uFalloff / max(0.001, -mvPosition.z))
                 * twinkle
                 * uGlobalAlpha;
    // 夹紧，避免极端近距离时出现遮挡全屏的巨型点
    gl_PointSize = clamp(gl_PointSize, 0.0, ${CONFIG.POINT_SIZE_MAX.toFixed(1)});

    /* ------------------------------------------------------------------
     * 【核心第 8 步】颜色
     * 花苞冷色 → 花瓣暖色按 s 混合；pow(s, 4) 在接近完全绽放时
     * 额外叠加一层暖金色“闪光”，制造绽放瞬间的高光。
     * 颜色本身【完全未改动】；uGlobalAlpha 只作为末尾的亮度系数参与，
     * 加法混合下“亮度→0”在视觉上就是完全透明，不会残留黑色粒子。
     * ---------------------------------------------------------------- */
    vec3 col = mix(aColorBud, aColorPetal, s);
    col += vec3(0.35, 0.22, 0.10) * pow(s, 4.0) * (0.6 + 0.4 * rho);
    vColor = col;
    vTwinkle = twinkle;

    /* 亮度：花苞时略暗，绽放时更亮；再加上闪烁调制；最后乘全局透明度 */
    vIntensity = mix(0.55, 1.0, s) * (0.55 + 0.45 * twinkle) * uGlobalAlpha;
  }
`;

/* ---------------------------------------------------------------------------
 * 5.2 片元着色器
 * ---------------------------------------------------------------------------
 * 职责：把「方形的点精灵」画成「中间亮、外面柔和衰减的圆形光斑」，
 *       配合 THREE.AdditiveBlending（加法混合）实现叠加发光的光晕效果。
 * ------------------------------------------------------------------------ */
const FRAGMENT_SHADER = /* glsl */`
  precision highp float;

  uniform float uIntensity;   // 整体发光强度（防过曝）

  varying vec3  vColor;
  varying float vIntensity;
  varying float vTwinkle;

  void main() {
    /* gl_PointCoord 是点精灵内部的 0~1 坐标，减 0.5 得到以中心为原点的 -0.5..0.5 */
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);

    /* 超出半径 0.5 的部分直接丢弃 → 方形点变成圆形 */
    if (d > 0.5) discard;

    /* ------------------------------------------------------------------
     * 【光晕核心】
     *  core : smoothstep(0.5, 0.05, d) 得到“外暗内亮”的实心内核，再平方让边缘更锐
     *  glow : exp(-7 * d²) 是指数衰减的柔和外晕（类似高斯模糊）
     *  两者相加 → 既有清晰明亮的花瓣颗粒感，又有朦胧的光晕
     * ---------------------------------------------------------------- */
    float core = smoothstep(0.5, 0.04, d);
    core *= core;
    float glow = exp(-7.0 * d * d) * 0.55;

    /* 本颗粒子的最终不透明度（加法混合下等同于“贡献强度”） */
    float a = (core * 0.9 + glow) * vIntensity * uIntensity;

    /* 中心过曝成白色，外圈保留粒子本色 → 典型的“发光粒子”观感 */
    vec3 col = vColor * (0.80 + 1.30 * core + 0.40 * glow);

    /* 加法混合：最终颜色 = 本像素颜色 * 本像素 alpha 叠加到背景上。
       这里 alpha 固定为 1.0，因为亮度已经乘进 rgb，避免被二次平方衰减。 */
    gl_FragColor = vec4(col * a, 1.0);

    /* 手动做一次近似 sRGB 编码（gamma 1/2.2）：
       three.js 会把十六进制颜色自动转换为线性工作空间，
       这里再编码回 sRGB，屏幕上看到的才是设计时的那套粉紫色调。 */
    gl_FragColor.rgb = pow(max(gl_FragColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));
  }
`;

/* ---------------------------------------------------------------------------
 * 5.3 花朵几何生成
 * ---------------------------------------------------------------------------
 * 【重要】下面这些 for 循环只在页面初始化时执行一次（毫秒级），
 *         用来把「花苞位置 / 绽放位置 / 颜色 / 参数」写进静态 attribute 缓冲。
 *         运行时的每一帧都不会再执行任何粒子循环。
 *
 * 花瓣的数学公式（极坐标花瓣函数）：
 *   设某层有 n 片花瓣，整朵花被均分为 n 个扇区，第 k 片花瓣的扇区中轴角为
 *     θ_k = k * (2π / n)
 *   在扇区内取局部角度 φ ∈ [-π/n, π/n]（φ = 0 为花瓣中轴），
 *   则该方向上的花瓣边界半径为
 *     rmax(φ) = R * |cos(φ * n / 2)| ^ sharp
 *   当 φ = 0 时 cos(0)=1 → rmax = R（花瓣最长处）；
 *   当 φ = ±π/n 时 cos(±π/2)=0 → rmax = 0（相邻花瓣在此相接）。
 *   再用 ρ ∈ [0,1] 表示「从花心到瓣尖」的归一化半径，取
 *     r = ρ * rmax(φ)，  ρ = sqrt(u) 使粒子在花瓣面积上均匀分布。
 *   最终花瓣平面坐标为：
 *     x = r * cos(θ_k + φ)
 *     y = r * sin(θ_k + φ)
 *     z = 层基础高度 + 根部上翘*(1-ρ) - 尖端翻卷*ρ^2.2 + 边缘褶皱
 * ------------------------------------------------------------------------ */

/* 调色板（十六进制按 sRGB 书写，THREE.Color 会自动转到线性空间） */
const PALETTE = {
  petalBase: new THREE.Color('#5a0b3a'),  // 花瓣根部：深玫红
  petalMid: new THREE.Color('#ff2f7b'),   // 花瓣中部：艳粉
  petalTip: new THREE.Color('#ffe3f6'),   // 花瓣尖端：近白粉
  petalEdge: new THREE.Color('#8b5cff'),  // 花瓣边缘：蓝紫（增加层次感）
  budInner: new THREE.Color('#190a3c'),   // 花苞内侧：极深靛紫
  budOuter: new THREE.Color('#7b2cff'),   // 花苞外侧：亮紫
  coreBase: new THREE.Color('#ff9a1f'),   // 花蕊：橙金
  coreTip: new THREE.Color('#fff6cf')     // 花蕊尖端：米白
};

/**
 * 极坐标花瓣边界函数
 * @param {number} localAngle 局部角度 φ（弧度，0 表示花瓣中轴）
 * @param {number} petalCount 该层花瓣数量 n
 * @param {number} sharp      锐度指数：越小花瓣越圆润宽大
 * @returns {number} 该方向的边界半径系数（0~1）
 */
function petalBoundary(localAngle, petalCount, sharp) {
  const v = Math.abs(Math.cos(localAngle * petalCount * 0.5));
  return Math.pow(v, sharp);
}

/**
 * 构建整朵花的几何体（含花苞态与绽放态两组位置）
 * @returns {THREE.BufferGeometry}
 */
function buildFlowerGeometry() {
  const COUNT = CONFIG.PARTICLE_COUNT;
  const layers = CONFIG.PETAL_LAYERS;
  const R = CONFIG.FLOWER_RADIUS;

  /* 花蕊粒子数（中心的小球 + 花丝），其余都是花瓣粒子 */
  const coreCount = Math.round(COUNT * CONFIG.CORE_RATIO);
  const petalCount = COUNT - coreCount;

  /* ---- 各层分配粒子数：按半径平方（≈面积）加权，让内外层密度一致 ---- */
  let weightSum = 0;
  for (let i = 0; i < layers.length; i++) {
    weightSum += layers[i].radius * layers[i].radius;
  }
  const layerQuota = layers.map((L) => {
    const exact = (petalCount * (L.radius * L.radius)) / weightSum;
    return { layer: L, count: Math.floor(exact) };
  });
  /* 把取整损失的粒子补给最外层，保证总数精确等于 petalCount */
  let assigned = layerQuota.reduce((sum, q) => sum + q.count, 0);
  layerQuota[0].count += (petalCount - assigned);

  /* ---- 预分配所有 attribute 缓冲（TypedArray，零 GC 压力） ---- */
  const aBud = new Float32Array(COUNT * 3);
  const aBloom = new Float32Array(COUNT * 3);
  const aColorBud = new Float32Array(COUNT * 3);
  const aColorPetal = new Float32Array(COUNT * 3);
  const aParam = new Float32Array(COUNT * 4);
  const aSeed = new Float32Array(COUNT);
  const aSize = new Float32Array(COUNT);
  const aTwinkle = new Float32Array(COUNT);
  /* 【重构二】散开方向：比耶时花朵粒子沿此方向向外炸开。
     初始化时一次性写入（每个粒子一个固定方向 × 随机幅度），运行时只读。 */
  const aScatter = new Float32Array(COUNT * 3);
  /* position 只用于让 three.js 计算包围球（做视锥剔除的参考），
     真正的渲染位置由上面的 aBud / aBloom 在着色器中决定。 */
  const positions = new Float32Array(COUNT * 3);

  const tmpColorA = new THREE.Color();
  const tmpColorB = new THREE.Color();

  let p = 0;   // 当前写入的粒子下标

  /* ======================= ① 花瓣粒子 ======================= */
  for (let li = 0; li < layerQuota.length; li++) {
    const L = layerQuota[li].layer;
    const n = L.petals;
    const quota = layerQuota[li].count;
    const layerRadius = R * L.radius;
    /* 每个扇区的半角：花瓣中线到相邻花瓣交界处的角度 */
    const halfSector = Math.PI / n;

    for (let i = 0; i < quota; i++, p++) {
      /* --- 随机挑选一片花瓣，并计算其扇区中轴角 θ_k --- */
      const k = Math.floor(Math.random() * n);
      const theta = k * (2 * Math.PI / n) + L.angleOffset;

      /* --- 扇区内的局部角度 φ：均匀采样，略微向中轴收缩避免边界粒子过密 --- */
      const phi = (Math.random() * 2 - 1) * halfSector * 0.985;

      /* --- 归一化半径 ρ：用 sqrt 让粒子在花瓣面积上均匀分布 --- */
      const rho = Math.sqrt(Math.random());

      /* --- 极坐标花瓣函数：得到该方向的边界半径系数 --- */
      const boundary = petalBoundary(phi, n, L.sharp);
      const rNorm = rho * boundary;         // 0~1 的归一化半径
      const rad = rNorm * layerRadius;      // 实际半径

      /* --- 花瓣平面坐标 --- */
      const ang = theta + phi;
      const cosA = Math.cos(ang);
      const sinA = Math.sin(ang);

      /* --- 绽放态 Z：根部上翘形成杯状 + 尖端翻卷 + 边缘褶皱 ---
       * 【本次微调】三类深度形变统一乘 CONFIG.PETAL_DEPTH_SCALE（=1.8）：
       *   cupZ  根部上翘更深 → 花瓣像小碗一样包起来
       *   curlZ 瓣尖向后翻卷更强 → 花瓣弧线更明显
       *   zBase 层与层之间的高低差更大 → 内层明显“坐在”外层之上，形成立体层次
       * 同时把翻卷的指数 2.2 → 1.6：
       *   原来 rho^2.2 几乎只在最尖端才起效，花瓣中段一直是平的；
       *   降到 1.6 后翻卷从花瓣中段就开始累积，整片花瓣呈现连续的弧形，
       *   这正是需求里说的“花瓣有更明显的弧度”。 */
      const depthScale = CONFIG.PETAL_DEPTH_SCALE;
      const cupZ = L.cup * (1 - rho) * lerp(0.7, 1.15, L.warm) * depthScale;
      const curlZ = -L.tipCurl * Math.pow(rho, 1.6) * depthScale;
      const ruffleZ = L.ruffle * Math.sin(phi * n * 2.0 + li * 1.7) * rho * depthScale;
      /* 每颗粒子的随机厚度扰动，让花瓣有“体积”而不是一张纸 */
      const thickness = (Math.random() - 0.5) * CONFIG.PETAL_THICKNESS_JITTER;

      const bloomX = cosA * rad;
      const bloomY = sinA * rad - 0.04;      // 整体略微下移，视觉重心更稳
      const bloomZ = L.zBase * depthScale + cupZ + curlZ + ruffleZ + thickness;

      /* --- 花苞态位置：把花瓣收拢成「下圆上尖」的花蕾（沿 +Y 拉长） ---
       * 纬度 lat：ρ=0（花瓣根部）→ 花蕾底部；ρ=1（瓣尖）→ 花蕾顶部
       * 极角 bt ：在收拢时加入 phi*0.55 的横向收拢与 rho*0.5 的螺旋，
       *          模拟花瓣互相包裹的形态。 */
      const lat = Math.PI - rho * Math.PI * 0.86;
      const sinLat = Math.sin(lat);
      const cosLat = Math.cos(lat);
      const bt = theta + phi * 0.55 + rho * 0.5;
      const rBud = CONFIG.BUD_RADIUS * (0.55 + 0.45 * Math.pow(rho, 0.7));
      const budX = sinLat * Math.cos(bt) * rBud * 0.92;
      const budY = cosLat * rBud * 1.35 + 0.06;
      const budZ = sinLat * Math.sin(bt) * rBud * 0.92;

      /* --- 颜色 ---
       * 绽放色：瓣根深玫红 → 花瓣中部艳粉 → 瓣尖近白，
       *         并在花瓣左右边缘（|φ| 大）混入蓝紫，形成渐变层次。
       * 花苞色：内侧极深靛紫 → 外侧亮紫。 */
      tmpColorA.copy(PALETTE.petalBase).lerp(PALETTE.petalMid, smoothstep(0.05, 0.62, rho));
      tmpColorA.lerp(PALETTE.petalTip, smoothstep(0.55, 1.0, rho));
      const edgeMix = smoothstep(0.55, 1.0, Math.abs(phi) / halfSector) * 0.55;
      tmpColorA.lerp(PALETTE.petalEdge, edgeMix);
      /* 内层花瓣整体更暖更亮一点，增强层次 */
      tmpColorA.lerp(PALETTE.coreBase, L.warm * 0.10);

      tmpColorB.copy(PALETTE.budInner).lerp(PALETTE.budOuter, Math.pow(rho, 0.8));
      /* 花苞顶部（瓣尖）带一点暖色，暗示内部孕育的花瓣 */
      tmpColorB.lerp(PALETTE.petalMid, smoothstep(0.75, 1.0, rho) * 0.35);

      /* --- 写入所有缓冲 --- */
      const i3 = p * 3;
      const i4 = p * 4;

      aBud[i3] = budX;
      aBud[i3 + 1] = budY;
      aBud[i3 + 2] = budZ;

      aBloom[i3] = bloomX;
      aBloom[i3 + 1] = bloomY;
      aBloom[i3 + 2] = bloomZ;

      positions[i3] = bloomX;
      positions[i3 + 1] = bloomY;
      positions[i3 + 2] = bloomZ;

      aColorBud[i3] = tmpColorB.r;
      aColorBud[i3 + 1] = tmpColorB.g;
      aColorBud[i3 + 2] = tmpColorB.b;

      aColorPetal[i3] = tmpColorA.r;
      aColorPetal[i3 + 1] = tmpColorA.g;
      aColorPetal[i3 + 2] = tmpColorA.b;

      aParam[i4] = k + li * 0.25;              // 花瓣序号（带层偏移，避免相位完全同步）
      aParam[i4 + 1] = rho;                    // 径向参数 0~1
      aParam[i4 + 2] = phi / halfSector;       // 横向参数 -1~1
      aParam[i4 + 3] = li / Math.max(1, layers.length - 1); // 层号归一化 0~1

      aSeed[p] = Math.random();
      /* 尺寸：瓣尖略大、花瓣根部略小，形成自然的颗粒渐变 */
      aSize[p] = (0.55 + 0.85 * Math.random()) * (0.85 + 0.45 * rho);
      aTwinkle[p] = 0.6 + Math.random() * 1.8;
    }
  }

  /* ======================= ② 花蕊粒子 ======================= */
  const CORE_BLOOM_RADIUS = 0.21;   // 绽放时花蕊小球半径
  const CORE_BUD_RADIUS = 0.155;    // 花苞时花蕊被压缩得更紧

  for (let i = 0; i < coreCount; i++, p++) {
    const i3 = p * 3;
    const i4 = p * 4;
    const isStamen = Math.random() < 0.38;   // 38% 的花蕊粒子拉成花丝（雄蕊）

    let bloomX, bloomY, bloomZ, budX, budY, budZ, colMix;

    if (isStamen) {
      /* ---- 花丝：从花心向外辐射的细长结构，末端微微上翘 ---- */
      const k = Math.floor(Math.random() * 11);           // 11 根花丝
      const baseAng = k * (2 * Math.PI / 11);
      const t = Math.pow(Math.random(), 0.6);             // 沿花丝的长度参数
      const len = 0.30 + 0.24 * Math.random();            // 每根花丝长度略有差异
      const rad = 0.06 + t * len;
      const ang = baseAng + (Math.random() - 0.5) * 0.22; // 轻微散开
      bloomX = Math.cos(ang) * rad;
      bloomY = Math.sin(ang) * rad;
      bloomZ = 0.05 + t * 0.13;                           // 末端向上翘起

      /* 花苞时花丝被压缩成一个小球 */
      const bu = Math.random() * Math.PI * 2;
      const bv = Math.acos(2 * Math.random() - 1);
      const br = CORE_BUD_RADIUS * Math.pow(Math.random(), 0.5);
      budX = br * Math.sin(bv) * Math.cos(bu);
      budY = br * Math.cos(bv) * 0.9;
      budZ = br * Math.sin(bv) * Math.sin(bu);

      colMix = t;                                         // 越靠末端越接近米白
    } else {
      /* ---- 花心种子球：半径 0.05~0.21 的球壳内随机分布 ---- */
      const u = Math.random() * Math.PI * 2;
      const v = Math.acos(2 * Math.random() - 1);
      const rad = CORE_BLOOM_RADIUS * (0.35 + 0.65 * Math.pow(Math.random(), 0.45));
      bloomX = rad * Math.sin(v) * Math.cos(u);
      bloomY = rad * Math.cos(v) * 0.85;
      bloomZ = rad * Math.sin(v) * Math.sin(u) + 0.06;

      const bu = Math.random() * Math.PI * 2;
      const bv = Math.acos(2 * Math.random() - 1);
      const br = CORE_BUD_RADIUS * (0.35 + 0.65 * Math.pow(Math.random(), 0.45));
      budX = br * Math.sin(bv) * Math.cos(bu);
      budY = br * Math.cos(bv) * 0.85;
      budZ = br * Math.sin(bv) * Math.sin(bu);

      colMix = Math.random() * 0.6;
    }

    /* 花蕊颜色：橙金 → 米白 */
    tmpColorA.copy(PALETTE.coreBase).lerp(PALETTE.coreTip, colMix);
    /* 花苞期花蕊几乎看不见，用暗淡的金色（避免破坏花苞的紫调） */
    tmpColorB.copy(PALETTE.coreBase).multiplyScalar(0.32);

    aBud[i3] = budX;
    aBud[i3 + 1] = budY;
    aBud[i3 + 2] = budZ;

    aBloom[i3] = bloomX;
    aBloom[i3 + 1] = bloomY;
    aBloom[i3 + 2] = bloomZ;

    positions[i3] = bloomX;
    positions[i3 + 1] = bloomY;
    positions[i3 + 2] = bloomZ;

    aColorBud[i3] = tmpColorB.r;
    aColorBud[i3 + 1] = tmpColorB.g;
    aColorBud[i3 + 2] = tmpColorB.b;

    aColorPetal[i3] = tmpColorA.r;
    aColorPetal[i3 + 1] = tmpColorA.g;
    aColorPetal[i3 + 2] = tmpColorA.b;

    aParam[i4] = 99.0;                 // 花蕊粒子用 99 作为特殊序号（着色器里只用于相位）
    aParam[i4 + 1] = 0.0;              // ρ = 0（视为花心）
    aParam[i4 + 2] = 0.0;
    aParam[i4 + 3] = 1.0;              // 视为最内层

    aSeed[p] = Math.random();
    aSize[p] = 0.5 + Math.random() * 0.7;   // 花蕊粒子略小
    aTwinkle[p] = 1.2 + Math.random() * 2.2; // 闪烁更快，像花粉在闪
  }

  /* ---- 组装 BufferGeometry ---- */
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aBud', new THREE.BufferAttribute(aBud, 3));
  geometry.setAttribute('aBloom', new THREE.BufferAttribute(aBloom, 3));
  geometry.setAttribute('aColorBud', new THREE.BufferAttribute(aColorBud, 3));
  geometry.setAttribute('aColorPetal', new THREE.BufferAttribute(aColorPetal, 3));
  geometry.setAttribute('aParam', new THREE.BufferAttribute(aParam, 4));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(aTwinkle, 1));

  /* 手动给包围球留出余量（指尖跟随最多 ±2 世界单位、漂浮抖动也会外扩），
     这样 three.js 的视锥剔除不会误判。 */
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) {
    geometry.boundingSphere.radius += 4.5;
  }

  /* 【重构二】给每颗粒子分配一个散开方向：
   *   以「该粒子相对花心的方向」为主（向外炸开更自然），
   *   叠加一半随机方向（避免所有粒子都沿半径呈放射状、显得机械）。
   *   方向归一化后再乘幅度，保证各粒子散开距离一致（否则靠近花心的
   *   粒子方向向量很短，叠加随机后会被随机项主导，散开不均匀）。 */
  for (let i = 0; i < COUNT; i++) {
    const i3 = i * 3;
    const bx = aBloom[i3];
    const by = aBloom[i3 + 1];
    const bz = aBloom[i3 + 2];
    const len = Math.sqrt(bx * bx + by * by + bz * bz) || 1;

    /* 径向单位向量 */
    let dx = bx / len;
    let dy = by / len;
    let dz = bz / len;

    /* 与随机方向混合，打散放射状规律 */
    const rnd = () => Math.random() * 2 - 1;
    dx += rnd() * 0.8;
    dy += rnd() * 0.8;
    dz += rnd() * 0.5;

    /* 归一化，避免长向量粒子飞得过远 */
    const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const amp = 1.2 + Math.random() * 1.4;

    aScatter[i3] = (dx / dLen) * amp;
    aScatter[i3 + 1] = (dy / dLen) * amp;
    aScatter[i3 + 2] = (dz / dLen) * amp;
  }
  geometry.setAttribute('aScatter', new THREE.BufferAttribute(aScatter, 3));

  return geometry;
}

/* ---------------------------------------------------------------------------
 * 5.4 Three.js 初始化
 * ------------------------------------------------------------------------ */
const three = {
  renderer: null,
  scene: null,
  camera: null,
  points: null,
  uniforms: null,
  clock: null,
  /* ---- 【新增】两个独立特效对象 ---- */
  flowerMaterial: null,   // 花朵材质引用（比耶文字出现时用它淡出花朵）
  spell: null,            // 比耶文字粒子系统 { points, uniforms }
  bridge: null,           // 双手银河光桥 { points, uniforms }
  paint: null             // 【新增】单指拖尾绘画粒子池 { points, ages, emitCursor, ... }
};

function initThree() {
  /* ---- 渲染器：透明背景，让 CSS 的渐变与摄像头画面透出来 ----
   * 注意：WebGL 不可用时 THREE.WebGLRenderer 会直接 throw，而不是返回 null。
   * 因此这里必须 try/catch，把异常转成 three.renderer === null，
   * 由 bootstrap() 统一弹出中文错误面板；否则整个脚本会在这里静默中断，
   * 用户只会看到一个黑屏和 F12 里的一行报错。 */
  try {
    three.renderer = new THREE.WebGLRenderer({
      canvas: dom.sceneCanvas,
      antialias: false,          // 点精灵不需要 MSAA，关掉可提升性能
      alpha: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: false
    });
  } catch (err) {
    console.error('[WebGL] 渲染器创建失败：', err);
    three.renderer = null;
    return;
  }

  /* 极少数环境下构造成功但上下文为空，同样视为失败 */
  if (!three.renderer.getContext()) {
    console.error('[WebGL] 渲染器已创建，但未取得 WebGL 上下文');
    three.renderer = null;
    return;
  }

  /* ---- WebGL 上下文丢失（显卡驱动重置 / 切换独显 / 系统休眠）----
   * 默认行为是画面永久变黑且没有任何提示，这里改成友好弹窗。 */
  dom.sceneCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    state.running = false;
    showError({
      name: 'WebGLContextLost',
      message: 'WebGL 上下文丢失（通常由显卡驱动重置或系统休眠引起）。'
    }, false);
  }, false);

  three.renderer.setClearColor(0x000000, 0);
  three.renderer.setPixelRatio(state.pixelRatio);
  three.renderer.setSize(window.innerWidth, window.innerHeight, false);

  /* ---- 场景与透视相机（相机位于 +Z，俯视 XY 平面上的花朵） ---- */
  three.scene = new THREE.Scene();
  three.camera = new THREE.PerspectiveCamera(
    CONFIG.CAMERA_FOV,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  three.camera.position.set(0, 0, CONFIG.CAMERA_Z);
  three.camera.lookAt(0, 0, 0);

  /* ---- uniform：逐帧只更新这几个值，开销可忽略 ---- */
  three.uniforms = {
    uSpread: { value: 0 },
    uTime: { value: 0 },
    uPointer: { value: new THREE.Vector3(0, 0, 0) },
    uPixelRatio: { value: state.pixelRatio },
    uSizeScale: { value: computeSizeScale() },
    uFalloff: { value: CONFIG.POINT_SIZE_FALLOFF },
    uIntensity: { value: CONFIG.GLOW_INTENSITY },
    /* 【重构一】全局透明度：由主循环用 lerp 平滑逼近，绝不硬切 */
    uGlobalAlpha: { value: 1 },
    /* 【重构二】散开程度：比耶时 0 → 1，让花朵粒子先炸开再淡出 */
    uScatter: { value: 0 }
  };

  /* ---- 材质：自定义 ShaderMaterial + 加法混合，实现粒子发光叠加 ---- */
  const material = new THREE.ShaderMaterial({
    uniforms: three.uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,                 // 加法混合粒子之间不应互相遮挡
    depthTest: true,
    blending: THREE.AdditiveBlending,  // 关键：加法混合 → 叠加发光 / 光晕
    alphaToCoverage: false
  });

  /* ---- 粒子系统 ---- */
  const geometry = buildFlowerGeometry();
  three.points = new THREE.Points(geometry, material);
  three.points.frustumCulled = false;  // 着色器会大幅平移顶点，禁用剔除最保险
  three.scene.add(three.points);

  /* 【新增】把材质存一份引用：比耶特效出现时用它把花朵淡出（只改 opacity，
     不碰任何 Shader 代码、颜色或粒子尺寸） */
  three.flowerMaterial = material;

  /* 【新增】双手银河光桥 + 比耶文字粒子（两者都是独立对象，互不干扰） */
  initBridgeEffect();
  initSpellEffect();
  /* 【新增】单指拖尾绘画粒子池（一次性预分配 1000 个粒子，运行时零分配） */
  initPaintEffect();

  /* ---- 计时器 ---- */
  three.clock = new THREE.Clock();
}

/**
 * 根据视口高度计算点尺寸缩放：
 * gl_PointSize 单位是设备像素，因此要乘 uPixelRatio 保持视觉大小一致；
 * 再乘 (视口高度 / 900) 让粒子在不同窗口尺寸下的相对大小保持稳定。
 */
function computeSizeScale() {
  const h = Math.max(320, window.innerHeight);
  return CONFIG.POINT_SIZE_SCALE * (h / 900) * state.pixelRatio;
}

/* ============================================================================
 * 第 5.5 节 · 【新增】两个独立粒子特效
 * ----------------------------------------------------------------------------
 *   ① 双手「银河光桥」—— 两只手都出现时，在两侧手掌之间拉出一条粒子拱桥
 *   ② 比耶「天天开心❤」—— Canvas 采样文字坐标，让粒子拼出字形
 *
 * 设计要点：两者都是【独立的 Points + 独立 ShaderMaterial】，完全不碰
 * 花朵原有的着色器与颜色，因此花朵的一切表现保持原样；三者共用同一套
 * 加法混合发光风格，叠在一起也不会打架。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 5.5.1 共用的圆点片元着色器
 * ---------------------------------------------------------------------------
 * 和花朵用的是同一套「内核 + 指数光晕」思路（square point → 圆形光斑），
 * 但这里必须重新实现一份：花朵的片元着色器里有 vTwinkle 等它自己的 varying，
 * 两个独立对象无法共用同一个程序。
 * ------------------------------------------------------------------------ */
const DOT_FRAGMENT_SHADER = /* glsl */`
  precision highp float;

  uniform float uIntensity;   // 整体亮度（防加法混合过曝）

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    // gl_PointCoord 是点精灵内部的 0~1 坐标，减 0.5 后以中心为原点
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);

    // 超出半径 0.5 直接丢弃 → 方形点变圆形
    if (d > 0.5) discard;

    // 内核（外暗内亮，平方后边缘更锐利）+ 指数衰减的柔和外晕
    float core = smoothstep(0.5, 0.05, d);
    core *= core;
    float glow = exp(-7.0 * d * d) * 0.55;

    float a = (core * 0.85 + glow) * vAlpha * uIntensity;

    // 中心偏白，保留粒子本色的同时更有“光感”
    vec3 col = vColor * (0.85 + 1.25 * core + 0.35 * glow);

    // 与花朵着色器一致的近似 sRGB 编码，保证两者色调不会一个亮一个暗
    gl_FragColor = vec4(pow(max(col * a, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
  }
`;

/* ---------------------------------------------------------------------------
 * 5.5.1b 【新增】单指粉白拖尾绘画
 * ---------------------------------------------------------------------------
 * 完全独立的第三套粒子系统，与花朵、拱桥、文字的 BufferGeometry 互不共享，
 * 因此不存在互相干扰的可能。
 *
 * 对象池设计（需求硬性要求：绝不在 rAF 里 new THREE.Points）：
 *   · 预分配 PAINT_POOL_SIZE(1000) 个粒子的固定 BufferGeometry
 *   · 每个粒子槽位有 position / aColor / aSize / aAlpha 四个属性
 *   · aAlpha = 该粒子当前透明度：未使用时写 0 → 顶点着色器直接丢弃，不产生任何绘制
 *   · 复用策略：环形指针 emitCursor 依次取下一个槽位；
 *     若该槽位仍有活粒子（age < lifetime），直接覆盖它（最老优先被复用）
 * ------------------------------------------------------------------------ */
const PAINT_VERTEX_SHADER = /* glsl */`
  precision highp float;

  attribute vec3  aColor;     // 粒子颜色（粉 / 白 随机混合）
  attribute float aSize;      // 粒子基础尺寸
  attribute float aAlpha;     // 该粒子当前透明度（0 = 已消亡，直接丢弃）

  uniform float uPixelRatio;
  uniform float uSizeScale;
  uniform float uFalloff;

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    // 已消亡的粒子：推离裁剪空间并让尺寸为 0，彻底不产生像素
    if (aAlpha <= 0.001) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      return;
    }

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    gl_PointSize = aSize * uSizeScale * uPixelRatio
                 * (uFalloff / max(0.001, -mvPosition.z))
                 * (0.55 + 0.45 * aAlpha);   // 淡出时略微收缩，更像“消散”
    gl_PointSize = clamp(gl_PointSize, 0.0, 20.0);

    vColor = aColor;
    vAlpha = aAlpha;
  }
`;

/**
 * 【新增】初始化单指绘画粒子池
 * 只在 initThree() 里调用一次，运行时不再分配任何对象。
 */
function initPaintEffect() {
  const COUNT = CONFIG.PAINT_POOL_SIZE;

  /* 位置：初始全部堆在原点，反正 aAlpha=0 时看不见 */
  const positions = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 3);
  const sizes = new Float32Array(COUNT);
  const alphas = new Float32Array(COUNT);   // 全 0 = 池内无活粒子

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  /* 每帧都可能整体改写，标记为动态用途 */
  geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
  geometry.attributes.aColor.setUsage(THREE.DynamicDrawUsage);
  geometry.attributes.aSize.setUsage(THREE.DynamicDrawUsage);
  geometry.attributes.aAlpha.setUsage(THREE.DynamicDrawUsage);

  const uniforms = {
    uPixelRatio: { value: state.pixelRatio },
    uSizeScale: { value: computeSizeScale() },
    uFalloff: { value: CONFIG.POINT_SIZE_FALLOFF },
    uIntensity: { value: CONFIG.GLOW_INTENSITY }
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PAINT_VERTEX_SHADER,
    fragmentShader: DOT_FRAGMENT_SHADER,   // 复用已有的圆点+光晕片元着色器
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;    // 粒子位置每帧变化，禁用剔除
  points.visible = false;          // 没有粒子时完全不绘制
  three.scene.add(points);

  /* ---- JS 侧的池管理数据（与 GPU 缓冲一一对应） ---- */
  const pool = {
    points,
    uniforms,
    geometry,
    count: COUNT,
    /* 每颗粒子的“年龄”（秒）。>= lifetime 表示已死亡、槽位可复用 */
    ages: new Float32Array(COUNT),
    /* 是否已被使用过（避免把从未发射的槽位当成活粒子统计） */
    alive: new Uint8Array(COUNT),
    /* 环形发射指针：下一次从哪个槽位开始找空位 */
    emitCursor: 0,
    /* 当前活粒子数（用于 visible 判断与调试） */
    liveCount: 0
  };

  three.paint = pool;
}

/* ---------------------------------------------------------------------------
 * 5.5.2 银河光桥
 * ------------------------------------------------------------------------ */
const BRIDGE_VERTEX_SHADER = /* glsl */`
  precision highp float;

  attribute float aSize;      // 每颗粒子的基础尺寸
  attribute float aSeed;      // 随机种子（错开闪烁相位）
  attribute vec3  aColor;     // 每颗粒子的颜色（暖金 / 粉 / 白）

  uniform float uTime;
  uniform float uStrength;    // 光桥显现度 0~1
  uniform float uPixelRatio;
  uniform float uSizeScale;
  uniform float uFalloff;
  /* 【新增·交互修复二】双手捏合驱动的粒子粗细倍率
   * 由 JS 用 lerp 平滑推进，范围约 0.45 ~ 1.9
   * 只影响 gl_PointSize（单颗粒子的视觉大小），不改变几何与数量 */
  uniform float uThickness;

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    // uStrength 为 0 时整条桥完全不可见（不做无谓的绘制）
    if (uStrength <= 0.001) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // 推到裁剪空间外
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      return;
    }

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // 沿桥流动的闪烁：让光桥看起来像在“流”而不是一根静止的棒子
    float twinkle = 0.55 + 0.45 * sin(uTime * 3.0 + aSeed * 12.0);

    gl_PointSize = aSize * uSizeScale * uPixelRatio
                 * (uFalloff / max(0.001, -mvPosition.z))
                 * (0.5 + 0.8 * uStrength)
                 * twinkle
                 * uThickness;          // 【新增】捏合控制粗细
    /* 【修复一】上限同步收紧：26 → 14。
     * 若只缩小 aSize 而不动上限，个别近处粒子在捏合放大时仍会撑成大团。 */
    gl_PointSize = clamp(gl_PointSize, 0.6, 14.0);

    vColor = aColor;
    vAlpha = uStrength * (0.45 + 0.45 * twinkle);
  }
`;

/** 构建银河光桥：位置每帧重算，所以这里只预分配缓冲与颜色 */
function initBridgeEffect() {
  const count = CONFIG.BRIDGE_PARTICLES;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);

  const tmp = new THREE.Color();
  for (let i = 0; i < count; i++) {
    /* 颜色：以暖金与花瓣粉为主，少量冷紫呼应花朵边缘色 */
    const r = Math.random();
    if (r < 0.42) tmp.copy(PALETTE.coreTip);        // 米白（最亮的星点）
    else if (r < 0.78) tmp.copy(PALETTE.coreBase);  // 橙金
    else if (r < 0.93) tmp.copy(PALETTE.petalMid);  // 艳粉
    else tmp.copy(PALETTE.petalEdge);               // 蓝紫（点缀）

    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;

    /* 【修复一】基础尺寸整体缩小 45%（× BRIDGE_SIZE_SCALE=0.55）
     * 原来 0.55~1.70 在 2600 颗叠加时会糊成粗光带，现在 0.30~0.94，
     * 桥变成由清晰细小星尘组成的拱形光带；配合 uThickness 仍可放大。 */
    sizes[i] = (0.55 + Math.random() * 1.15) * CONFIG.BRIDGE_SIZE_SCALE;
    seeds[i] = Math.random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  /* 位置每帧都在变，标记为动态使用，让驱动知道要频繁更新 */
  geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);

  const uniforms = {
    uTime: { value: 0 },
    uStrength: { value: 0 },
    uPixelRatio: { value: state.pixelRatio },
    uSizeScale: { value: computeSizeScale() },
    uFalloff: { value: CONFIG.POINT_SIZE_FALLOFF },
    uIntensity: { value: CONFIG.GLOW_INTENSITY },
    /* 【新增·交互修复二】粒子粗细倍率，初值 1（未捏合时的基准） */
    uThickness: { value: 1.0 }
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: BRIDGE_VERTEX_SHADER,
    fragmentShader: DOT_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;   // 位置每帧变化，禁用剔除最保险
  points.visible = false;
  three.scene.add(points);

  three.bridge = { points, uniforms, geometry };
}

/* ---------------------------------------------------------------------------
 * 5.5.3 比耶文字「天天开心❤」
 * ---------------------------------------------------------------------------
 * 顶点着色器做三态插值：
 *   aScatter（炸开位置） ——uBurst→  当前位置  ——uReveal→  aText（文字坐标）
 *   · uReveal = 0 时粒子缩在花心附近（此时花朵还在，看不见它们）
 *   · uReveal 升到 0.35 左右时 uBurst 达到峰值 → 向外炸开
 *   · uReveal → 1 时全部归位成文字
 * ------------------------------------------------------------------------ */
const SPELL_VERTEX_SHADER = /* glsl */`
  precision highp float;

  attribute vec3  aText;      // 文字目标位置（由 Canvas 采样得到）
  attribute vec3  aScatter;   // 炸开时的随机方向 × 半径
  attribute vec3  aColor;     // 该粒子对应的文字像素颜色
  attribute float aSize;
  attribute float aSeed;

  uniform float uReveal;      // 文字显现度 0~1
  uniform float uBurst;       // 炸开幅度 0~1（由 JS 按时间曲线驱动）
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uSizeScale;
  uniform float uFalloff;

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    if (uReveal <= 0.001) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      return;
    }

    // 从“炸开位置”平滑过渡到“文字位置”
    vec3 pos = mix(aScatter, aText, uReveal);

    // 炸开时额外沿随机方向外扩，并带一点旋涡，避免看起来是直线弹出
    float swirl = sin(uTime * 2.0 + aSeed * 6.2831) * 0.5 + 0.5;
    pos += aScatter * (uBurst * (0.85 + 0.5 * swirl));

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float twinkle = 0.7 + 0.3 * sin(uTime * aSeed * 6.0 + aSeed * 20.0);

    gl_PointSize = aSize * uSizeScale * uPixelRatio
                 * (uFalloff / max(0.001, -mvPosition.z))
                 * twinkle;
    gl_PointSize = clamp(gl_PointSize, 0.6, 18.0);

    vColor = aColor;
    vAlpha = uReveal * twinkle;
  }
`;

/**
 * 用离屏 Canvas 画出文字并采样像素，生成粒子目标坐标
 * @returns {THREE.BufferGeometry}
 */
function buildSpellGeometry() {
  const count = CONFIG.SPELL_PARTICLES;
  const text = CONFIG.SPELL_TEXT;

  /* ---- ① 离屏画布：画字 ---- */
  const canvas = document.createElement('canvas');
  canvas.width = CONFIG.SPELL_CANVAS_W;
  canvas.height = CONFIG.SPELL_CANVAS_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  /* 字号：留出左右边距，保证 5 个字符能横向排开 */
  const chars = Array.from(text);
  const cellW = canvas.width / Math.max(1, chars.length);
  let fontSize = Math.floor(Math.min(canvas.height * 0.62, cellW * 0.92));
  /* 微软雅黑缺字时浏览器会自动回退到系统字体，这里把常见中文字体都列上 */
  const fontFamily = '"Microsoft YaHei","PingFang SC","Noto Sans SC","Segoe UI Emoji","Segoe UI",sans-serif';

  /* 先量一遍总宽，若超出画布再等比缩小（不同字体的字形宽度差异很大） */
  ctx.font = '700 ' + fontSize + 'px ' + fontFamily;
  let totalW = 0;
  for (let i = 0; i < chars.length; i++) totalW += ctx.measureText(chars[i]).width;
  const maxW = canvas.width * 0.94;
  if (totalW > maxW && totalW > 0) {
    fontSize = Math.max(40, Math.floor(fontSize * (maxW / totalW)));
    ctx.font = '700 ' + fontSize + 'px ' + fontFamily;
  }

  /* ---- ② 配色：暖白 → 粉 → 金，最后一个爱心偏玫红 ---- */
  const grad = ctx.createLinearGradient(0, canvas.height * 0.18, 0, canvas.height * 0.86);
  grad.addColorStop(0.00, '#fff2fa');   // 顶部近白
  grad.addColorStop(0.45, '#ff9ecf');   // 中部粉
  grad.addColorStop(1.00, '#ffce6b');   // 底部金

  const heartGrad = ctx.createLinearGradient(0, canvas.height * 0.18, 0, canvas.height * 0.86);
  heartGrad.addColorStop(0.00, '#ffe3ef');
  heartGrad.addColorStop(0.50, '#ff4f8f');
  heartGrad.addColorStop(1.00, '#c0206a');

  const n = chars.length;
  for (let i = 0; i < n; i++) {
    /* 爱心用玫红渐变，其余字用金粉渐变 */
    ctx.fillStyle = (i === n - 1) ? heartGrad : grad;
    /* 字符位置：按画布等分居中，比一次性 fillText 更容易控制字距 */
    const cx = cellW * (i + 0.5);
    ctx.fillText(chars[i], cx, canvas.height * 0.52);
  }

  /* ---- ③ 采样：读像素 → 取落笔处的坐标 ---- */
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  const ALPHA_THRESHOLD = 40;   // 抗锯齿边缘像素半透明，阈值太低会把字形撑胖

  const filled = [];
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3] > ALPHA_THRESHOLD) {
        filled.push(x, y);
      }
    }
  }
  const filledCount = filled.length / 2;

  /* ---- ③.5【修复五】求文字像素的包围盒，用于【精确居中】----
   * 上一版把几何按“画布中心”对齐，但文字实际画在画布高度 52% 处，
   * 且字形本身并不填满整个画布，于是文字会整体偏下、左右也可能偏。
   * 这里直接量出真正落笔的像素范围，用它的中心做原点，才是真正的“屏幕正中”。
   *
   * 同时保证 X / Y 使用【同一个比例】worldPerPixel：
   * 若 X 按画布宽、Y 按画布高分别缩放，字形会被横向拉伸变形。 */
  const worldPerPixel = CONFIG.SPELL_WORLD_WIDTH / canvas.width;

  let minX = canvas.width, maxX = 0, minY = canvas.height, maxY = 0;
  for (let k = 0; k < filled.length; k += 2) {
    const px = filled[k];
    const py = filled[k + 1];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  if (filledCount === 0) {   /* 极端兜底：没采到像素时退回画布中心 */
    minX = 0; maxX = canvas.width;
    minY = 0; maxY = canvas.height;
  }
  const bboxCenterX = (minX + maxX) * 0.5;
  const bboxCenterY = (minY + maxY) * 0.5;

  console.log('[比耶特效] 文字包围盒 ' + (maxX - minX) + '×' + (maxY - minY) +
              ' px，居中于 (' + bboxCenterX.toFixed(0) + ', ' + bboxCenterY.toFixed(0) + ')');

  /* ---- ④ 生成粒子缓冲 ---- */
  const positions = new Float32Array(count * 3);
  const aText = new Float32Array(count * 3);
  const aScatter = new Float32Array(count * 3);
  const aColor = new Float32Array(count * 3);
  const aSize = new Float32Array(count);
  const aSeed = new Float32Array(count);

  /* 像素多就随机抽样，像素少就允许重复取点，保证最终正好 count 颗。
     这里用随机抽样而不是等步长遍历：等步长会让粒子在小字号下呈规则网格状。 */
  console.log('[比耶特效] 文字像素点 ' + filledCount + ' 个，目标粒子 ' + count + ' 颗');

  for (let i = 0; i < count; i++) {
    let sx = 0;
    let sy = 0;
    let r = 0.85;
    let g = 0.72;
    let b = 0.9;

    if (filledCount > 0) {
      const pick = Math.floor(Math.random() * filledCount);
      const fi = (pick % filledCount) * 2;
      sx = filled[fi];
      sy = filled[fi + 1];

      /* 读取该像素的真实颜色（这样爱心与汉字的配色能自动继承画布上的渐变） */
      const pi = (sy * canvas.width + sx) * 4;
      r = data[pi] / 255;
      g = data[pi + 1] / 255;
      b = data[pi + 2] / 255;
    }

    /* 世界坐标：以“文字像素包围盒中心”为原点居中
     *   X：sx × worldPerPixel − 包围盒中心的 X
     *   Y：需要翻转（画布 y 向下增长，世界 Y 向上增长），故取负
     * 两者共用同一个 worldPerPixel，因此字形比例不会被拉伸。 */
    const wx = (sx - bboxCenterX) * worldPerPixel;
    const wy = -(sy - bboxCenterY) * worldPerPixel;

    /* 加一点像素内的随机抖动，让笔画边缘不至于呈网格状 */
    const jitter = worldPerPixel * 0.6;
    const tx = wx + (Math.random() - 0.5) * jitter;
    const ty = wy + (Math.random() - 0.5) * jitter;
    const tz = (Math.random() - 0.5) * 0.12;

    const i3 = i * 3;
    positions[i3] = tx;
    positions[i3 + 1] = ty;
    positions[i3 + 2] = tz;

    aText[i3] = tx;
    aText[i3 + 1] = ty;
    aText[i3 + 2] = tz;

    /* 炸开方向：球面上的随机单位向量 × 半径（略带扁平，避免像一团球） */
    const u = Math.random() * Math.PI * 2;
    const v = Math.acos(2 * Math.random() - 1);
    const burstR = CONFIG.SPELL_BURST * (0.45 + 0.75 * Math.random());
    aScatter[i3] = Math.sin(v) * Math.cos(u) * burstR;
    aScatter[i3 + 1] = Math.cos(v) * burstR * 0.85;
    aScatter[i3 + 2] = Math.sin(v) * Math.sin(u) * burstR * 0.5;

    aColor[i3] = r;
    aColor[i3 + 1] = g;
    aColor[i3 + 2] = b;

    /* 【重构二】文字粒子比花朵颗粒略大，笔画才结实、远看更醒目 */
    aSize[i] = (0.6 + Math.random() * 0.85) * CONFIG.SPELL_SIZE_BOOST;
    aSeed[i] = Math.random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aText', new THREE.BufferAttribute(aText, 3));
  geometry.setAttribute('aScatter', new THREE.BufferAttribute(aScatter, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));

  return geometry;
}

/** 初始化比耶文字粒子系统 */
function initSpellEffect() {
  const uniforms = {
    uReveal: { value: 0 },
    uBurst: { value: 0 },
    uTime: { value: 0 },
    uPixelRatio: { value: state.pixelRatio },
    uSizeScale: { value: computeSizeScale() },
    uFalloff: { value: CONFIG.POINT_SIZE_FALLOFF },
    uIntensity: { value: CONFIG.GLOW_INTENSITY }
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SPELL_VERTEX_SHADER,
    fragmentShader: DOT_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending
  });

  const points = new THREE.Points(buildSpellGeometry(), material);
  points.frustumCulled = false;
  points.visible = false;
  three.scene.add(points);

  three.spell = { points, uniforms };
}

/* ============================================================================
 * 第 6 节 · 摄像头与 MediaPipe Hands
 * ========================================================================== */

let hands = null;              // MediaPipe Hands 实例
let handsLoopRunning = false;  // 识别循环是否在跑
let handsSendBusy = false;     // 防止 hands.send 重入
let handsErrorCount = 0;       // 连续失败次数（用于友好降级）

/**
 * 请求摄像头权限并绑定到 <video>
 * @returns {Promise<void>} 失败时抛出原始 DOMException，由调用方映射成友好提示
 */
async function setupCamera() {
  /* 先做环境体检，把最常见的“打不开摄像头”原因提前拦下 */
  if (!window.isSecureContext) {
    const err = new Error('INSECURE_CONTEXT');
    err.name = 'SecurityError';
    throw err;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('MEDIA_DEVICES_UNSUPPORTED');
    err.name = 'NotSupportedError';
    throw err;
  }

  const constraints = {
    audio: false,
    video: state.relaxConstraints
      /* 重试时放宽分辨率要求，提高老旧摄像头 / 虚拟摄像头的成功率 */
      ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }
      : {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 60 }
        }
  };

  /* 【排错修复】重试前先释放上一次可能残留的视频流。
   * 否则会同时出现两种后果：摄像头指示灯一直亮着，
   * 且下次 getUserMedia 会因设备被自己占用而抛 NotReadableError。 */
  releaseCameraStream();

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  dom.video.srcObject = stream;

  /* 【排错修复】从这里开始，任何一步失败都必须把摄像头轨道关掉。
   * 原代码在 loadedmetadata / play() 失败时直接向上抛异常，
   * 而 stream 已经拿到手且从未 stop()：
   *   · 摄像头指示灯常亮（用户会以为程序还在用摄像头）
   *   · 再次点「重试」时设备被自己占用 → NotReadableError
   *     → 之后无论重试多少次都不可能成功，必须刷新页面才能恢复。
   * 这是本次排查中发现的最严重的一个漏洞。 */
  try {
    /* 等待视频元数据就绪，确保拿到真实的 videoWidth / videoHeight */
    await new Promise((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        const err = new Error('VIDEO_ELEMENT_ERROR');
        err.name = 'NotReadableError';
        reject(err);
      };
      const cleanup = () => {
        dom.video.removeEventListener('loadedmetadata', onLoaded);
        dom.video.removeEventListener('error', onError);
      };
      dom.video.addEventListener('loadedmetadata', onLoaded, { once: true });
      dom.video.addEventListener('error', onError, { once: true });
      /* 兜底：3 秒内即使没触发 loadedmetadata 也要继续（部分浏览器行为差异） */
      window.setTimeout(() => {
        cleanup();
        resolve();
      }, 3000);
    });

    await dom.video.play();

    /* 某些浏览器播放后 videoWidth 才被填充，再等一小会儿 */
    let waited = 0;
    while (dom.video.videoWidth === 0 && waited < 2000) {
      await sleep(60);
      waited += 60;
    }
  } catch (err) {
    releaseCameraStream();
    throw err;
  }

  state.cameraReady = true;
  setHud(dom.hudCamera, '已连接 ' + dom.video.videoWidth + '×' + dom.video.videoHeight, 'ok');
}

/**
 * 释放摄像头：停止所有轨道并清空 <video> 的 srcObject。
 * ----------------------------------------------------------------------------
 * 【排错修复新增】摄像头的三种失败路径（元数据超时、play() 被拒、重试）都要靠它
 * 收尾，统一放在一处避免遗漏。停止轨道后浏览器才会熄灭摄像头指示灯。
 */
function releaseCameraStream() {
  const stream = dom.video.srcObject;
  if (stream && typeof stream.getTracks === 'function') {
    stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (e) {
        /* 轨道可能已经被浏览器关闭，stop() 抛错不影响后续流程 */
      }
    });
  }
  dom.video.srcObject = null;
  state.cameraReady = false;
}

/**
 * 初始化 MediaPipe Hands（UMD 全局构造器 window.Hands）
 * @returns {Promise<void>}
 */
async function setupHands() {
  if (typeof window.Hands !== 'function') {
    const err = new Error('MEDIAPIPE_NOT_LOADED');
    err.name = 'LoadError';
    throw err;
  }

  /* 【排错修复】重试时先关掉上一个 MediaPipe 实例。
   * hands.close() 会释放它内部的 wasm 堆与 WebGL 上下文；
   * 不关就反复重试，会不断堆积实例，最终导致内存暴涨或上下文数量超限，
   * 表现为整个页面 WebGL 失效、连花苞都渲染不出来。 */
  await closeHands();

  hands = new window.Hands({
    /* wasm / 模型资源全部指向本地 vendor 目录（与 hands.js 同版本，避免版本错配）。
     * 这里刻意不用 CDN：cdn.jsdelivr.net 在部分网络下会被重置连接，
     * 而 MediaPipe 至少要下载 6MB 的 wasm 与 5.5MB 的模型，
     * 放本地既稳定又快（也避免了每次刷新都重新下载）。 */
    locateFile: (file) => `./vendor/mediapipe/hands/${file}`
  });

  hands.setOptions({
    maxNumHands: CONFIG.MAX_HANDS,
    modelComplexity: 1,           // 0 更快但精度低，1 为默认平衡档
    selfieMode: false,            // 我们自己处理镜像（在骨架绘制与坐标映射里翻转 X）
    minDetectionConfidence: CONFIG.MIN_DETECTION_CONFIDENCE,
    minTrackingConfidence: CONFIG.MIN_TRACKING_CONFIDENCE
  });

  hands.onResults(onHandResults);

  /* 首次 send 会触发 wasm 与模型下载，用一张 1×1 的空白画布预热 */
  try {
    await hands.send({ image: createWarmupCanvas() });
  } catch (err) {
    /* 预热失败（模型下载被中断等）：把半成品实例关掉再抛出，
       否则它会一直占着 wasm 内存，而且下次重试又会新建一个 */
    await closeHands();
    throw err;
  }

  state.handsReady = true;
}

/**
 * 关闭并释放当前的 MediaPipe 实例（没有实例时是安全的空操作）。
 * 【排错修复新增】close() 在部分版本里可能返回异常，这里一律吞掉并置空引用，
 * 保证调用方后续逻辑不会被清理动作本身打断。
 */
async function closeHands() {
  const instance = hands;
  hands = null;
  state.handsReady = false;
  if (!instance) return;

  try {
    if (typeof instance.close === 'function') {
      await instance.close();
    }
  } catch (err) {
    console.warn('[MediaPipe] 释放实例时出错（已忽略）：', err);
  }
}

/** 生成一张纯黑小画布，用于预热 MediaPipe（避免第一帧真实画面被吞掉） */
function createWarmupCanvas() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/**
 * 【新增】判断是否为「只伸出食指」的绘画手势
 * ============================================================================
 * 判定条件（必须同时成立）：
 *   食指(8)  伸直        ext ≥ PAINT_INDEX_UP    (1.30)
 *   拇指(4)  弯曲        ext ≤ PAINT_OTHER_DOWN  (1.20)
 *   中指(12) 弯曲        ext ≤ PAINT_OTHER_DOWN
 *   无名指(16) 弯曲      ext ≤ PAINT_OTHER_DOWN
 *   小指(20) 弯曲        ext ≤ PAINT_OTHER_DOWN
 *
 * 与「比耶」的互斥性（需求明确要求不冲突）：
 *   比耶要求 食指+中指 同时伸直；
 *   本手势要求 中指 必须弯曲（ext ≤ 1.20，而比耶要求 ≥ 1.30）。
 *   两个区间的阈值不重叠，因此同一帧内不可能同时判定为两者。
 *   代码里也额外用 isPeace 做了一次兜底排除。
 *
 * 伸直度公式与比耶完全一致（尺度无关，不需标定）：
 *     ext = |腕→TIP| / |腕→PIP|
 *
 * @param {Array<{x:number,y:number,z:number}>} landmarks
 * @param {number} aspect 画面宽高比
 * @param {boolean} isPeace 本帧是否已判定为比耶（互斥兜底）
 * @returns {boolean}
 */
function detectPaintGesture(landmarks, aspect, isPeace) {
  /* 互斥兜底：已经判定为比耶就不再判绘画 */
  if (isPeace) return false;

  const thumb = landmarks[HAND.THUMB_TIP];
  const index = landmarks[HAND.INDEX_TIP];
  const middle = landmarks[HAND.MIDDLE_TIP];
  const ring = landmarks[HAND.RING_TIP];
  const pinky = landmarks[HAND.PINKY_TIP];
  const wrist = landmarks[HAND.WRIST];

  if (!thumb || !index || !middle || !ring || !pinky || !wrist) return false;

  const wx = wrist.x * aspect;
  const wy = wrist.y;

  /* 局部工具：某指尖相对手腕的归一化伸出度 */
  const ext = (tip, pipId) => {
    const pip = landmarks[pipId];
    if (!pip) return 0;
    const dTip = dist2D({ x: wx, y: wy }, { x: tip.x * aspect, y: tip.y });
    const dPip = dist2D({ x: wx, y: wy }, { x: pip.x * aspect, y: pip.y });
    return dTip / Math.max(1e-6, dPip);
  };

  /* 拇指没有 PIP 常用点，这里用 MCP(2) 作为基准关节 */
  const thumbExt = ext(thumb, 2);
  const indexExt = ext(index, HAND.INDEX_PIP);
  const middleExt = ext(middle, HAND.MIDDLE_PIP);
  const ringExt = ext(ring, HAND.RING_PIP);
  const pinkyExt = ext(pinky, HAND.PINKY_PIP);

  const indexUp = indexExt >= CONFIG.PAINT_INDEX_UP;
  const othersDown = thumbExt <= CONFIG.PAINT_OTHER_DOWN &&
                     middleExt <= CONFIG.PAINT_OTHER_DOWN &&
                     ringExt <= CONFIG.PAINT_OTHER_DOWN &&
                     pinkyExt <= CONFIG.PAINT_OTHER_DOWN;

  return indexUp && othersDown;
}

/**
 * 手掌中心 → 屏幕 NDC（-1~1），用于绑定拱桥端点
 * ============================================================================
 * 【致命修复二】完整数学推演（务必与代码逐行对照）
 * ----------------------------------------------------------------------------
 * 一、坐标系事实
 *   ① MediaPipe 的 landmark.x / y 是【原始摄像头画面】的归一化坐标：
 *        x = 0 → 画面最左边缘；x = 1 → 画面最右边缘
 *        y = 0 → 画面顶部；    y = 1 → 画面底部
 *      注意：这两个值【已经】是相对画面自身的归一化值，
 *            **不需要也不应该**再乘宽高比（见下方第 2 点的 Bug 说明）。
 *   ② <video> 有 CSS transform: scaleX(-1)，画面镜像显示：
 *        原始画面最左(x=0) → 显示在屏幕【最右】
 *        原始画面最右(x=1) → 显示在屏幕【最左】
 *   ③ NDC 约定：x = -1 屏幕最左，x = +1 屏幕最右；y = -1 底部，y = +1 顶部
 *
 * 二、把归一化坐标转成 NDC
 *       screenX(镜像后) = 1 - rawX          （因为镜像会翻转左右）
 *       ndcX = screenX × 2 - 1 = (1 - rawX) × 2 - 1 = 1 - 2·rawX
 *       ndcY = 1 - 2·rawY                   （画布 y 向下，NDC y 向上）
 *
 *   交叉验证（这是本次修复的关键，务必核对符号）：
 *     rawX = 0.0 → ndcX = +1 → 世界 +halfW → 屏幕【最右】✔（镜象一致）
 *     rawX = 0.5 → ndcX =  0 → 世界 0      → 屏幕【正中】✔
 *     rawX = 1.0 → ndcX = -1 → 世界 -halfW → 屏幕【最左】✔
 *
 * 三、★ 之前“拱桥飘在半空 / 贴不上手”的真正原因 ★
 *   旧代码在算 NDC 之前先做了 `rawX += p.x * aspect`。
 *   当 aspect = 16/9 ≈ 1.78 时，rawX 被放大约 1.78 倍，
 *   于是 `ndcX = 1 - 2·(p.x × 1.78)` 的值域变成 [1, -2.56]，
 *   **远远超出 [-1, 1]** —— 桥头因此被推到屏幕外，看起来就是“飘着”。
 *   修复：NDC 阶段【绝不】乘 aspect。宽高比补偿放到后面
 *   “NDC → 世界坐标”那一步（通过 halfW = halfH × 屏宽/屏高 完成），
 *   这才是正确的位置：NDC 是无量纲的，屏宽比只影响它对应的世界尺寸。
 *
 * 四、宽高比补偿的正确位置（对应需求“X 轴乘以宽高比补偿”）
 *       halfH = tan(FOV/2) × CAMERA_Z
 *       halfW = halfH × (screenW / screenH)     ← 这里才是宽高比补偿
 *       worldX = ndcX × halfW
 *       worldY = ndcY × halfH
 *   这样在 16:9 的屏幕上，横向可视范围本来就比纵向宽 1.78 倍，
 *   桥头与手掌在屏幕上的相对位置才完全一致。
 *
 * @param {Array<{x:number,y:number,z:number}>} landmarks 21 个归一化关键点
 * @returns {{sx:number, sy:number, sz:number}} sx/sy 为屏幕 NDC，sz 为原始深度
 */
function palmCenterNormalized(landmarks) {
  const ids = HAND.PALM_CENTER_IDS;
  let rawX = 0;
  let rawY = 0;
  let sz = 0;
  for (let i = 0; i < ids.length; i++) {
    const p = landmarks[ids[i]];
    rawX += p.x;          /* 【修复】这里不再乘 aspect */
    rawY += p.y;
    sz += p.z;
  }
  const inv = 1 / ids.length;
  rawX *= inv;
  rawY *= inv;
  sz *= inv;

  return { sx: 1 - rawX * 2, sy: 1 - rawY * 2, sz: sz };
}

/**
 * 取食指指尖（Keypoint 8）的屏幕 NDC，用于绑定拱桥端点
 * 【附加修复】拱桥两端必须绑在左右手的【食指指尖（Keypoint 8）】上，
 * 而不是手掌根（Keypoint 9）。这样：
 *   · 左手高、右手低时，桥身会自然倾斜（因为两端 Y 各自独立来自两只手）
 *   · 手指尖是用户主动指向的位置，视觉上最贴合“从指尖拉出一条光桥”的直觉
 *
 * 映射公式与 palmCenterNormalized 完全一致（见该函数上方的推演）：
 *     ndcX = 1 - 2·rawX      （镜像显示 → 翻转左右）
 *     ndcY = 1 - 2·rawY      （画布 y 向下 → 世界 y 向上）
 * 单点直取，不做平均、不加任何硬编码偏移。
 *
 * @param {Array<{x:number,y:number,z:number}>} landmarks
 * @returns {{sx:number, sy:number, sz:number}} 屏幕 NDC（-1~1）
 */
function indexTipNdc(landmarks) {
  const p = landmarks[HAND.INDEX_TIP];   /* INDEX_TIP = 8 */
  return { sx: 1 - p.x * 2, sy: 1 - p.y * 2, sz: p.z };
}

/**
 * 【新增】计算单只手的归一化捏合度（Pinch）
 * ============================================================================
 * 数学定义：
 *   dPinch = |拇指尖(4) − 食指指尖(8)|          ← 捏合的距离
 *   dPalm  = |手腕(0)  − 中指根(9)|             ← 掌宽，作为尺度基准
 *   pinchNorm = dPinch / dPalm                  ← 与手部远近无关的比值
 *
 * 为什么要除以掌宽：
 *   直接用手在画面里的像素距离，会随“手离摄像头远近”大幅变化 ——
 *   手伸远一点，捏合距离就变小，桥会莫名其妙缩小。
 *   除以掌宽后得到无量纲比值，远近、换手都不需要重新标定。
 *
 * 为什么要做 aspect 校正：
 *   MediaPipe 的 x、y 是分别对画面宽、高归一化的，
 *   所以横向距离必须先乘 aspect（宽/高）才能和纵向距离正确求欧氏距离，
 *   否则 16:9 画面里横向距离会被系统性低估。
 *
 * 安全保证（需求明确要求不得出现负数或 Infinity）：
 *   · 分母用 Math.max(mcpDist, 1e-4) 兜底 → 永不除零
 *   · 结果用 Number.isFinite 检查 → 非有限值直接返回 0
 *   · 返回值再 clamp 到 [0, 3] → 既不可能是负数，也不可能是 Infinity
 *
 * @param {Array<{x:number,y:number,z:number}>} landmarks
 * @param {number} aspect 画面宽高比
 * @returns {number} 归一化捏合度（约 0.1 捏紧 ~ 1.3 全张），失败时为 0
 */
function computePinchNorm(landmarks, aspect) {
  const thumb = landmarks[HAND.THUMB_TIP];
  const index = landmarks[HAND.INDEX_TIP];
  const wrist = landmarks[HAND.WRIST];
  const mcp = landmarks[HAND.MIDDLE_MCP];

  if (!thumb || !index || !wrist || !mcp) return 0;

  /* 捏合距离（横向做 aspect 校正，与 computeRawTension 保持一致） */
  const dx = (index.x - thumb.x) * aspect;
  const dy = index.y - thumb.y;
  const pinchDist = Math.sqrt(dx * dx + dy * dy);

  /* 掌宽（同样做 aspect 校正） */
  const mx = (mcp.x - wrist.x) * aspect;
  const my = mcp.y - wrist.y;
  const palmDist = Math.sqrt(mx * mx + my * my);

  /* 防除零：掌宽至少取 1e-4，保证结果有限 */
  const norm = pinchDist / Math.max(1e-4, palmDist);

  /* 再兜一层：任何 NaN / Infinity 都退回 0 */
  if (!Number.isFinite(norm)) return 0;

  /* 上限 3 已远超合理范围（真实值约 0.1~1.3），仅作防御 */
  return clamp(norm, 0, 3);
}


/**
 * 把屏幕 NDC 坐标（-1~1）换算成 z=0 平面上的世界坐标
 * NDC 的 x=+1 对应世界 +halfW（屏幕右缘），y=+1 对应世界 +halfH（屏幕上缘）。
 */
function normalizedToWorld(nx, ny, out) {
  const halfH = Math.tan((CONFIG.CAMERA_FOV * Math.PI) / 360) * CONFIG.CAMERA_Z;
  const halfW = halfH * (window.innerWidth / Math.max(1, window.innerHeight));
  out.set(nx * halfW, ny * halfH, 0);
  return out;
}

/**
 * 判断食指(8)与中指(12)是否伸直、无名指(16)与小指(20)是否弯曲
 * ----------------------------------------------------------------------------
 * 【修复六】比耶（✌）手势判定 —— 放宽阈值 + 排除“张开手掌”
 *
 * 伸直度公式（与手部远近无关，因此不需要标定）：
 *     ext = |腕→指尖| / |腕→PIP 关节|
 *   伸直时指尖明显更远 → ext ≈ 1.5 ~ 1.9
 *   弯曲时指尖缩向掌心 → ext ≈ 0.9 ~ 1.1
 *
 * 判定条件（三条同时满足）：
 *   ① 食指(8)、中指(12) 伸直   ext ≥ PEACE_EXTEND_RATIO (1.30)
 *   ② 无名指(16)、小指(20) 弯曲 ext ≤ PEACE_BEND_RATIO   (1.10)
 *   ③ 食指与中指靠得比较近（张开度小），排除“五指张开”
 *
 * 为什么需要第 ③ 条：
 *   五指张开时食指、中指也是伸直的，如果只判 ①②，某些手型下
 *   无名指/小指的伸直度可能刚好落在 1.10 以下，就会把“绽放”手势误判成比耶，
 *   导致花朵本该盛开却突然变成文字。
 *   比耶时食指与中指基本并拢，张开手掌时它们分得很开，用两者的距离
 *   除以掌宽（腕→中指根）作为一个与尺度无关的判据就能区分。
 *
 * @param {Array<{x:number,y:number,z:number}>} landmarks
 * @param {number} aspect
 * @returns {boolean}
 */
function detectPeaceGesture(landmarks, aspect) {
  /* 局部工具：某根手指的伸直度 ext = |腕→TIP| / |腕→PIP| */
  const extension = (tipId, pipId) => {
    const w = landmarks[HAND.WRIST];
    const wx = w.x * aspect;
    const wy = w.y;
    const tip = landmarks[tipId];
    const pip = landmarks[pipId];
    const dTip = dist2D({ x: wx, y: wy }, { x: tip.x * aspect, y: tip.y });
    const dPip = dist2D({ x: wx, y: wy }, { x: pip.x * aspect, y: pip.y });
    return dTip / Math.max(1e-6, dPip);
  };

  const indexExt = extension(HAND.INDEX_TIP, HAND.INDEX_PIP);
  const middleExt = extension(HAND.MIDDLE_TIP, HAND.MIDDLE_PIP);
  const ringExt = extension(HAND.RING_TIP, HAND.RING_PIP);
  const pinkyExt = extension(HAND.PINKY_TIP, HAND.PINKY_PIP);

  const indexUp = indexExt >= CONFIG.PEACE_EXTEND_RATIO;
  const middleUp = middleExt >= CONFIG.PEACE_EXTEND_RATIO;
  const ringDown = ringExt <= CONFIG.PEACE_BEND_RATIO;
  const pinkyDown = pinkyExt <= CONFIG.PEACE_BEND_RATIO;

  if (!(indexUp && middleUp && ringDown && pinkyDown)) return false;

  /* ③ 食指与中指必须相对并拢：两者指尖距离 / 掌宽 < 0.55。
     张开手掌时这个比值通常 > 0.8，比耶时约 0.2~0.4。 */
  const w = landmarks[HAND.WRIST];
  const wx = w.x * aspect;
  const wy = w.y;
  const palmWidth = dist2D({ x: wx, y: wy }, {
    x: landmarks[HAND.MIDDLE_MCP].x * aspect,
    y: landmarks[HAND.MIDDLE_MCP].y
  });
  const fingerGap = dist2D(
    { x: landmarks[HAND.INDEX_TIP].x * aspect, y: landmarks[HAND.INDEX_TIP].y },
    { x: landmarks[HAND.MIDDLE_TIP].x * aspect, y: landmarks[HAND.MIDDLE_TIP].y }
  );
  const gapRatio = fingerGap / Math.max(1e-6, palmWidth);
  if (gapRatio > 0.55) return false;

  return true;
}

/**
 * 【致命问题二】坐标全量平滑 + 异常帧过滤
 * ============================================================================
 * 规则：
 *   1. 手部中心（用 Keypoint 9 中指根代表整体位置）单帧跳动超过屏幕宽度的
 *      20% → 判定为识别抽风，【整帧丢弃】，返回上一帧的平滑结果。
 *   2. 通过校验后，对全部 21 个点执行：smoothed += (raw - smoothed) * 0.2
 *
 * 为什么用"整帧丢弃"而不是逐点吸附：
 *   逐点各自判断会导致一帧里一半点更新、一半点不更新，
 *   骨架被撕成两段 —— 这正是画面撕裂/乱飞的来源。
 *   整帧一起丢弃，骨架始终是一个完整、连续的整体。
 *
 * @param {Array<Array<{x:number,y:number,z:number}>>} rawList
 * @returns {Array<Array<{x:number,y:number,z:number}>>} 平滑后的关键点
 */
function smoothHandLandmarks(rawList) {
  if (!rawList || rawList.length === 0) {
    state.smoothList = null;
    return rawList;
  }

  /* 首次 / 手数变化：直接建副本，不做插值（否则会从上一只手的位置长出来） */
  if (!state.smoothList || state.smoothList.length !== rawList.length) {
    state.smoothList = rawList.map((hand) => hand.map((p) => ({ x: p.x, y: p.y, z: p.z })));
    return state.smoothList;
  }

  /* ---- 异常帧过滤：用 Keypoint 9 代表手部整体 ----
   * dx 超过屏幕宽度 15%、或 dy 超过屏幕高度 15% → 识别抽风，整帧丢弃。 */
  const aspect = (dom.video.videoWidth || 4) / Math.max(1, dom.video.videoHeight || 3);
  const JUMP_LIMIT = 0.15;

  for (let h = 0; h < rawList.length; h++) {
    const raw = rawList[h];
    const sm = state.smoothList[h];
    if (!raw || !sm || !raw[HAND.MIDDLE_MCP] || !sm[HAND.MIDDLE_MCP]) continue;

    const r = raw[HAND.MIDDLE_MCP];
    const s = sm[HAND.MIDDLE_MCP];
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;

    const dx = Math.abs(r.x - s.x);
    const dy = Math.abs(r.y - s.y);

    /* 任一轴超过 15% → 丢弃这一帧，保持上一帧坐标 */
    if (dx > JUMP_LIMIT || dy > JUMP_LIMIT) {
      return state.smoothList;
    }
  }

  /* ---- EMA 指数移动平均：smoothed = smoothed*0.7 + target*0.3 ---- */
  const KEEP = 0.7;
  const NEW = 0.3;
  for (let h = 0; h < rawList.length; h++) {
    const raw = rawList[h];
    const sm = state.smoothList[h];
    if (!raw || !sm) continue;

    const n = Math.min(raw.length, sm.length);
    for (let i = 0; i < n; i++) {
      const r = raw[i];
      const s = sm[i];
      if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;

      s.x = s.x * KEEP + r.x * NEW;
      s.y = s.y * KEEP + r.y * NEW;
      s.z = s.z * KEEP + (Number.isFinite(r.z) ? r.z : 0) * NEW;
    }
  }

  return state.smoothList;
}

/**
 * MediaPipe 结果回调：拿到 21 个关键点 → 计算 tension → 更新指针目标
 * @param {{multiHandLandmarks?: Array<Array<{x:number,y:number,z:number}>>}} results
 */
function onHandResults(results) {
  const list = (results && results.multiHandLandmarks) ? results.multiHandLandmarks : [];

  /* 【排错修复】演示模式下直接丢弃识别结果。
   * MediaPipe 的 hands.send() 回调是异步的，用户切到演示模式的那一刻，
   * 可能还有一个“在途”的回调随后返回；如果不拦住，它会用旧的手部数据
   * 覆盖掉演示模式正在生成的 pointerTarget（表现为花朵跟随突然跳一下）。 */
  if (state.demoMode) {
    state.handLandmarksList = [];
    state.landmarkCount = 0;
    state.handPresent = false;
    return;
  }

  /* ==========================================================================
   * 【修复五】丢手宽限期
   * --------------------------------------------------------------------------
   * 以前 list 为空就立刻 landmarkCount=0、清空列表 → 手稍微一晃，
   * 骨架瞬间消失、花朵目标归零，看起来就是"闪一下"。
   * 现在：
   *   · 宽限期内（HAND_GRACE_FRAMES 帧）：完全保留上一帧的 landmarks /
   *     landmarkCount / drawActive，什么都不清 —— 手短暂出画不会打断笔迹；
   *   · 超过宽限期：才真正清空并让所有效果平滑渐隐。
   * ========================================================================== */
  if (list.length === 0) {
    state.handLostFrames++;

    if (state.handLostFrames <= CONFIG.HAND_GRACE_FRAMES && state.handLandmarksList.length > 0) {
      /* 宽限期内：什么都不做，沿用上一帧的平滑数据 */
      return;
    }

    /* 宽限期已过：彻底清空（并【修复泄漏】重置所有手势状态） */
    state.smoothList = null;
    state.handLandmarksList = [];
    state.landmarkCount = 0;
    state.handPresent = false;
    state.peaceActive = false;
    /* ★ 关键修复：这里原先漏了 drawActive。
     * 漏掉的后果是：手离开画面后 drawActive 永远保持 true，
     *   → updatePaintEffect 继续在最后位置喷粒子
     *   → drawAlpha 恒为 1 → 花朵永久隐藏
     * 这就是"绘画后花朵再也回不来"的根因。 */
    state.drawActive = false;
    return;
  }

  /* 检测到手：清零丢失计数 */
  state.handLostFrames = 0;

  /* 【修复五】先对原始坐标做低通滤波，后续全部使用平滑后的数据 */
  const smoothed = smoothHandLandmarks(list);
  state.handLandmarksList = smoothed;
  state.landmarkCount = smoothed.length;

  if (smoothed.length > 0) {
    /* 【排错修复】手“重新回到画面”时清空滑动窗口。
     * 背景：手离开画面期间，updateGestureState 会持续往窗口里推入
     * 逐步衰减到 0 的样本；手一回来，窗口里仍是这些旧的 0 值，
     * 新张开度要等 5 帧才被“平均”出来，手感上就是明显迟滞。
     * 用 handPresent 只在“从无到有”的那一刻清一次，
     * 既消除了迟滞，又不会破坏正常跟手时的平滑效果。 */
    if (!state.handPresent) {
      state.tensionWindow.length = 0;
      state.handPresent = true;
    }

    state.lastHandSeenAt = performance.now();

    /* 【修复五】landmarks 现在指向【平滑后】的数据 */
    const landmarks = smoothed[0];
    const handCount = smoothed.length;
    const aspect = (dom.video.videoWidth || 4) / (dom.video.videoHeight || 3);

    /* ---- ① 计算原始张开度 ---- */
    const raw = computeRawTension(landmarks, aspect);
    state.rawTension = raw;

    /* ---- ② 滑动窗口平均（抑制单帧噪声） ---- */
    pushTensionSample(raw);

    /* ---- ③ 由指尖位置更新跟随目标 ---- */
    updatePointerTarget(landmarks);

    /* ---- ④【新增·任务二】比耶（✌）手势检测 ---- */
    state.peaceActive = detectPeaceGesture(landmarks, aspect);

    /* ---- ④.5【修复二】单指绘画手势检测 ----
     * ==========================================================================
     * 【如何区分"单手单指"与"双手"】——这是本次修复的核心，务必看清楚：
     *
     *   ① 手数门槛（新增，最关键）
     *        必须 handCount === 1。
     *        上一版只把 list[0] 丢给检测函数，完全没看手数，
     *        于是"双手都只伸食指"时 hand[0] 满足条件 → 误触发绘画。
     *        现在只要检测到 2 只手，drawActive 直接强制为 false。
     *
     *   ② 手型门槛（沿用 detectPaintGesture）
     *        食指(8) 伸直：ext ≥ PAINT_INDEX_UP (1.30)
     *        拇指(4)、中指(12)、无名指(16)、小指(20) 全部弯曲：
     *                     ext ≤ PAINT_OTHER_DOWN (1.20)
     *        任一根达不到就不算"单指"。
     *
     *   ③ 与比耶互斥
     *        比耶要求 中指 ext ≥ 1.30；绘画要求 中指 ext ≤ 1.20，
     *        两个区间不重叠，数学上不可能同时成立；代码再把 peaceActive
     *        作为参数传进去做第二重兜底。
     *
     * 三者同时满足才进入绘画模式，因此"双手单指"和"单手比耶"都不会误触。
     * ========================================================================== */
    state.drawActive = (handCount === 1) &&
      detectPaintGesture(landmarks, aspect, state.peaceActive);

    /* 绘画位置：食指指尖(8) → 屏幕 NDC → 世界坐标。
     * 【坐标系一致性】复用 indexTipNdc()，它与拱桥端点、骨骼绘制使用完全相同的
     * 镜像补偿公式 ndcX = 1 - 2·rawX，因此"手在屏幕右侧 → 笔迹也在右侧"。 */
    if (state.drawActive) {
      const tipNdc = indexTipNdc(landmarks);
      normalizedToWorld(tipNdc.sx, tipNdc.sy, state.drawPointerWorld);
      state.drawPointerWorld.z = CONFIG.PAINT_Z;
    }

    /* ---- ⑤【新增·任务三】用「手掌中心」作为大范围跟随的锚点 ----
     * 这里直接覆写 pointerTarget：手掌中心比指尖稳定得多，配合
     * POINTER_STRENGTH_SCALE 放大后，花朵能大幅横跨屏幕且不抖。 */
    const mainPalm = palmCenterNormalized(landmarks);
    normalizedToWorld(mainPalm.sx, mainPalm.sy, state.pointerTarget);
    state.pointerTarget.multiplyScalar(CONFIG.POINTER_STRENGTH_SCALE);

    /* ---- ⑥【附加修复】拱桥端点：1:1 绑定左右手【食指指尖 Keypoint 8】----
     *
     * 需求：起点 X/Y 必须【绝对等于】左手食指指尖（Keypoint 8）的屏幕坐标，
     *       终点 X/Y 必须【绝对等于】右手食指指尖（Keypoint 8）的屏幕坐标，
     *       严禁任何硬编码偏移；且左手高右手低时桥身要自然倾斜。
     *
     * 实现要点：
     *   · 用 indexTipNdc() 直接取第 8 点，不做多点平均（平均会带来偏置）
     *   · 两端 Y 各自独立来自两只手的指尖 → 高度不同时桥自然倾斜，
     *     而不是被强行拉平（这一点是“绑 Keypoint 9”做不到的）
     *   · 映射公式见 palmCenterNormalized 上方的完整推演：
     *       ndcX = 1 - 2·rawX ,  ndcY = 1 - 2·rawY
     *     rawX ∈ [0,1] 直接来自 MediaPipe，**不乘 aspect**（乘了会溢出，这是“飘空”的根因）
     *   · 宽高比补偿在 NDC → 世界那一步：
     *       halfW = halfH × (window.innerWidth / window.innerHeight)
     *     16:9 屏上横向可视范围本就比纵向宽 1.78 倍，桥头才与指尖严丝合缝
     *   · 左右判定按 NDC 的 x 排序（x 小者在屏幕左侧 = 左手），
     *     不依赖 MediaPipe 的返回顺序，桥不会左右颠倒
     *
     * 数值验证（16:9 屏幕、FOV 55°、CAMERA_Z 6.2）：
     *   halfH = tan(27.5°) × 6.2 ≈ 3.23
     *   halfW = 3.23 × (1920/1080) ≈ 5.74
     *   左手在画面最左 rawX=0 → ndcX=+1 → worldX=+5.74（屏幕右缘）✔
     *   右手在画面最右 rawX=1 → ndcX=-1 → worldX=-5.74（屏幕左缘）✔
     *   两只手都在 x 世界坐标的合法范围内，不会出现“飘在空中”。 */
    if (handCount > 1) {
      /* 【附加修复】直接取食指指尖（Keypoint 8），不做平均、不加偏移。
         两端各自独立来自两只手 → 左手高右手低时桥身自然倾斜。
         【修复五】这里取的是【平滑后】的 smoothed，不是 MediaPipe 原始坐标，
         否则桥头会跟着手部高频抖动一起"抽风"。 */
      const kpA = indexTipNdc(smoothed[0]);
      const kpB = indexTipNdc(smoothed[1]);

      /* 以屏幕 NDC 的 x 判断左右（x 越小越靠屏幕左） */
      const aIsLeft = kpA.sx <= kpB.sx;
      const left = aIsLeft ? kpA : kpB;
      const right = aIsLeft ? kpB : kpA;

      state.handLeftNdc.set(left.sx, left.sy);
      state.handRightNdc.set(right.sx, right.sy);

      /* NDC → 世界（每帧换算，保证与屏幕严格对齐） */
      normalizedToWorld(left.sx, left.sy, state.handLeftWorld);
      normalizedToWorld(right.sx, right.sy, state.handRightWorld);

      state.secondHandWorld.copy(state.handRightWorld);
      state.secondHandSeenAt = performance.now();

      /* 主手锚点取两只手的中点，让花朵落在两人之间 */
      state.pointerTarget.set(
        (state.handLeftWorld.x + state.handRightWorld.x) * 0.5,
        (state.handLeftWorld.y + state.handRightWorld.y) * 0.5,
        state.pointerTarget.z
      );

      /* ---- ⑦【交互修复二】双手捏合：取两只手的【平均值】 ----
       * 需求明确要求“将这两个距离的平均值映射到拱桥厚度”。
       *
       * 上一版用的是 Math.min（取捏得更紧的那只），现已按需求改为平均值：
       *   pinchNorm = (pinchA + pinchB) / 2
       * 平均的好处是双手对称操作时手感线性：
       *   两只手同时捏紧 → 桥明显变细；两只手同时张开 → 明显变粗；
       *   一手紧一手松 → 中间状态，符合“平均值”的直觉。
       *
       * 每个 pinchX 都已经是 dPinch / dPalm 的比值（与手距无关），
       * 且 computePinchNorm 内部已保证有限、非负（防除零 + isFinite + clamp）。 */
      const pinchA = computePinchNorm(smoothed[0], aspect);
      const pinchB = computePinchNorm(smoothed[1], aspect);
      state.pinchNorm = (pinchA + pinchB) * 0.5;
      state.pinchRawCount = 2;
    } else {
      /* 只有一只手：把两端都设成这只手的位置（桥长度为 0），
         同时 bridgeAlpha 会趋近 0，所以实际不会被看到；
         这样避免了“另一端点停在上一次的位置、桥突然拉出一条长线”的问题。 */
      state.handLeftNdc.copy(state.handRightNdc);
      state.handLeftWorld.copy(state.handRightWorld);

      /* 单手时也持续更新捏合度，这样第二只手一入画，缩放/厚度已经是正确值，
         不会出现“桥先弹出默认大小再缩到正确尺寸”的跳变。
         注意这里用 landmarks（= smoothed[0]），与其他处保持一致。 */
      state.pinchNorm = computePinchNorm(landmarks, aspect);
      state.pinchRawCount = 1;
    }

    /* 主手手掌中心（世界坐标），供文字跟随使用。
     * 这里存【原始值】，平滑在渲染阶段做，避免锚点比真实手慢半拍。 */
    normalizedToWorld(mainPalm.sx, mainPalm.sy, state.handCenterWorld);
  }
}

/**
 * 计算手掌张开度 tension 的原始值（0~1）
 * ----------------------------------------------------------------------------
 * 【公式说明】
 *   设手腕为 W，四根手指的掌指关节（MCP）为 M1..M4，五根手指的指尖为 T1..T5。
 *   先做纵横比校正：x 乘以 aspect（宽/高），使归一化坐标恢复成等比几何，
 *   否则 16:9 画面里横向距离会被系统性放大。
 *
 *      dTip = ( |W→T1| + |W→T2| + ... + |W→T5| ) / 5      // 平均腕-指尖距离
 *      dMcp = ( |W→M1| + |W→M2| + |W→M3| + |W→M4| ) / 4   // 平均腕-掌指关节距离
 *      ratio = dTip / dMcp
 *
 *   这个比值是「尺度无关」的：手离镜头远近会同时改变分子分母，
 *   因此换手、换距离都不需要重新标定。
 *
 *   握拳时指尖卷回掌心 → ratio ≈ 1.02；完全张开时 → ratio ≈ 1.90。
 *   线性归一化后再套一条 gamma 曲线让中段响应更敏感：
 *
 *      tension = clamp( (ratio - RATIO_FIST) / (RATIO_OPEN - RATIO_FIST), 0, 1 ) ^ gamma
 *
 *   （RATIO_OPEN - RATIO_FIST）就是“全量程”，收窄它等于放大比例，
 *   因此手部同样的张合幅度会产生更大的 tension 变化。
 *
 * @param {Array<{x:number,y:number,z:number}>} landmarks 21 个归一化关键点
 * @param {number} aspect 画面宽高比
 * @returns {number} 0（完全握拳）~ 1（完全张开）
 */
function computeRawTension(landmarks, aspect) {
  /* 坐标校正：x 乘 aspect，y 不变（MediaPipe 的 x,y 都是相对画面宽高的归一化值） */
  const px = (i) => landmarks[i].x * aspect;
  const py = (i) => landmarks[i].y;

  const wx = px(HAND.WRIST);
  const wy = py(HAND.WRIST);

  /* 平均腕→指尖距离 */
  let tipSum = 0;
  for (let i = 0; i < HAND.TIP_IDS.length; i++) {
    const id = HAND.TIP_IDS[i];
    tipSum += dist2D({ x: wx, y: wy }, { x: px(id), y: py(id) });
  }
  const dTip = tipSum / HAND.TIP_IDS.length;

  /* 平均腕→掌指关节距离 */
  let mcpSum = 0;
  for (let i = 0; i < HAND.MCP_IDS.length; i++) {
    const id = HAND.MCP_IDS[i];
    mcpSum += dist2D({ x: wx, y: wy }, { x: px(id), y: py(id) });
  }
  const dMcp = mcpSum / HAND.MCP_IDS.length;

  /* 比值（加一个极小量防止除零） */
  const ratio = dTip / Math.max(1e-6, dMcp);

  /* 线性归一化到 0~1 */
  let t = (ratio - CONFIG.RATIO_FIST) / (CONFIG.RATIO_OPEN - CONFIG.RATIO_FIST);
  t = clamp(t, 0, 1);

  /* gamma 曲线：TENSION_GAMMA < 1 时中段更敏感，手感更跟手 */
  t = Math.pow(t, CONFIG.TENSION_GAMMA);

  return t;
}

/**
 * 把最新的原始 tension 推入滑动窗口，并更新窗口均值
 * （滑动窗口平均 = 抗单帧抖动；后面还有一层指数平滑）
 */
function pushTensionSample(raw) {
  state.tensionWindow.push(raw);
  if (state.tensionWindow.length > CONFIG.TENSION_WINDOW) {
    state.tensionWindow.shift();
  }
  let sum = 0;
  for (let i = 0; i < state.tensionWindow.length; i++) {
    sum += state.tensionWindow[i];
  }
  state.windowedTension = sum / state.tensionWindow.length;
}

/* ============================================================================
 * 【修复一】手部坐标 → Three.js 世界坐标 的映射（含完整数学推演）
 * ----------------------------------------------------------------------------
 * 坐标系事实（务必对齐，此前的方向错误就出在这里）：
 *   ① MediaPipe 的 landmark.x 是【原始摄像头画面】的归一化坐标：
 *        x = 0 → 画面最左边缘；x = 1 → 画面最右边缘
 *   ② <video id="cam"> 有 CSS `transform: scaleX(-1)`，所以画面是【镜像】显示的：
 *        原始画面最左(x=0)  → 显示在屏幕【最右】
 *        原始画面最右(x=1)  → 显示在屏幕【最左】
 *   ③ Three.js 相机在 +Z 看向原点，世界 X 正方向 → 屏幕【右侧】
 *
 * 目标行为：用户手往屏幕右侧移动，花朵也往屏幕右侧移动。
 *
 * 推导：
 *   设 rawX ∈ [0,1] 为原始归一化 x。镜像后它在屏幕上的横向位置比例是 (1 - rawX)。
 *   → 屏幕左边缘对应 rawX=1；屏幕右边缘对应 rawX=0。
 *   Three 世界坐标要与屏幕左右一致，因此：
 *
 *       screenNdcX = (1 - rawX) * 2 - 1 = 1 - 2·rawX
 *       worldX     = screenNdcX * usableX
 *
 * 代入三点交叉验证（usableX 取 1 便于看清符号）：
 *   · 手在画面最左 rawX=0 → screenNdcX = +1 → worldX = +1 → 花朵在屏幕【右】✔
 *     （正确：镜像后它确实显示在屏幕右边，花朵跟着在右边）
 *   · 手在画面正中 rawX=0.5 → screenNdcX = 0 → worldX = 0 → 花朵正【中】✔
 *   · 手在画面最右 rawX=1 → screenNdcX = -1 → worldX = -1 → 花朵在屏幕【左】✔
 *
 * Y 轴：landmark.y 是自上而下（0=顶部，1=底部），而世界 Y 向上为正，故需要翻转：
 *       screenNdcY = 1 - 2·rawY  → 手上抬(y 变小) 时 worldY 变大(向上) ✔
 *
 * ★ 与上一个版本的差异 ★
 *   旧代码写的是 ndcX = 1 - 2·nx，符号与上式完全一致，本是自洽的；
 *   但旧版本随后在 onHandResults 里用 palmCenterNormalized() 的
 *   `0.5 - sx` 覆盖了 pointerTarget，而那个式子把整条链路的符号反了一次，
 *   两处不一致最终就表现为“挥手时花朵往反方向跑”。
 *   现在两者统一到同一个约定：screenNdc = 1 - 2·raw（见 palmCenterNormalized）。
 * ========================================================================== */
function updatePointerTarget(landmarks) {
  const tip = landmarks[HAND.INDEX_TIP];      // 食指尖
  const mcp = landmarks[HAND.INDEX_MCP];      // 食指根（用于抑制手腕旋转造成的抖动）

  /* 用「指尖与指根的中点」更稳定，同时保留指尖的灵活性 */
  const nx = (tip.x + mcp.x) * 0.5;
  const ny = (tip.y + mcp.y) * 0.5;
  const nz = tip.z;

  /* 镜像 + 映射到 -1~1（推导见上方注释） */
  const ndcX = 1 - nx * 2;
  const ndcY = 1 - ny * 2;

  /* 计算 z=0 平面上的可视半宽 / 半高，据此把 -1~1 映射成世界单位 */
  const halfH = Math.tan((CONFIG.CAMERA_FOV * Math.PI) / 360) * CONFIG.CAMERA_Z;
  const halfW = halfH * (window.innerWidth / Math.max(1, window.innerHeight));

  /* 预留出花朵本身的半径，避免花朵被推出画面 */
  const usableX = Math.max(0.2, halfW - CONFIG.FLOWER_RADIUS * 0.85) * CONFIG.POINTER_STRENGTH * CONFIG.POINTER_STRENGTH_SCALE;
  const usableY = Math.max(0.2, halfH - CONFIG.FLOWER_RADIUS * 0.85) * CONFIG.POINTER_STRENGTH * CONFIG.POINTER_STRENGTH_SCALE;

  state.pointerTarget.set(
    clamp(ndcX, -1.2, 1.2) * usableX,
    clamp(ndcY, -1.2, 1.2) * usableY,
    clamp(-nz * 8.0, -1, 1) * CONFIG.POINTER_Z_GAIN
  );
}

/**
 * 手部识别主循环：约 30FPS 把视频帧喂给 MediaPipe
 * （用 while + await 顺序执行，天然避免 hands.send 重入导致的卡顿）
 */
async function handsLoop() {
  if (handsLoopRunning) return;
  handsLoopRunning = true;

  while (state.running && state.handsReady && !state.demoMode && !state.pageHidden) {
    const t0 = performance.now();

    const canSend =
      !handsSendBusy &&
      dom.video.readyState >= 2 &&
      dom.video.videoWidth > 0 &&
      !dom.video.paused;

    if (canSend) {
      handsSendBusy = true;
      try {
        await hands.send({ image: dom.video });
        handsErrorCount = 0;               // 成功一次就重置失败计数
      } catch (err) {
        handsErrorCount++;
        console.warn('[MediaPipe] send 失败：', err);
        /* 连续失败多次说明识别链路已经不可用，降级为演示模式并给出提示 */
        if (handsErrorCount === 5) {
          state.handsReady = false;
          enterDemoMode('手部识别运行异常，已切换到演示模式');
        }
      } finally {
        handsSendBusy = false;
      }
    }

    /* 控制识别频率，剩下的时间让出主线程给渲染 */
    const cost = performance.now() - t0;
    await sleep(Math.max(0, CONFIG.HANDS_INTERVAL_MS - cost));
  }

  handsLoopRunning = false;
}

/* ============================================================================
 * 第 7 节 · 手势 → 绽放度 的映射与缓动
 * ========================================================================== */

/**
 * 根据平滑后的 tension 计算目标绽放度 targetSpread
 *   tension < 0.32            → 0（粒子聚合，花苞闭合）
 *   tension > 0.66            → 1（粒子扩散，花朵完全绽放）
 *   0.32 ≤ tension ≤ 0.66     → 在阈值带内线性过渡，避免“啪”地跳变
 */
function tensionToTargetSpread(tension) {
  return clamp(
    (tension - CONFIG.BUD_THRESHOLD) / (CONFIG.BLOOM_THRESHOLD - CONFIG.BUD_THRESHOLD),
    0,
    1
  );
}

/**
 * 更新所有手势相关状态（每帧调用）
 * @param {number} dt 距上一帧的秒数
 * @param {number} now 当前时间戳（毫秒）
 */
function updateGestureState(dt, now) {
  const handAlive = state.landmarkCount > 0 && (now - state.lastHandSeenAt) < CONFIG.HAND_LOST_TIMEOUT;
  /* forcedTension：鼠标左键按住时的强制张力（仅在没有手势控制时生效） */
  const forced = state.forcedTension;

  if (state.demoMode) {
    /* 【排错修复】演示模式下手部状态一律视为“离场”，
       这样从演示模式切回手势控制时，第一帧就会走“重新捕获”分支 */
    state.handPresent = false;

    /* ---------- 演示模式：用一条平滑的正弦曲线自动开合 ---------- */
    const phase = (now / 1000) * ((Math.PI * 2) / CONFIG.DEMO_PERIOD);
    /* 0.05 ~ 0.95 之间缓慢往复，避免长时间停在两个极端 */
    const autoRaw = 0.5 - 0.45 * Math.cos(phase);
    state.rawTension = (forced !== null) ? forced : autoRaw;
    pushTensionSample(state.rawTension);

    /* 鼠标最近没有动过时，才让指针自己画一个小圆圈（演示“跟随”效果）；
       鼠标一动就把控制权交给鼠标，避免两者互相打架。 */
    const mouseRecentlyActive = (now - state.mouseActiveAt) < 2500;
    if (!mouseRecentlyActive) {
      const t = now / 1000;
      state.pointerTarget.set(
        Math.cos(t * 0.55) * 1.1,
        Math.sin(t * 0.8) * 0.5,
        Math.sin(t * 0.4) * 0.25
      );
    }
  } else if (!handAlive) {
    /* ---------- 手离开画面：缓慢收回成花苞，并把指针归零 ---------- */
    /* 标记为“离场”，手再出现时 onHandResults 会清空滑动窗口 */
    state.handPresent = false;

    state.rawTension = (forced !== null) ? forced : lerp(state.rawTension, 0, 0.06);
    pushTensionSample(state.rawTension);
    if (forced === null) {
      state.pointerTarget.multiplyScalar(0.94);
    }
  }
  /* 手在画面中时（且非演示模式），rawTension 与 pointerTarget 已在 onHandResults 里更新，
     此时手势优先级最高，鼠标与演示曲线都不参与。 */

  /* ---------- ② 指数平滑（EMA）：s += (raw - s) * α ----------
   * 滑动窗口解决“单帧尖刺”，EMA 解决“整体抖动”，两级串联手感最稳。 */
  state.smoothTension += (state.windowedTension - state.smoothTension) * CONFIG.TENSION_SMOOTH;

  /* ---------- ③ 目标绽放度 ---------- */
  state.targetSpread = tensionToTargetSpread(state.smoothTension);

  /* ---------- ④ 缓动（需求指定公式）----------
   *   currentSpread += (targetSpread - currentSpread) * EASE_FACTOR
   * 每帧追赶剩余差值的 18%，兼顾“跟手”与“柔和”，
   * 花朵开合像呼吸一样自然，又不会拖泥带水。 */
  state.currentSpread += (state.targetSpread - state.currentSpread) * CONFIG.EASE_FACTOR;

  /* ---------- ⑤ 指尖位移平滑（同样使用线性插值） ----------
   * 【本次调整·任务三】这里改用更快的平滑系数 POINTER_SMOOTH_FAST(=0.42)：
   * 原来 0.16 在“大幅度跟随”下会出现明显拖尾（手停了花朵还在追），
   * 提到 0.42 后基本跟手。原 POINTER_SMOOTH 参数保持不变，想回退改这里即可。 */
  state.pointerCurrent.lerp(state.pointerTarget, CONFIG.POINTER_SMOOTH_FAST);

  /* ---------- ⑥【新增】比耶防误触计时 + 文字特效状态机 ---------- */
  updateSpellState(dt, now);

  /* ---------- ⑦【重构一】所有渐变量统一由 updateGlobalTransitions 推进 ----------
   * 注意：这里只更新“目标状态”，真正的 lerp 放在主循环里按 dt 归一化推进，
   * 保证 60Hz 与 144Hz 的过渡时长一致。 */
  state.bridgeTarget = (state.landmarkCount > 1 &&
    (now - state.secondHandSeenAt) < CONFIG.HAND_LOST_TIMEOUT &&
    !state.demoMode) ? 1 : 0;
}

/**
 * 【修复六】比耶手势 → 文字特效的状态机（带时间锁防抖）
 * ----------------------------------------------------------------------------
 * 完整状态迁移：
 *
 *   未触发 ──「连续 5 帧 或 累计 0.15 秒」──▶ 已触发（开启 2 秒时间锁）
 *   已触发 ──时间锁到期 且 手势持续消失 0.35 秒──▶ 退出，粒子重新聚拢成花朵
 *   已触发 ──时间锁内：无论手势怎么变形/丢失，都不退出──▶ 保持显示
 *
 * 三个阈值各自解决一个具体问题：
 *   · PEACE_MIN_FRAMES / PEACE_HOLD_SEC → 防止某一帧手型偶然对上了就闪一下文字
 *   · SPELL_LOCK_SEC (2s)               → 触发后对手部抖动免疫，这是“不闪烁”的关键
 *   · SPELL_RELEASE_SEC (0.35s)         → 锁定到期后也要确认手势真的没了才退出，
 *                                          否则临界点上会在“显示/消失”之间高频抖动
 *
 * 退出判定用 `max(时间锁, 释放迟滞)` 双重条件，两者都满足才真正结束。
 */
function updateSpellState(dt, now) {
  if (state.peaceActive) {
    /* 命中比耶：累计帧数与持续时间 */
    state.peaceFrames += 1;
    state.peaceHeldFor += dt;
    state.peaceReleasedFor = 0;   // 手势回来了，清空“消失计时”

    /* 触发条件：连续帧数够 或 持续时间够（满足其一即可，两者是“或”关系） */
    const ready = state.peaceFrames >= CONFIG.PEACE_MIN_FRAMES ||
                  state.peaceHeldFor >= CONFIG.PEACE_HOLD_SEC;

    if (!state.spellActive && ready) {
      state.spellActive = true;
      /* 开启时间锁：从现在起 2 秒内绝对不退出 */
      state.spellLockUntil = now + CONFIG.SPELL_LOCK_SEC * 1000;
      console.info('[比耶特效] 触发：粒子扩散并拼出「' + CONFIG.SPELL_TEXT + '」');
    }
  } else {
    /* 未命中比耶：清零帧数与持续时间（下次要重新累积，这正是防抖的核心） */
    state.peaceFrames = 0;
    state.peaceHeldFor = 0;

    if (state.spellActive) {
      state.peaceReleasedFor += dt;

      const lockOver = now >= state.spellLockUntil;
      const releasedEnough = state.peaceReleasedFor >= CONFIG.SPELL_RELEASE_SEC;

      if (lockOver && releasedEnough) {
        state.spellActive = false;
        console.info('[比耶特效] 结束：粒子重新聚拢成花朵');
      }
    }
  }

  /* 【重构一】这里只设“目标值 0/1”，不做任何插值、更不硬切。
   * 真正的平滑由 updateGlobalTransitions() 按 dt 归一化推进，
   * 保证文字与花朵之间是渐变交叉，绝不会一帧之内变黑或闪现。 */
  state.spellTarget = state.spellActive ? 1 : 0;
}

/* ============================================================================
 * 第 7.5 节 · 【新增】两个特效的逐帧更新
 * ========================================================================== */

/**
 * 【重构三】逐帧重建银河光桥的粒子位置（端点严格绑定双手）
 * ----------------------------------------------------------------------------
 * 相比上一版的关键变化：**取消了整体放大**。
 *   上一版为了“看得见”而以两手中点为中心把整条桥放大 2.4 倍，
 *   结果桥头离开手掌飞出去 —— 这正是用户反馈的“歪斜 / 与手脱节”。
 *   现在端点就是左右手食指指尖 Keypoint 8 的世界坐标，桥的跨度天然等于双手距离。
 *
 * 端点来源（严格绑定，手掌到哪桥头到哪）：
 *   A = 左手食指指尖 Keypoint 8 → NDC → 世界坐标
 *   B = 右手食指指尖 Keypoint 8 → NDC → 世界坐标
 *   左右由屏幕 NDC 的 x 排序决定（x 小的那只在屏幕左侧 = 左手），
 *   因此即使 MediaPipe 返回顺序变化，桥也不会左右颠倒。
 *
 * 数学形式（二次贝塞尔）：
 *     B(t) = (1-t)²·A + 2(1-t)t·C + t²·B ,  t ∈ [0,1]
 *   其中 C 是控制点：
 *     C.x = 两手中点 x
 *     C.y = 两手中点 y + arch        ← 向上抬起，形成拱形
 *     arch = clamp(两手距离 × BRIDGE_ARCH_RATIO, 0.15, BRIDGE_MAX_ARCH)
 *
 *   B(0) = A、B(1) = B → 端点精确落在两只手掌上；
 *   B(0.5) = 中点 + arch/2 → 拱顶高度约为 arch 的一半。
 *   双手越远 → arch 越大 → 拱桥越宽越拱；双手越近 → 越平缓。
 *   arch 用 lerp 平滑推进，避免手一抖弧度就跳。
 *
 * 端点另设一份平滑副本（bridgeEndA/B），只用于渲染不回写状态：
 * 既抹平 MediaPipe 的单帧抖动，又不会让锚点比真实手明显滞后。
 *
 * 每帧写 2600×3 个 float（约 31KB）并标记 needsUpdate，
 * 这个量级对现代 GPU 无压力，不影响 60FPS。
 */
function updateBridge(time, dt) {
  if (!three.bridge) return;

  const uniforms = three.bridge.uniforms;
  const strength = state.bridgeAlpha;

  /* 【附加修复】端点【绝对等于】左右手食指指尖 Keypoint 8，不做任何平滑插值。
   *
   * 上一版这里用了 `bridgeEndA.lerp(handLeftWorld, k)` 做平滑，
   * 结果桥头永远比手掌慢一拍 —— 手一挥，桥就跟不上、看起来“飘着”。
   * 需求要求桥头“死死绑定”“绝对等于”手掌坐标，因此这里直接拷贝：
   * 每一帧端点 = 当帧的手掌位置，零延迟、零漂移。
   *
   * 抖动问题由上一层解决：handLeftWorld/handRightWorld 是世界坐标，
   * 而 NDC 已在 onHandResults 中由 MediaPipe 稳定输出，
   * 桥端点的轻微抖动在视觉上反而让它“贴在手上”更真实。 */
  state.bridgeEndA.copy(state.handLeftWorld);
  state.bridgeEndB.copy(state.handRightWorld);

  /* ---- ②.5【交互修复二】捏合 → 缩放 / 粗细 ----
   *
   * 捏合度 pinchNorm（onHandResults 中算出，双手取平均，约 0.1 捏紧 ~ 1.3 全张）
   * 归一化到 [0,1]：
   *     pinchT = (pinchNorm - PINCH_MIN) / (PINCH_MAX - PINCH_MIN)
   * 再分别映射到两个独立的视觉量：
   *     形状：scaleGoal     = lerp(PINCH_SCALE_NEAR,     PINCH_SCALE_FAR,     s)   // 0.45~1.90
   *     粗细：thicknessGoal = lerp(PINCH_THICKNESS_THIN, PINCH_THICKNESS_THICK, s) // 0.45~1.90
   * 两者都用 lerp 平滑逼近，消除手部抖动带来的画面闪烁。
   *
   * ★ 作用对象的分工（很重要）★
   *   · 端点（桥头）【始终死死绑在左右手食指指尖】，绝不参与缩放；
   *   · pinchScale 只作用于「弧高 arch」与「径向 spread」；
   *   · pinchThickness 只作用于单颗粒子的 gl_PointSize。
   *   如果直接把端点坐标乘 scale，桥头会飞离指尖 —— 那是之前踩过的坑。
   *
   * ★ 为什么放在“可见性早退”之前 ★
   *   否则桥隐藏期间这两个 lerp 会被冻结，下次桥出现时会从旧值跳过来。
   *
   * 安全保证：pinchT 先 clamp 到 [0,1]，结果再经 isFinite + clamp 兜底，
   * 因此永远为正、有限，不可能出现负数或 Infinity。 */
  const pinchT = clamp(
    (state.pinchNorm - CONFIG.PINCH_MIN) / Math.max(1e-4, CONFIG.PINCH_MAX - CONFIG.PINCH_MIN),
    0, 1
  );

  /* 形状缩放 */
  const scaleGoal = lerp(CONFIG.PINCH_SCALE_NEAR, CONFIG.PINCH_SCALE_FAR, pinchT);
  state.pinchScale = lerp(state.pinchScale, scaleGoal, CONFIG.PINCH_EASE);
  if (!Number.isFinite(state.pinchScale)) state.pinchScale = 1;
  state.pinchScale = clamp(state.pinchScale, CONFIG.PINCH_SCALE_NEAR, CONFIG.PINCH_SCALE_FAR);

  /* 粒子粗细 */
  const thickGoal = lerp(CONFIG.PINCH_THICKNESS_THIN, CONFIG.PINCH_THICKNESS_THICK, pinchT);
  state.pinchThickness = lerp(state.pinchThickness, thickGoal, CONFIG.PINCH_EASE);
  if (!Number.isFinite(state.pinchThickness)) state.pinchThickness = 1;
  state.pinchThickness = clamp(
    state.pinchThickness,
    CONFIG.PINCH_THICKNESS_THIN,
    CONFIG.PINCH_THICKNESS_THICK
  );

  /* 写 uniform 也放在早退之前，保证桥一出现就是正确粗细 */
  uniforms.uThickness.value = state.pinchThickness;

  /* 完全不可见时没必要更新缓冲（省掉每帧的顶点计算） */
  three.bridge.points.visible = strength > 0.004;
  if (!three.bridge.points.visible) return;

  uniforms.uTime.value = time;
  uniforms.uStrength.value = strength;

  const attr = three.bridge.geometry.attributes.position;
  const arr = attr.array;

  /* 【附加修复】两端严格绑定左右手食指指尖 Keypoint 8（世界坐标） */
  const a = state.bridgeEndA;
  const b = state.bridgeEndB;

  /* ---- ① 双手距离（世界单位） ---- */
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const handDist = Math.sqrt(dx * dx + dy * dy);

  /* ---- ② 动态弧高：距离越远弧越高，并夹到上限 ----
   * 目标值算好后用 lerp 逼近 state.bridgeArch，实现“平滑长高/压平” */
  const archGoal = clamp(handDist * CONFIG.BRIDGE_ARCH_RATIO, 0.15, CONFIG.BRIDGE_MAX_ARCH);
  state.bridgeArch = lerp(state.bridgeArch, archGoal, CONFIG.BRIDGE_ARCH_EASE);

  /* ---- ②.5 由捏合缩放推出的形状参数（pinchScale 已在早退前算好） ----
   *   arch   : 弧高，乘上捏合缩放 → 捏紧时桥变矮、张开时变高
   *   spread : 径向发散度，乘上捏合缩放 → 捏紧时收敛、张开时发散
   * 端点 a / b 不参与任何缩放，始终等于左右手食指指尖。 */
  const arch = state.bridgeArch * state.pinchScale;
  const spread = CONFIG.BRIDGE_SPREAD * state.pinchScale;

  /* ---- ③ 控制点：中点上抬 arch（向上拱） ----
   * 二次贝塞尔在 t=0.5 处高度 = 中点 + arch × 0.5，
   * 所以拱顶约在中点上方 arch/2 处，弧线随双手距离自然变大变小。 */
  const ccx = (a.x + b.x) * 0.5;
  const ccy = (a.y + b.y) * 0.5 + arch;

  /* ---- ④【重构三】不再做整体放大 ----
   * 上一版为了“看得见”而以中点为中心把整条桥放大 2.4 倍，
   * 结果桥头离开手掌飞出去，看起来就是“歪斜、和手脱节”。
   * 现在端点就是手掌本身，桥的跨度天然等于双手距离，视觉上必然对齐。 */

  const count = CONFIG.BRIDGE_PARTICLES;
  for (let i = 0; i < count; i++) {
    /* 沿桥的位置参数 t ∈ (0,1) */
    const t = (i + 0.5) / count;
    const mt = 1 - t;

    /* 二次贝塞尔 B(t) = (1-t)²·A + 2(1-t)t·C + t²·B */
    const px = mt * mt * a.x + 2 * mt * t * ccx + t * t * b.x;
    const py = mt * mt * a.y + 2 * mt * t * ccy + t * t * b.y;

    /* 径向厚度：中间最粗、两端收细，像一条拉紧的光带。
       已乘上捏合缩放 spread = BRIDGE_SPREAD × pinchScale
       → 捏紧时桥更细更收敛，张开时更粗更发散 */
    const radial = Math.sin(t * Math.PI) * spread;
    const ang = i * 2.39996323;          // 黄金角 → 均匀铺开，不出现条纹
    const r = radial * Math.sqrt(Math.random());

    const i3 = i * 3;
    arr[i3] = px + Math.cos(ang) * r;
    arr[i3 + 1] = py + Math.sin(ang) * r;
    arr[i3 + 2] = (Math.random() - 0.5) * 0.14;   // 轻微前后厚度
  }

  attr.needsUpdate = true;
}

/**
 * 【重构二】逐帧更新文字粒子
 * ----------------------------------------------------------------------------
 *   1. uReveal ← state.spellAlpha（文字透明度，由全局过渡系统平滑推进）
 *   2. uBurst = sin(π·alpha)：炸开幅度在过渡中段最大，成形后归零
 *   3. 【重构二】文字整体实时跟随手部中心（不再固定在屏幕正中）
 *      —— 用 spellFollowPos 做平滑跟随，避免文字随手掌抖动
 */
function updateSpellEffect(time) {
  if (!three.spell) return;

  const uniforms = three.spell.uniforms;
  const alpha = state.spellAlpha;

  three.spell.points.visible = alpha > 0.004;
  uniforms.uReveal.value = alpha;
  uniforms.uTime.value = time;

  /* 爆炸曲线：中间最大，两端归零 */
  uniforms.uBurst.value = Math.sin(Math.PI * alpha);

  /* 【重构二】跟随手部中心：用独立的平滑变量，避免手掌微抖带动文字抖 */
  state.spellFollowPos.lerp(state.handCenterWorld, CONFIG.SPELL_FOLLOW_EASE);
  three.spell.points.position.copy(state.spellFollowPos);
}

/* ============================================================================
 * 第 7.4 节 · 【重构一】全局平滑过渡系统
 * ============================================================================
 * 这是本次重构的核心：所有特效的“出现/消失”都由这里统一推进，
 * 任何地方都不允许直接把透明度赋成 0 或 1（那正是之前“硬切/闪黑”的根源）。
 *
 * 一、为什么需要帧率归一化
 *   普通写法 o += (target - o) * k 在 60fps 和 144fps 下的实际收敛速度不同。
 *   这里用几何衰减换算：
 *       alpha = 1 - Math.pow(1 - kPerSecond, dt)
 *   其中 kPerSecond = 1 - Math.pow(1 - k60, 60)，k60 是 60fps 下的每帧系数。
 *   这样无论帧率如何，过渡都在相同的“秒数”内完成。
 *
 * 二、各个量的目标值与驱动力
 *   flowerAlpha   : 1 - max(bridgeAlpha, spellAlpha)   ← 特效越强，花朵越让位
 *   flowerScatter : spellAlpha（文字出现时花朵先散开）
 *   bridgeAlpha   : state.bridgeTarget（检测到双手时 1）
 *   spellAlpha    : state.spellTarget（比耶状态机给出）
 *
 * 三、不会溢出
 *   每个量在写回前都经过 clamp(x, 0, 1)，并做了极小值吸附
 *   （< 0.001 归零、> 0.999 归一），保证不会出现 1.0000001 或负值。
 * ========================================================================== */

/**
 * 把「60fps 下的每帧系数」换算成「本帧应使用的插值系数」
 * @param {number} k60 60fps 下每帧的逼近比例
 * @param {number} dt 本帧耗时（秒）
 */
function frameRateLerpAlpha(k60, dt) {
  const k = clamp(k60, 0.0001, 0.9999);
  const perSecond = 1 - Math.pow(1 - k, 60);   // 每秒的收敛比例
  return 1 - Math.pow(1 - perSecond, Math.max(0.0001, dt));
}

/**
 * 把「希望用多少秒完成过渡」换算成「60fps 下的每帧系数」
 * 用于让 FADE_*_SEC 这类“秒数”参数直接可用。
 * @param {number} seconds 期望的过渡时长（秒）
 */
function secondsToK60(seconds) {
  const s = Math.max(0.05, seconds);
  /* 3 个时间常数后约完成 95%，视觉上已“到位” */
  return 1 - Math.pow(0.05, 1 / (s * 60));
}

/** 吸附极小/极大值，避免浮点残留导致 three 一直绘制不可见对象 */
function snapEdge(v) {
  if (v < 0.001) return 0;
  if (v > 0.999) return 1;
  return clamp(v, 0, 1);
}

/* ============================================================================
 * 【新增】单指粉白拖尾绘画 · 对象池运行时逻辑
 * ----------------------------------------------------------------------------
 * 设计原则（需求硬性要求）：
 *   · 绝不在 requestAnimationFrame 里 new THREE.Points / new BufferGeometry
 *   · 全部缓冲在 initPaintEffect() 中一次性预分配（1000 个粒子槽位）
 *   · 运行时只做 TypedArray 的原地写入，零 GC 压力，保证 60FPS
 * ========================================================================== */

/**
 * 发射新粒子 + 更新所有粒子的生命周期（每帧调用）
 * @param {number} dt 本帧耗时（秒）
 */
function updatePaintEffect(dt) {
  const pool = three.paint;
  if (!pool) return;

  const lifetime = CONFIG.PAINT_LIFETIME_SEC;
  const count = pool.count;

  const posAttr = pool.geometry.attributes.position;
  const colAttr = pool.geometry.attributes.aColor;
  const sizeAttr = pool.geometry.attributes.aSize;
  const alphaAttr = pool.geometry.attributes.aAlpha;

  const posArr = posAttr.array;
  const colArr = colAttr.array;
  const sizeArr = sizeAttr.array;
  const alphaArr = alphaAttr.array;

  /* ---------- ① 发射（仅手势激活时） ----------
   * 用「每秒发射数 × dt」累加，保证 30fps 与 144fps 下线密度一致。 */
  if (state.drawActive) {
    state.drawEmitAccum += CONFIG.PAINT_EMIT_PER_SEC * dt;

    /* 画笔位置平滑：直接用原始指尖会让线条毛躁，追一下更顺滑 */
    state.drawPointerSmoothed.lerp(state.drawPointerWorld, 0.55);

    /* 重新开始画时把“上一点”对齐到当前位置，避免拉出一条长直线 */
    if (!state.drawHasLastSpawn) {
      state.drawLastSpawn.copy(state.drawPointerSmoothed);
      state.drawHasLastSpawn = true;
    }

    /* 【修复四】一次性算出本帧要发几颗，然后在「上一个生成点 → 当前笔尖」
     * 这一段上做【均匀分布】，而不是每颗都用随机 t。
     *
     * 为什么必须均匀分布：
     *   手指移动快时，一帧内笔尖会跨过很长一段距离。若 3 颗粒子都用
     *   Math.random() 取 t，它们可能挤在段首附近，段尾就出现空隙 ——
     *   这就是"轨迹断裂成一堆散点"的直接原因。
     *   改成 t = (k + random) / n 后，粒子沿段等距铺开，再加一点随机
     *   抖动消除机械感，轨迹就变成连续的光带。
     *
     * 每帧最多 8 颗：长时间卡顿后不会瞬间灌满整个池。
     * 剩余累加值做上限保护，避免卡顿后累积过多导致后续几帧狂喷。 */
    let emitCount = Math.min(8, Math.floor(state.drawEmitAccum));
    state.drawEmitAccum -= emitCount;
    state.drawEmitAccum = Math.min(state.drawEmitAccum, 8);

    for (let k = 0; k < emitCount; k++) {
      /* 环形找空槽：最多绕一圈；全满则覆盖最老的槽位 */
      let slot = -1;
      for (let s = 0; s < count; s++) {
        const idx = (pool.emitCursor + s) % count;
        if (!pool.alive[idx] || pool.ages[idx] >= lifetime) {
          slot = idx;
          pool.emitCursor = (idx + 1) % count;
          break;
        }
      }
      if (slot < 0) {
        slot = pool.emitCursor;
        pool.emitCursor = (pool.emitCursor + 1) % count;
      }

      /* 【修复四】段内均匀分布 + 轻微随机抖动 */
      const t = emitCount > 1
        ? (k + Math.random()) / emitCount
        : Math.random();

      const bx = lerp(state.drawLastSpawn.x, state.drawPointerSmoothed.x, t);
      const by = lerp(state.drawLastSpawn.y, state.drawPointerSmoothed.y, t);
      const bz = state.drawPointerSmoothed.z;

      const J = CONFIG.PAINT_SPREAD;
      const i3 = slot * 3;
      posArr[i3] = bx + (Math.random() - 0.5) * J;
      posArr[i3 + 1] = by + (Math.random() - 0.5) * J;
      posArr[i3 + 2] = bz + (Math.random() - 0.5) * J;

      /* ---- 粉白随机混合 ----
       * 在生成瞬间定色（而不是每帧随机），否则会疯狂闪烁。
       * 复用 PALETTE 里已有的粉色与米白，保证与花朵色系一致。 */
      const usePink = Math.random() < 0.5;
      const base = usePink ? PALETTE.petalMid : PALETTE.petalTip;
      const whiteMix = Math.random() * 0.35;
      colArr[i3] = lerp(base.r, PALETTE.coreTip.r, whiteMix);
      colArr[i3 + 1] = lerp(base.g, PALETTE.coreTip.g, whiteMix);
      colArr[i3 + 2] = lerp(base.b, PALETTE.coreTip.b, whiteMix);

      sizeArr[slot] = lerp(CONFIG.PAINT_SIZE_MIN, CONFIG.PAINT_SIZE_MAX, Math.random());
      alphaArr[slot] = 1.0;
      pool.ages[slot] = 0;
      pool.alive[slot] = 1;
    }

    state.drawLastSpawn.copy(state.drawPointerSmoothed);
  } else {
    /* 手势解除：停止发射，但【已有粒子继续走完 5 秒生命周期】（需求要求） */
    state.drawEmitAccum = 0;
    state.drawHasLastSpawn = false;
  }

  /* ---------- ② 更新年龄与透明度 ---------- */
  let live = 0;
  for (let i = 0; i < count; i++) {
    if (!pool.alive[i]) {
      alphaArr[i] = 0;
      continue;
    }

    const age = pool.ages[i] + dt;
    pool.ages[i] = age;

    /* 超过寿命 → alpha 归零 + 坐标移出屏幕 + 标记可复用（不销毁任何对象） */
    if (age >= lifetime) {
      alphaArr[i] = 0;
      posArr[i * 3 + 1] = 99999;      // 移到屏幕外，彻底不可见且不参与光栅化
      pool.alive[i] = 0;
      continue;
    }

    live++;

    /* 生命周期曲线：前 35% 满亮度（“停留”），后 65% smoothstep 淡出。
     * 视觉上是“写上去 → 停一会儿 → 慢慢消散”，符合 5 秒停留的要求。 */
    const lifeT = age / lifetime;
    const HOLD = 0.35;
    let a;
    if (lifeT < HOLD) {
      a = 1;
    } else {
      a = 1 - smoothstep(0, 1, (lifeT - HOLD) / (1 - HOLD));
    }

    /* 出生 0.15 秒内快速淡入，避免“啪”地出现 */
    const born = Math.min(1, age / 0.15);
    alphaArr[i] = clamp(a * born, 0, 1);
  }

  pool.liveCount = live;

  /* ---------- ③ 标记缓冲更新 ---------- */
  alphaAttr.needsUpdate = true;
  if (live > 0 || state.drawActive) {
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
  }

  /* 没有活粒子时整个对象隐藏，彻底省掉一次 draw call */
  pool.points.visible = live > 0;
}

/**
 * 推进绘画模式的目标值（供花朵让位使用）
 * 与 bridgeAlpha / spellAlpha 并列参与 updateGlobalTransitions 里的 max() 互斥。
 */
function updatePaintState(dt) {
  state.drawTarget = state.drawActive ? 1 : 0;

  const k = secondsToK60(CONFIG.PAINT_FADE_SEC);
  state.drawAlpha = snapEdge(lerp(state.drawAlpha, state.drawTarget,
    frameRateLerpAlpha(k, dt)));
}

/**
 * 推进所有全局过渡变量（每帧调用一次，在渲染之前）
 * @param {number} dt 本帧耗时（秒）
 */
function updateGlobalTransitions(dt) {
  /* ---- ① 目标透明度 ---- */
  const bridgeTarget = clamp(state.bridgeTarget || 0, 0, 1);
  const spellTarget = clamp(state.spellTarget || 0, 0, 1);

  /* ---- ② 拱桥 / 文字：各自按“过渡秒数”平滑逼近 ---- */
  const kBridge = secondsToK60(CONFIG.BRIDGE_FADE_SEC);
  const kSpell = secondsToK60(CONFIG.TEXT_FADE_SEC);
  state.bridgeAlpha = snapEdge(lerp(state.bridgeAlpha, bridgeTarget,
    frameRateLerpAlpha(kBridge, dt)));
  state.spellAlpha = snapEdge(lerp(state.spellAlpha, spellTarget,
    frameRateLerpAlpha(kSpell, dt)));

  /* ---- ③ 花朵让位：取特效中更强的那个作为“退让程度” ----
   * 用 max 而不是相加：相加会超过 1（语义混乱），max 表示
   * “只要有任一个特效在场，花朵就按它的强度让位”。
   *
   * 【交互修复三】drawAlpha 乘上 PAINT_HIDE_LEVEL 后参与 max()：
   *   PAINT_HIDE_LEVEL = 1.0 表示“绘画时花朵完全隐去”，绝不遮挡笔迹。
   *   之前这个配置项定义了却没有被使用（死配置），
   *   虽然 drawAlpha=1 时 1-hide 也恰好是 0，但一旦想调“只淡到 30%”
   *   就没有任何旋钮可用。现在它真正生效了。 */
  const drawHide = clamp(state.drawAlpha * CONFIG.PAINT_HIDE_LEVEL, 0, 1);
  const fxHide = Math.max(state.bridgeAlpha, state.spellAlpha);
  const hide = Math.max(fxHide, drawHide);
  const flowerTarget = clamp(1 - hide, 0, 1);

  /* 【修复三】让位速度分流：
   *   · 由"单指绘画"主导时用 PAINT_FADE_SEC(0.15s) —— 必须立刻响应，视野要干净；
   *   · 由拱桥/文字主导时仍用 FADE_OUT_SEC(0.45s) —— 保持原有的柔和过渡。
   * 之前一律用 0.45s，实机上会感觉"按了绘画但花还在那儿挡着"。 */
  const byDrawing = drawHide >= fxHide && drawHide > 0;
  const fadeOutSec = byDrawing ? CONFIG.PAINT_FADE_SEC : CONFIG.FADE_OUT_SEC;

  /* 淡出比淡入快一点：让位要干脆，恢复可以从容 */
  const kFlower = flowerTarget < state.flowerAlpha
    ? secondsToK60(fadeOutSec)
    : secondsToK60(CONFIG.FADE_IN_SEC);
  state.flowerAlpha = snapEdge(lerp(state.flowerAlpha, flowerTarget,
    frameRateLerpAlpha(kFlower, dt)));

  /* 【修复三】第二重保证：透明度之外再做一次平滑缩放收敛。
   * 绘画时花朵缩到 0.4；退出时平滑回到 1。透明度已经是 0 时缩放看不出来，
   * 但淡出那 0.15 秒里"边缩边淡"的观感更自然，也确保绝不遮挡笔迹。
   * 安全：每次都做 isFinite 兜底与 clamp，避免 NaN 传进 shader。 */
  const kScale = secondsToK60(CONFIG.PAINT_FADE_SEC);
  const scaleTarget = 1 - drawHide * 0.6;
  state.flowerScale = lerp(state.flowerScale, scaleTarget, frameRateLerpAlpha(kScale, dt));
  if (!Number.isFinite(state.flowerScale)) state.flowerScale = 1;
  state.flowerScale = clamp(state.flowerScale, 0.4, 1);

  /* ---- ④ 花朵散开：文字出现时先炸开再淡出，形成“散开→重组”的连续感 ---- */
  const kScatter = secondsToK60(CONFIG.SCATTER_SEC);
  state.flowerScatter = snapEdge(lerp(state.flowerScatter, state.spellAlpha,
    frameRateLerpAlpha(kScatter, dt)));

  /* ---- ⑤ 写进 uniform（这里只写，不再做任何线性插值） ---- */
  if (three.uniforms) {
    three.uniforms.uGlobalAlpha.value = state.flowerAlpha;
    three.uniforms.uScatter.value = state.flowerScatter;

    /* 花朵亮度保持恒定（GLOW_INTENSITY），透明度完全交给 uGlobalAlpha。
     * ★ 这样做的意义：以前靠压暗 uIntensity 来“藏”花朵，
     *   那个过程在视觉上像“变黑”；现在 uIntensity 恒定，
     *   只有 alpha 与 size 一起衰减，是真正的淡出。 */
    three.uniforms.uIntensity.value = CONFIG.GLOW_INTENSITY;
  }

  /* ==========================================================================
   * 【致命问题一】强制互斥：绘画时硬切花朵可见性
   * --------------------------------------------------------------------------
   * 不再依赖 lerp 淡出 —— 低帧率下 lerp 需要好几帧才收干净，
   * 期间花朵就是"半边透"的穿帮画面。这里直接 visible = false，一帧到位。
   * 退出绘画时立刻恢复 visible，并把被强制清零的 alpha 拉回 1。
   * ========================================================================== */
  if (three.points) {
    if (state.drawActive) {
      /* 绘画中：硬切隐藏 */
      state.flowerAlpha = 0;
      state.flowerScatter = 0;
      state.flowerForceHidden = true;
      three.points.visible = false;
      three.uniforms.uGlobalAlpha.value = 0;
    } else {
      /* 非绘画：立即恢复（若刚从强制隐藏态退出，alpha 直接回满，不做慢 lerp） */
      if (state.flowerForceHidden) {
        state.flowerForceHidden = false;
        state.flowerAlpha = 1;
        three.uniforms.uGlobalAlpha.value = 1;
      }
      three.points.scale.setScalar(state.flowerScale);
      three.points.visible = state.flowerAlpha > 0.002;
    }
  }
}

/* ============================================================================
 * 第 8 节 · 手部骨架绘制（2D Canvas 叠加层）
 * ========================================================================== */

/**
 * 视频以 object-fit: cover 显示，这里做同样的坐标映射，
 * 保证骨架与视频画面严格对齐。
 */
function coverMap(nx, ny) {
  const vw = dom.video.videoWidth || 1280;
  const vh = dom.video.videoHeight || 720;
  const cw = window.innerWidth;
  const ch = window.innerHeight;

  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const ox = (cw - dw) * 0.5;
  const oy = (ch - dh) * 0.5;

  /* 视频层做了 scaleX(-1) 镜像，因此这里也要翻转 X */
  const x = cw - (ox + nx * dw);
  const y = oy + ny * dh;
  return { x, y };
}

/** 绘制所有检测到的手的骨架 */
function drawSkeleton() {
  const W = window.innerWidth;
  const H = window.innerHeight;

  skCtx.clearRect(0, 0, W, H);

  if (!state.showSkeleton || state.demoMode) return;
  const list = state.handLandmarksList;
  if (!list || list.length === 0) return;

  const now = performance.now();
  const alive = (now - state.lastHandSeenAt) < CONFIG.HAND_LOST_TIMEOUT;
  if (!alive) return;

  /* 主控手（第 0 只）高亮，其余手用低饱和度颜色 */
  for (let h = 0; h < list.length; h++) {
    const landmarks = list[h];
    if (!landmarks || landmarks.length < 21) continue;

    const primary = h === 0;
    const pts = landmarks.map((lm) => coverMap(lm.x, lm.y));

    /* ---- ① 连线：先画一层粗的虚化光晕，再画细的实线 ---- */
    skCtx.lineCap = 'round';
    skCtx.lineJoin = 'round';

    /* 光晕层 */
    skCtx.strokeStyle = primary ? 'rgba(255, 63, 142, 0.35)' : 'rgba(139, 92, 255, 0.22)';
    skCtx.lineWidth = 6;
    skCtx.shadowColor = primary ? 'rgba(255, 63, 142, 0.9)' : 'rgba(139, 92, 255, 0.7)';
    skCtx.shadowBlur = 14;
    skCtx.beginPath();
    for (let i = 0; i < HAND_CONNECTIONS.length; i++) {
      const a = pts[HAND_CONNECTIONS[i][0]];
      const b = pts[HAND_CONNECTIONS[i][1]];
      skCtx.moveTo(a.x, a.y);
      skCtx.lineTo(b.x, b.y);
    }
    skCtx.stroke();

    /* 实线层 */
    skCtx.shadowBlur = 0;
    skCtx.strokeStyle = primary ? 'rgba(255, 190, 225, 0.95)' : 'rgba(190, 170, 255, 0.7)';
    skCtx.lineWidth = 2;
    skCtx.beginPath();
    for (let i = 0; i < HAND_CONNECTIONS.length; i++) {
      const a = pts[HAND_CONNECTIONS[i][0]];
      const b = pts[HAND_CONNECTIONS[i][1]];
      skCtx.moveTo(a.x, a.y);
      skCtx.lineTo(b.x, b.y);
    }
    skCtx.stroke();

    /* ---- ② 关键点：普通点为小圆，关键点（腕/掌指/指尖）加大并加光晕 ---- */
    for (let i = 0; i < pts.length; i++) {
      const key = HAND_HIGHLIGHT.has(i);
      const r = key ? 4.6 : 3.0;
      skCtx.beginPath();
      skCtx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2);
      skCtx.fillStyle = key
        ? (i === HAND.INDEX_TIP ? 'rgba(255, 232, 150, 1)' : 'rgba(255, 255, 255, 0.96)')
        : (primary ? 'rgba(255, 143, 192, 0.9)' : 'rgba(170, 150, 255, 0.8)');
      if (key) {
        skCtx.shadowColor = i === HAND.INDEX_TIP ? 'rgba(255, 200, 77, 0.95)' : 'rgba(255, 63, 142, 0.9)';
        skCtx.shadowBlur = 12;
      } else {
        skCtx.shadowBlur = 0;
      }
      skCtx.fill();
    }
    skCtx.shadowBlur = 0;

    /* ---- ③ 食指指尖的十字准星：让“指尖控制花朵”这件事一目了然 ---- */
    if (primary) {
      const tip = pts[HAND.INDEX_TIP];
      skCtx.strokeStyle = 'rgba(255, 200, 77, 0.9)';
      skCtx.lineWidth = 1.5;
      skCtx.beginPath();
      skCtx.moveTo(tip.x - 14, tip.y);
      skCtx.lineTo(tip.x - 5, tip.y);
      skCtx.moveTo(tip.x + 5, tip.y);
      skCtx.lineTo(tip.x + 14, tip.y);
      skCtx.moveTo(tip.x, tip.y - 14);
      skCtx.lineTo(tip.x, tip.y - 5);
      skCtx.moveTo(tip.x, tip.y + 5);
      skCtx.lineTo(tip.x, tip.y + 14);
      skCtx.stroke();

      /* 从指尖到花朵中心的方向提示线（虚线，朝向屏幕中心） */
      const cx = window.innerWidth * 0.5;
      const cy = window.innerHeight * 0.5;
      skCtx.setLineDash([4, 6]);
      skCtx.strokeStyle = 'rgba(255, 200, 77, 0.30)';
      skCtx.lineWidth = 1;
      skCtx.beginPath();
      skCtx.moveTo(tip.x, tip.y);
      skCtx.lineTo(cx, cy);
      skCtx.stroke();
      skCtx.setLineDash([]);
    }
  }
}

/** 清空骨架画布（隐藏骨架或停止运行时调用） */
function clearSkeleton() {
  skCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

/* ============================================================================
 * 第 9 节 · HUD 更新
 * ========================================================================== */

/** 设置一行 HUD 文本与状态色 */
function setHud(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'warn', 'bad');
  if (kind) el.classList.add(kind);
}

let lastHudUpdate = 0;

function updateHud(now) {
  /* HUD 无需每帧刷新，约 15Hz 足够，减少 DOM 操作 */
  if (now - lastHudUpdate < 66) return;
  lastHudUpdate = now;

  /* 左上角状态 */
  if (!state.cameraReady) {
    setHud(dom.hudCamera, state.demoMode ? '未使用（演示模式）' : '未启动', state.demoMode ? 'warn' : 'bad');
  }

  const handAlive = state.landmarkCount > 0 && (now - state.lastHandSeenAt) < CONFIG.HAND_LOST_TIMEOUT;
  if (state.demoMode) {
    setHud(dom.hudHand, '演示模式（自动开合）', 'warn');
    setHud(dom.hudMode, '演示模式', 'warn');
  } else if (handAlive) {
    /* 【任务一】把“几只手指＋做了什么手势”直接显示出来，方便你验证新功能 */
    let handText = (state.landmarkCount > 1 ? state.landmarkCount + ' 只手 · ' : '') + '已锁定 21 点';
    if (state.spellActive) handText += ' · ✌ 文字特效';
    else if (state.peaceActive) handText += ' · ✌ 识别中';
    setHud(dom.hudHand, handText, 'ok');

    let modeText = '摄像头手势';
    if (state.landmarkCount > 1) modeText = '双手 · 银河光桥';
    else if (state.spellActive) modeText = '比耶 · 天天开心❤';
    setHud(dom.hudMode, modeText, 'ok');
  } else {
    setHud(dom.hudHand, '未检测到手，请把手放进画面', 'bad');
    setHud(dom.hudMode, '摄像头手势', null);
  }

  setHud(dom.hudFps, state.fps.toFixed(0) + ' FPS', state.fps < 30 ? 'warn' : 'ok');

  /* 【UI 极简】左下角面板已整体删除，原来的 tension / spread / pointer 数值
     与进度条都不再存在，因此这里不再写任何数值。
     唯一的状态显示由底部 setStatus()（见 updateStatusBar）统一负责。
     ★ 注意：绝不能在这里访问 dom.tensionValue 等已移除的元素，
       否则 .textContent 会抛 TypeError 并中断整个 animate 循环（画面卡死）。 */

  /* 底部提示条：根据状态给出操作引导 */
  const hintBar = dom.hintBar;
  if (state.demoMode) {
    dom.hintText.textContent = '演示模式运行中：花朵会自动开合　|　按 空格 或点击按钮可切回摄像头手势';
    hintBar.classList.add('highlight');
  } else if (!handAlive) {
    dom.hintText.textContent = '请把手抬到摄像头前　|　握拳 = 花苞　张开五指 = 绽放　比耶 ✌ = 天天开心';
    hintBar.classList.add('highlight');
  } else if (state.spellActive) {
    dom.hintText.textContent = '✌ 比耶生效中：粒子正在拼出「' + CONFIG.SPELL_TEXT + '」　→　收起比耶即可回到花朵';
    hintBar.classList.add('highlight');
  } else if (state.peaceActive) {
    dom.hintText.textContent = '检测到比耶手势，保持 0.5 秒即触发文字特效…';
    hintBar.classList.add('highlight');
  } else if (state.landmarkCount > 1) {
    dom.hintText.textContent = '双手已就位：两人手掌之间已亮起银河光桥　|　合拢双手可以让光桥变短';
    hintBar.classList.remove('highlight');
  } else if (state.smoothTension < CONFIG.BUD_THRESHOLD) {
    dom.hintText.textContent = '花苞状态（tension ' + state.smoothTension.toFixed(2) +
      ' < ' + CONFIG.BUD_THRESHOLD.toFixed(2) + '）　→　慢慢张开五指试试';
    hintBar.classList.remove('highlight');
  } else if (state.smoothTension > CONFIG.BLOOM_THRESHOLD) {
    dom.hintText.textContent = '盛开状态（tension ' + state.smoothTension.toFixed(2) +
      ' > ' + CONFIG.BLOOM_THRESHOLD.toFixed(2) + '）　→　握拳让花朵重新收拢';
    hintBar.classList.remove('highlight');
  } else {
    dom.hintText.textContent = '过渡中（' + CONFIG.BUD_THRESHOLD.toFixed(2) + ' ≤ tension ≤ ' +
      CONFIG.BLOOM_THRESHOLD.toFixed(2) + '）　→　花朵正在绽放 / 收拢';
    hintBar.classList.remove('highlight');
  }
}

/* ============================================================================
 * 第 9.5 节 · 【重构四】新增 UI 渲染模块
 * ----------------------------------------------------------------------------
 *   ① 星尘背景（2D Canvas，独立于 Three.js，开销极低）
 *   ② 右上角摄像头预览窗（把 <video> 的帧缩放画到小画布上）
 *   ③ 底部手部状态提示条（纯 DOM 文本 + class 切换颜色）
 * ========================================================================== */

/* ---------- ① 星尘背景 ---------- */const stardust = {
  stars: [],
  w: 0,
  h: 0,
  dpr: 1
};

/**
 * 初始化星尘：随机撒一批大小/亮度/闪烁相位各异的星点。
 * 数量按屏幕面积自适应（每 12000 像素一颗），并夹在 [40, 190] 之间，
 * 保证大屏不稀疏、小屏不过载。
 */
function initStardust() {
  if (!stardustCtx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;

  dom.stardustCanvas.width = Math.floor(w * dpr);
  dom.stardustCanvas.height = Math.floor(h * dpr);
  dom.stardustCanvas.style.width = w + 'px';
  dom.stardustCanvas.style.height = h + 'px';
  stardustCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  stardust.w = w;
  stardust.h = h;
  stardust.dpr = dpr;

  const count = Math.round(clamp((w * h) / 12000, 40, 190));
  stardust.stars = [];
  for (let i = 0; i < count; i++) {
    stardust.stars.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.5 + Math.random() * 1.4,           // 半径 0.5~1.9px
      a: 0.216 + Math.random() * 0.6,         // 基础亮度（整体仍很暗，只做氛围）
      phase: Math.random() * Math.PI * 2,     // 闪烁相位
      speed: 0.35 + Math.random() * 0.9,      // 闪烁速度
      drift: 0.06 + Math.random() * 0.16      // 缓慢向上漂移速度
    });
  }
}

/**
 * 绘制星尘（每帧调用）
 * @param {number} time 运行时间（秒）
 */
function drawStardust(time) {
  if (!stardustCtx) return;

  const ctx = stardustCtx;
  const w = stardust.w;
  const h = stardust.h;

  ctx.clearRect(0, 0, w, h);

  const stars = stardust.stars;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];

    /* 缓慢向上漂移，越界后从底部重新出现（形成持续的星际流动） */
    s.y -= s.drift;
    if (s.y < -2) {
      s.y = h + 2;
      s.x = Math.random() * w;
    }

    /* 亮度呼吸：sin 相位 + 基础亮度，范围约 0.1~0.75 */
    const twinkle = 0.55 + 0.45 * Math.sin(time * s.speed + s.phase);
    const alpha = s.a * twinkle;

    /* 【性能急救】这里原先每帧、每颗星都 ctx.createRadialGradient(...)，
     * 190 颗星 × 每帧 → 每秒上万个渐变对象，GC 直接把帧率拖到 9FPS。
     * 改为纯色实心圆：零对象分配、零渐变计算。 */
    ctx.fillStyle = 'rgba(255,245,255,' + alpha.toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ---------- ② 右上角摄像头画中画（P 键 / 按钮切换） ---------- */
let previewLastDraw = 0;
let previewReadyState = null;

/**
 * 每帧把摄像头当前画面缩放绘制到右上角小画布。
 * ----------------------------------------------------------------------------
 * 性能控制：
 *   · 限制到约 24FPS（41ms）——画中画只需“看得出在动”，无需 60FPS
 *   · 面板隐藏时【直接跳过绘制】，省掉一次 320×240 的 drawImage 拷贝
 *   · 状态（offline）只在变化时改 DOM，避免每帧写 class
 */
function updateCameraPreview(now) {
  if (!dom.camPreviewCanvas || !previewCtx || !dom.camPreview) return;

  /* 面板隐藏时不绘制（用户看不见，纯浪费） */
  if (!state.showPreview) {
    /* 但仍要保证下一次显示时立刻有画面，故不清空画布 */
    return;
  }

  const ready = state.cameraReady &&
    dom.video.readyState >= 2 &&
    dom.video.videoWidth > 0;

  /* offline 状态只在变化时更新 */
  if (ready !== previewReadyState) {
    previewReadyState = ready;
    dom.camPreview.classList.toggle('offline', !ready);
  }

  if (!ready) return;

  if (now - previewLastDraw < 41) return;   // ≈24FPS
  previewLastDraw = now;

  const cw = dom.camPreviewCanvas.width;
  const ch = dom.camPreviewCanvas.height;
  const vw = dom.video.videoWidth;
  const vh = dom.video.videoHeight;

  /* 按 cover 方式裁剪填满，与全屏背景的 object-fit: cover 视觉一致 */
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = (cw - dw) * 0.5;
  const dy = (ch - dh) * 0.5;

  try {
    previewCtx.drawImage(dom.video, dx, dy, dw, dh);
  } catch (err) {
    /* video 尚未完成解码时可能抛错，忽略即可（下一帧再试） */
  }
}

/**
 * 切换右上角画中画的显示/隐藏
 * 只操作 CSS class，过渡动画由样式表里的 opacity + transform 完成。
 */
function setPreviewVisible(visible) {
  state.showPreview = !!visible;
  if (dom.camPreview) {
    dom.camPreview.classList.toggle('hidden', !state.showPreview);
  }
  if (dom.btnPreview) {
    dom.btnPreview.setAttribute('aria-pressed', String(state.showPreview));
  }
}

/* ---------- ③ 底部手部状态提示条 ---------- */

/**
 * 更新底部状态条
 * @param {string} text 显示文字
 * @param {''|'single'|'double'|'spell'|'error'} kind 状态类别（决定圆点颜色与描边）
 */
let lastStatusText = '';
let lastStatusKind = '';
function setStatus(text, kind) {
  if (!dom.statusBar || !dom.statusText) return;

  /* 文本与类别都没变就不碰 DOM（这个函数每帧都会被调用，必须便宜） */
  if (text === lastStatusText && kind === lastStatusKind) return;
  lastStatusText = text;
  lastStatusKind = kind;

  dom.statusText.textContent = text;
  dom.statusBar.classList.remove('single', 'double', 'spell', 'error');
  if (kind) dom.statusBar.classList.add(kind);
}

/** 根据当前状态推导出底部提示文字 */
function updateStatusBar() {
  if (!dom.statusBar) return;

  if (state.demoMode) {
    setStatus('状态：演示模式已激活', '');
    return;
  }

  if (!state.cameraReady) {
    setStatus('状态：摄像头未就绪', 'error');
    return;
  }

  const handAlive = state.landmarkCount > 0 &&
    (performance.now() - state.lastHandSeenAt) < CONFIG.HAND_LOST_TIMEOUT;

  if (state.spellActive) {
    setStatus('状态：比耶文字已激活', 'spell');
  } else if (!handAlive) {
    setStatus('状态：等待手势输入', 'error');
  } else if (state.landmarkCount > 1) {
    setStatus('状态：双手交互已激活', 'double');
  } else {
    setStatus('状态：单手追踪中', 'single');
  }
}

/* ============================================================================
 * 第 10 节 · 主渲染循环
 * ========================================================================== */
function animate() {
  /* WebGL 不可用或上下文已丢失时不再自我续帧，避免无意义的空转报错。
     （bootstrap 已经弹出了错误面板，F5 刷新即可恢复。） */
  if (!three.renderer || !three.renderer.getContext()) {
    state.running = false;
    return;
  }

  requestAnimationFrame(animate);

  const now = performance.now();

  /* 【排错修复】页面切到后台时不渲染。
   * 定时器/网络回调恢复后 rAF 仍会继续触发，但标签页不可见时渲染毫无意义；
   * 这里直接让时钟空转一帧（不推进旋转与手势状态），
   * 既省 GPU/电量，也避免长时间后台后 elapsedTime 累积出一大跳。 */
  if (state.pageHidden) {
    three.clock.getDelta();   // 丢弃这段时间的增量，防止回到前台时 dt 突变
    return;
  }

  const dt = Math.min(0.05, three.clock.getDelta());   // 夹紧 dt，防止切标签页回来时跳变
  const elapsed = three.clock.elapsedTime;

  /* ---- ① 更新手势状态（tension、目标绽放度、缓动、指针平滑） ---- */
  updateGestureState(dt, now);

  /* ---- ①.5 【修复二】花朵自转已彻底移除 ----
   * 用户明确要求“绝对禁止自转”，所以这里不是把速度设为 0，而是整段删掉：
   * 留一个 speed=0 的乘法还留着 rotation.y 这条通路，以后调参很容易又转起来，
   * 而且白算一次浮点。花朵现在完全静止，只有手势驱动的位移与开合。 */

  /* ---- ② 只更新 uniform（JS 侧零粒子循环，全部计算在 GPU） ---- */
  three.uniforms.uSpread.value = state.currentSpread;
  three.uniforms.uTime.value = elapsed;
  three.uniforms.uPointer.value.copy(state.pointerCurrent);

  /* ---- ②.5【重构一】推进全局平滑过渡 ----
   * 所有透明度/散开程度都在这里用 dt 归一化的 lerp 推进，
   * 保证任何切换都是渐变的，绝不会出现硬切或“变黑”。
   * 必须在 updateBridge / updateSpellEffect 之前调用，
   * 因为后两者读取的是这里算出的 bridgeAlpha / spellAlpha。
   * 【新增】updatePaintState 也要在这里先算，drawAlpha 参与花朵让位判断。 */
  updatePaintState(dt);
  updateGlobalTransitions(dt);

  /* ---- ②.6 三个特效的逐帧渲染 ----
   *  · 双手银河光桥：端点绑定左右手食指指尖 Keypoint 8
   *  · 比耶文字：跟随手部中心，随时间散开重组
   *  · 单指粉白拖尾：对象池发射 + 生命周期淡出（独立 BufferGeometry） */
  updateBridge(elapsed, dt);
  updateSpellEffect(elapsed);
  updatePaintEffect(dt);

  /* ---- ③ 渲染 ---- */
  three.renderer.render(three.scene, three.camera);

  /* ---- ④ 骨架叠加层 ---- */
  drawSkeleton();

  /* ---- ④.5【重构四】新增 UI：星尘背景 / 画中画 / 状态提示条 ---- */
  drawStardust(elapsed);
  updateCameraPreview(now);
  updateStatusBar();

  /* ---- ⑤ HUD 与性能统计 ---- */
  state.frameCount++;
  if (now - state.fpsTimer >= 500) {
    state.fps = (state.frameCount * 1000) / (now - state.fpsTimer);
    state.frameCount = 0;
    state.fpsTimer = now;
    adaptQuality();
  }
  updateHud(now);
}

/**
 * 自适应画质：连续多次帧率过低时降低渲染分辨率（最高 2x → 1x），
 * 保证在集成显卡 / 高分屏上依然流畅。
 */
function adaptQuality() {
  if (state.fps < CONFIG.FPS_FLOOR) {
    state.lowFpsStreak++;
  } else {
    state.lowFpsStreak = 0;
  }

  if (state.lowFpsStreak >= 4 && state.pixelRatio > 1) {
    state.pixelRatio = 1;
    three.renderer.setPixelRatio(1);
    three.uniforms.uPixelRatio.value = 1;
    three.uniforms.uSizeScale.value = computeSizeScale();
    state.lowFpsStreak = 0;
    console.info('[性能] 帧率偏低，已把渲染分辨率降到 1x');
  }
}

/* ============================================================================
 * 第 11 节 · 窗口尺寸变化处理
 * ========================================================================== */
function handleResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  /* WebGL 不可用时 three.renderer 为 null：此时仍要让骨架画布保持可用，
     否则 resize 会直接抛异常，把后面的逻辑全部打断。 */
  if (!three.renderer) {
    dom.skeletonCanvas.width = Math.floor(w * state.pixelRatio);
    dom.skeletonCanvas.height = Math.floor(h * state.pixelRatio);
    dom.skeletonCanvas.style.width = w + 'px';
    dom.skeletonCanvas.style.height = h + 'px';
    skCtx.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
    clearSkeleton();
    /* 【重构四】即使 WebGL 不可用，星尘背景也应跟随窗口重建 */
    initStardust();
    return;
  }

  /* 渲染器 */
  three.renderer.setPixelRatio(state.pixelRatio);
  three.renderer.setSize(w, h, false);

  /* 相机 */
  three.camera.aspect = w / Math.max(1, h);
  three.camera.updateProjectionMatrix();

  /* 点尺寸随视口高度自适应 */
  three.uniforms.uPixelRatio.value = state.pixelRatio;
  three.uniforms.uSizeScale.value = computeSizeScale();

  /* 【新增】两个特效对象的点尺寸同样需要跟着视口更新，
     否则窗口缩放后光桥/文字的粒子大小会与花朵不一致 */
  if (three.bridge) {
    three.bridge.uniforms.uPixelRatio.value = state.pixelRatio;
    three.bridge.uniforms.uSizeScale.value = computeSizeScale();
  }
  if (three.spell) {
    three.spell.uniforms.uPixelRatio.value = state.pixelRatio;
    three.spell.uniforms.uSizeScale.value = computeSizeScale();
  }
  /* 【新增】绘画粒子池的点尺寸同样跟随视口 */
  if (three.paint) {
    three.paint.uniforms.uPixelRatio.value = state.pixelRatio;
    three.paint.uniforms.uSizeScale.value = computeSizeScale();
  }

  /* 骨架画布：按设备像素比设置内部分辨率，避免模糊 */
  dom.skeletonCanvas.width = Math.floor(w * state.pixelRatio);
  dom.skeletonCanvas.height = Math.floor(h * state.pixelRatio);
  dom.skeletonCanvas.style.width = w + 'px';
  dom.skeletonCanvas.style.height = h + 'px';
  skCtx.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
  clearSkeleton();

  /* 【重构四】星尘画布也要跟着视口重建（否则窗口缩放后会拉伸变形） */
  initStardust();
}

/* ============================================================================
 * 第 12 节 · 友好的错误提示
 * ========================================================================== */

/**
 * 把浏览器抛出的异常翻译成「人能看懂」的中文提示
 * @param {Error & {name?: string}} err
 * @returns {{title: string, detail: string, tips: string[]}}
 */
function describeError(err) {
  const name = (err && err.name) || 'UnknownError';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        title: '摄像头权限被拒绝',
        detail: '浏览器或系统阻止了本页面访问摄像头，因此无法识别手势。',
        tips: [
          '点击地址栏左侧的「摄像头 / 锁」图标，把权限改为「允许」，然后点击下面的「重试」。',
          '如果是 Windows，请到「设置 → 隐私和安全性 → 摄像头」中，允许桌面应用访问摄像头。',
          '也可以在关闭提示后使用「演示模式」预览花朵效果。'
        ]
      };

    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        title: '没有找到摄像头设备',
        detail: '系统没有检测到任何可用的摄像头，可能是设备未连接或被禁用。',
        tips: [
          '确认摄像头已插好（或笔记本的内置摄像头没有被 Fn 快捷键关闭）。',
          '在「设备管理器 → 照相机」中检查设备是否被禁用。',
          '若确实没有摄像头，请使用「演示模式」，花朵依然可以自动开合。'
        ]
      };

    case 'NotReadableError':
    case 'TrackStartError':
      return {
        title: '摄像头被占用或无法读取',
        detail: '摄像头已存在，但被其它程序占用，或驱动拒绝交出画面。',
        tips: [
          '关闭正在使用摄像头的程序（如腾讯会议、钉钉、QQ、OBS、相机应用等），然后重试。',
          '可以尝试拔插一次 USB 摄像头，或重启浏览器。',
          '仍然不行时，请使用「演示模式」。'
        ]
      };

    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return {
        title: '摄像头不支持请求的分辨率',
        detail: '当前设备无法满足 1280×720 的采集要求。',
        tips: [
          '点击「重试」，代码会自动放宽分辨率约束。',
          '或换一个摄像头设备再试。'
        ]
      };

    case 'SecurityError':
      return {
        title: '当前环境不允许使用摄像头',
        detail: '摄像头 API 只在安全上下文中可用，直接双击打开 html 文件（file://）会被浏览器禁用。',
        tips: [
          '请在项目目录执行：python -m http.server 5500',
          '然后用浏览器访问 http://localhost:5500 （localhost 被视为安全上下文）。',
          '如果通过局域网 IP 访问，需要使用 https:// 才能启用摄像头。'
        ]
      };

    case 'NotSupportedError':
      return {
        title: '当前浏览器不支持摄像头接口',
        detail: '没有找到 navigator.mediaDevices.getUserMedia，可能是浏览器版本过旧或处于非安全上下文。',
        tips: [
          '请使用较新版本的 Chrome / Edge / Firefox。',
          '确认通过 http://localhost 或 https:// 访问页面。',
          '可以使用「演示模式」继续浏览效果。'
        ]
      };

    case 'LoadError':
      return {
        title: '手部识别模型加载失败',
        detail: '无法从 CDN 下载 MediaPipe Hands 的 wasm / 模型文件，通常是网络问题。',
        tips: [
          '检查网络连接，确认可以访问 cdn.jsdelivr.net。',
          '如果处于公司网络 / 校园网，请尝试更换网络或配置代理后重试。',
          '点击「重试」重新加载；也可以先用「演示模式」查看花朵效果。'
        ]
      };

    case 'CameraNotStarted':
      return {
        title: '摄像头还没有启动',
        detail: '当前处于演示模式，而摄像头并未开启，因此没有手势数据可以接管。',
        tips: [
          '点击下面的「重试」来开启摄像头并加载手部识别。',
          '如果之前拒绝过摄像头权限，请先把地址栏左侧的权限改成「允许」，再点「重试」。',
          '想继续看效果，关闭本提示即可，演示模式会自动开合花朵。'
        ]
      };

    case 'WebGLContextLost':
      return {
        title: '图形渲染中断',
        detail: 'WebGL 上下文被系统回收，通常是显卡驱动重置、切换独显，或电脑刚从休眠中唤醒。',
        tips: [
          '刷新页面（F5）即可恢复渲染。',
          '如果频繁出现，可在浏览器设置里关闭「使用硬件加速模式」后重试，或更新显卡驱动。',
          '同时开着多个 3D 页面 / 游戏会增加上下文被回收的概率，可先关闭它们。'
        ]
      };

    default:
      return {
        title: '出了点小问题',
        detail: '初始化过程中发生未预期的错误：' + ((err && err.message) || String(err)),
        tips: [
          '点击「重试」重新初始化。',
          '若问题持续，请刷新页面（F5）。',
          '可以使用「演示模式」继续查看花朵效果。'
        ]
      };
  }
}

/**
 * 展示错误面板
 * @param {Error} err 原始异常
 * @param {boolean} allowRetry 是否显示「重试」按钮
 */
function showError(err, allowRetry = true) {
  const info = describeError(err);

  dom.errorTitle.textContent = info.title;
  dom.errorDetail.textContent = info.detail;

  /* 清空并填充建议列表 */
  dom.errorList.innerHTML = '';
  info.tips.forEach((tip) => {
    const li = document.createElement('li');
    li.textContent = tip;
    dom.errorList.appendChild(li);
  });

  dom.errorRetryBtn.hidden = !allowRetry;
  dom.errorPanel.hidden = false;

  /* 摄像头失败时，HUD 也要同步显示为异常状态 */
  if (err && (err.name === 'NotAllowedError' || err.name === 'NotFoundError' || err.name === 'NotReadableError')) {
    setHud(dom.hudCamera, '不可用', 'bad');
  }
  console.warn('[错误]', info.title, err);
}

/** 关闭错误面板 */
function hideError() {
  dom.errorPanel.hidden = true;
}

/* ============================================================================
 * 第 13 节 · 启动流程与交互事件
 * ========================================================================== */

/** 显示启动页的加载提示 */
function showBootLoading(text) {
  dom.bootLoadingText.textContent = text;
  dom.bootLoading.hidden = false;
  dom.bootStartBtn.disabled = true;
  dom.bootDemoBtn.disabled = true;
}

/** 隐藏启动页 */
function hideBoot() {
  dom.bootOverlay.hidden = true;
}

/**
 * 进入演示模式：不需要摄像头，花朵按正弦曲线自动开合。
 * @param {string} [reason] 进入演示模式的原因，会显示在提示条上
 */
function enterDemoMode(reason) {
  /* 【任务四 · Bug 修复】这里原来有一行 `state.handsReady = false;`
   * 它就是“演示模式关闭后手势失效”的根因：
   *   · handsReady 被置为 false → handsLoop() 的 while 条件立刻不成立，识别循环退出
   *   · exitDemoMode() 里又用 `if (state.handsReady) handsLoop();` 去重启，
   *     可此时这个标志已经是 false → 永远不会重启
   *   · 结果：摄像头还在，MediaPipe 实例也还在，但再也没人把画面喂给它了，
   *     花朵从此只受鼠标/演示曲线控制，手势完全失灵。
   *
   * 修复思路：演示模式只是一种【显示层】的状态，不应该动底层识别链路的就绪标志。
   * 识别循环本身已经用 `!state.demoMode` 主动让路（见 handsLoop 的 while 条件），
   * 所以这里保留 handsReady 为 true 即可，退出时 handsLoop() 能顺利重启。 */
  state.demoMode = true;

  /* 进入演示时清掉比耶特效，避免文字卡在屏幕上不走（比耶需要手势维持） */
  state.peaceActive = false;
  state.peaceHeldFor = 0;
  state.peaceFrames = 0;
  state.peaceReleasedFor = 0;
  state.spellActive = false;
  state.spellLockUntil = 0;

  hideBoot();
  hideError();
  dom.btnDemo.setAttribute('aria-pressed', 'true');
  dom.hintBar.classList.add('highlight');
  if (reason) {
    dom.hintText.textContent = reason;
  }
  /* 演示模式也随机给一个初始相位，避免每次从花苞开始 */
  if (!state.running) {
    startRenderLoop();
  }
}

/** 退出演示模式，回到摄像头手势控制 */
function exitDemoMode() {
  if (!state.cameraReady) {
    /* 【排错修复】这里原先复用 'NotFoundError'，会被 describeError 翻译成
     * 「没有找到摄像头设备 / 请检查设备管理器」，而真实原因只是「没开着摄像头」，
     * 属于误报，会把用户引导去查硬件。改用专属名称给出准确提示。 */
    showError({
      name: 'CameraNotStarted',
      message: '演示模式下无法切回手势控制：摄像头尚未启动。'
    }, true);
    return;
  }

  state.demoMode = false;
  dom.btnDemo.setAttribute('aria-pressed', 'false');
  dom.hintBar.classList.remove('highlight');

  /* 【任务四 · Bug 修复】重置识别链路的所有“残留状态”，让手势立刻重新接管：
   *   · 清空滑动窗口与平滑值：否则会残留演示模式那条正弦曲线算出来的 tension，
   *     切回来的一瞬间花朵会先按旧值摆一下再归位；
   *   · 清空手部缓存：避免用一份过期的骨架画出鬼影；
   *   · handPresent 复位为 false：下一帧识别到手时会走“重新捕获”分支，
   *     清空窗口并立刻生效，而不是等 5 帧平均。
   * 注意 handsReady 故意【不】在这里重置——它应为 true，才能让下面的
   * handsLoop() 真正跑起来；若为 false 说明摄像头/模型确实没就绪，
   * 此时 handsLoop 内部会自行等待，不会空转。 */
  state.tensionWindow.length = 0;
  state.rawTension = 0;
  state.windowedTension = 0;
  state.smoothTension = 0;
  state.targetSpread = 0;
  state.handLandmarksList = [];
  state.landmarkCount = 0;
  state.handPresent = false;
  state.lastHandSeenAt = 0;
  state.peaceActive = false;
  state.peaceHeldFor = 0;
  state.peaceFrames = 0;
  state.peaceReleasedFor = 0;
  state.bridgeAlpha = 0;
  state.bridgeTarget = 0;
  state.spellAlpha = 0;
  state.spellTarget = 0;
  state.flowerScatter = 0;
  clearSkeleton();

  /* 重新拉起识别循环（handsLoop 自带 handsLoopRunning 重入保护，
     即使它还在跑也不会出现两个循环并行） */
  handsLoop();
}

/** 启动渲染循环（只启动一次） */
function startRenderLoop() {
  if (state.running) return;
  state.running = true;
  three.clock.start();
  state.fpsTimer = performance.now();
  requestAnimationFrame(animate);
}

/**
 * 完整启动流程：摄像头 → MediaPipe → 主循环
 */
async function startWithCamera() {
  showBootLoading('正在请求摄像头权限…');

  /* ---- 第一步：摄像头 ---- */
  try {
    await setupCamera();
  } catch (err) {
    /* 摄像头失败不是致命错误：给出友好提示，并允许进入演示模式 */
    dom.bootLoading.hidden = true;
    dom.bootStartBtn.disabled = false;
    dom.bootDemoBtn.disabled = false;
    showError(err, true);
    return;
  }

  /* ---- 第二步：MediaPipe Hands ---- */
  showBootLoading('正在加载手部关键点识别模型…');
  try {
    await setupHands();
  } catch (err) {
    /* 模型加载失败：仍然渲染花朵（无手势），并提示可切换演示模式 */
    dom.bootLoading.hidden = true;
    dom.bootStartBtn.disabled = false;
    dom.bootDemoBtn.disabled = false;
    startRenderLoop();
    showError(err, true);
    return;
  }

  /* ---- 第三步：进入正常运行 ---- */
  dom.bootLoading.hidden = true;
  hideBoot();
  hideError();
  state.demoMode = false;
  dom.btnDemo.setAttribute('aria-pressed', 'false');
  setHud(dom.hudCamera, '已连接', 'ok');
  setHud(dom.hudHand, '正在识别…', 'warn');

  startRenderLoop();
  handsLoop();
}

/* ---------------------------------------------------------------------------
 * 13.1 按钮与键盘事件
 * ----------------------------------------------------------------------------
 * 【排错修复】startWithCamera() 是 async 函数，放在事件回调里直接调用时，
 * 它返回的 Promise 没有任何人接管。虽然函数内部已经用 try/catch 包住了
 * 摄像头与 MediaPipe 两个阶段，但一旦将来有人在函数里新增了 try 之外的
 * await（或 cleanUp 自身抛错），就会变成「未捕获的 Promise 拒绝」——
 * 控制台报 Uncaught (in promise)，而用户界面上什么都不显示。
 * 这里统一用 runStart() 兜底，保证任何漏网异常都能变成可见提示。
 * ------------------------------------------------------------------------ */
function runStart() {
  startWithCamera().catch((err) => {
    console.error('[启动] 未预期的失败：', err);
    dom.bootLoading.hidden = true;
    dom.bootStartBtn.disabled = false;
    dom.bootDemoBtn.disabled = false;
    showError(err, true);
  });
}

/* 启动页：开启摄像头 */
dom.bootStartBtn.addEventListener('click', () => {
  runStart();
});

/* 启动页：直接进入演示模式 */
dom.bootDemoBtn.addEventListener('click', () => {
  enterDemoMode('演示模式：花朵按固定节奏自动开合，移动鼠标也能带它走');
  /* 无摄像头时，用鼠标位置驱动指尖跟随，方便预览交互 */
  bindMouseFallback();
});

/* 错误面板：重试 */
dom.errorRetryBtn.addEventListener('click', () => {
  hideError();
  state.retryCount = (state.retryCount || 0) + 1;
  /* 重试时放宽分辨率约束，提高老旧摄像头 / 虚拟摄像头的成功率。
     第一次重试就放宽：真正会走到这里的用户，多半已经因为
     1280×720 之类的约束被 OverconstrainedError 拦下了。 */
  state.relaxConstraints = true;
  /* 上一轮可能失败在 MediaPipe 阶段，这里把识别状态复位，允许重新初始化 */
  state.handsReady = false;
  runStart();
});

/* 错误面板：改用演示模式 */
dom.errorDemoBtn.addEventListener('click', () => {
  enterDemoMode('已切换到演示模式：花朵自动开合，移动鼠标可让花朵跟随');
  bindMouseFallback();
});

/* 错误面板：关闭 */
dom.errorCloseBtn.addEventListener('click', () => {
  hideError();
  /* 关闭后至少保证能看到花朵 */
  if (!state.running) {
    startRenderLoop();
  }
});

/* 工具栏：骨架开关 */
dom.btnSkeleton.addEventListener('click', () => {
  state.showSkeleton = !state.showSkeleton;
  dom.btnSkeleton.setAttribute('aria-pressed', String(state.showSkeleton));
  document.body.classList.toggle('skeleton-hidden', !state.showSkeleton);
  if (!state.showSkeleton) clearSkeleton();
});

/* 工具栏：摄像头背景开关（C 键）—— 切换全屏背景层的透明度 */
dom.btnCamera.addEventListener('click', () => {
  state.showCamera = !state.showCamera;
  dom.btnCamera.setAttribute('aria-pressed', String(state.showCamera));
  document.body.classList.toggle('cam-hidden', !state.showCamera);
});

/* 工具栏：画中画预览开关（P 键）—— 独立于上面全屏背景的开关
 * 两个开关作用对象不同，互不干扰：
 *   C 键 → body.cam-hidden → 控制 #cam（全屏背景层）的 opacity
 *   P 键 → #camPreview.hidden → 控制右上角预览窗的 opacity + scale
 */
if (dom.btnPreview) {
  dom.btnPreview.addEventListener('click', () => {
    setPreviewVisible(!state.showPreview);
  });
}

/* 工具栏：演示模式开关 */
dom.btnDemo.addEventListener('click', () => {
  if (state.demoMode) {
    exitDemoMode();
  } else {
    /* 手动打开演示模式：停止手部识别，让花朵自己表演 */
    enterDemoMode('演示模式：花朵自动开合，按空格可切回手势控制');
  }
});

/* 工具栏：重置指尖跟随 */
dom.btnReset.addEventListener('click', () => {
  state.pointerTarget.set(0, 0, 0);
  state.pointerCurrent.set(0, 0, 0);
  /* 同时把 tension 平滑状态复位，避免残留的极值影响手感 */
  state.tensionWindow.length = 0;
  state.smoothTension = 0;
  state.windowedTension = 0;
  state.rawTension = 0;
});

/* 工具栏：全屏 */
dom.btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((err) => {
      console.warn('全屏失败：', err);
    });
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

/* 键盘快捷键：空格=演示，K=骨架，C=摄像头背景，P=画中画，R=重置，F=全屏
 * 注意 C 与 P 是两个独立的 case，互不冲突：
 *   C → 切换全屏背景层（#cam 的 opacity 0.2 / 0）
 *   P → 切换右上角画中画（#camPreview 的显示 / 隐藏）
 * 因为用的是 switch(e.code)，每个键只会命中一个分支，不存在同时触发。 */
window.addEventListener('keydown', (e) => {
  /* 避免在输入框里打字时触发快捷键（本项目暂无输入框，属于防御性写法） */
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      dom.btnDemo.click();
      break;
    case 'KeyK':
      dom.btnSkeleton.click();
      break;
    case 'KeyC':
      dom.btnCamera.click();
      break;
    case 'KeyP':
      /* 直接调用切换函数，避免在按钮尚未绑定时出现空指针 */
      setPreviewVisible(!state.showPreview);
      break;
    case 'KeyR':
      dom.btnReset.click();
      break;
    case 'KeyF':
      dom.btnFullscreen.click();
      break;
    default:
      break;
  }
});

/* ---------------------------------------------------------------------------
 * 13.2 鼠标 / 触摸兜底交互
 * ---------------------------------------------------------------------------
 * 没有摄像头时（演示模式），用鼠标位置驱动指尖跟随，
 * 按住鼠标左键还可以手动把张力推到“全开”，松开回到中间值 —— 方便调试。
 * ------------------------------------------------------------------------ */
let mouseBound = false;

function bindMouseFallback() {
  if (mouseBound) return;
  mouseBound = true;

  const onMove = (clientX, clientY) => {
    /* 有手势控制时以手势为准；其余情况（无摄像头 / 演示模式 / 手不在画面）
       鼠标与触摸都可以驱动花朵跟随 */
    const handAlive = state.landmarkCount > 0 &&
      (performance.now() - state.lastHandSeenAt) < CONFIG.HAND_LOST_TIMEOUT;
    if (!state.demoMode && state.cameraReady && handAlive) return;

    state.mouseActiveAt = performance.now();

    const ndcX = (clientX / window.innerWidth) * 2 - 1;
    const ndcY = -((clientY / window.innerHeight) * 2 - 1);

    const halfH = Math.tan((CONFIG.CAMERA_FOV * Math.PI) / 360) * CONFIG.CAMERA_Z;
    const halfW = halfH * (window.innerWidth / Math.max(1, window.innerHeight));
    const usableX = Math.max(0.2, halfW - CONFIG.FLOWER_RADIUS * 0.85) * CONFIG.POINTER_STRENGTH;
    const usableY = Math.max(0.2, halfH - CONFIG.FLOWER_RADIUS * 0.85) * CONFIG.POINTER_STRENGTH;

    state.pointerTarget.set(ndcX * usableX, ndcY * usableY, 0);
  };

  window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY), { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length > 0) {
      onMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  /* 鼠标按住不放 → 强制张开（把张力拉到 1），用于手动演示花朵绽放 */
  window.addEventListener('mousedown', () => {
    if (state.demoMode || !state.cameraReady) {
      state.forcedTension = 1;
    }
  });
  window.addEventListener('mouseup', () => {
    state.forcedTension = null;
  });
}

/* ---------------------------------------------------------------------------
 * 13.3 窗口事件
 * ------------------------------------------------------------------------ */
window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', () => {
  /* 移动端旋转屏幕后尺寸要等一拍才稳定 */
  window.setTimeout(handleResize, 250);
});

/* 页面隐藏时释放一点性能：暂停识别循环里的高频画面处理。
 * MediaPipe 的 hands.send 非常吃 CPU，切到后台标签页后浏览器虽然会把
 * requestAnimationFrame 降到 1Hz 左右，但识别循环用的是 while + setTimeout，
 * 并不会自动停，所以必须在这里手动暂停，回到前台再自动恢复。 */
document.addEventListener('visibilitychange', () => {
  state.pageHidden = document.hidden;

  if (document.hidden) {
    /* 清空识别结果：避免回到前台时用一份过期骨架画出“鬼影” */
    state.landmarkCount = 0;
    state.handLandmarksList = [];
    clearSkeleton();
  } else if (state.handsReady && !state.demoMode && state.running) {
    /* 回到前台，重新拉起识别循环（handsLoop 自身有重入保护） */
    handsLoop();
  }
});

/* 页面关闭前释放摄像头占用（与失败重试共用同一个释放函数） */
window.addEventListener('beforeunload', () => {
  releaseCameraStream();
});

/* ---------------------------------------------------------------------------
 * 兜底：捕获所有「未处理的 Promise 拒绝」
 * ----------------------------------------------------------------------------
 * 【排错修复新增】浏览器 API（getUserMedia / play / MediaPipe 的 wasm 加载）
 * 全是异步的，任何一处漏接的 Promise 都只会安静地在控制台留一行
 * Uncaught (in promise)，界面上毫无反应 —— 这正是最难排查的一类“漏洞”。
 * 这里统一接住并给出可见提示，同时保证它不会打断渲染循环。
 * ------------------------------------------------------------------------ */
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  console.error('[未处理的 Promise 拒绝]', reason);

  /* 防止浏览器默认在控制台重复打印一次 */
  event.preventDefault();

  /* 已经在运行的场景下不要弹窗打扰用户：只提示，不打断体验。
     只有在“还没成功启动过”时才弹出错误面板。 */
  if (!state.cameraReady && !state.demoMode) {
    dom.bootLoading.hidden = true;
    dom.bootStartBtn.disabled = false;
    dom.bootDemoBtn.disabled = false;
    showError(reason instanceof Error ? reason : new Error(String(reason)), true);
  } else {
    dom.hintText.textContent = '出现了一个异步错误，已自动忽略（详情见控制台 F12）';
    dom.hintBar.classList.add('highlight');
  }
});

/* ============================================================================
 * 第 14 节 · 程序入口
 * ========================================================================== */
function bootstrap() {
  /* ---- 初始化 Three.js ---- */
  initThree();

  /* ---- 初始化画布尺寸 ---- */
  handleResize();

  /* ---- 立即开始渲染：即使还没开摄像头，也能先看到花苞与粒子 ---- */
  startRenderLoop();

  /* ---- 环境自检：把最坏的情况提前告知用户 ---- */
  if (!window.isSecureContext) {
    showError({ name: 'SecurityError', message: '当前页面不是安全上下文' }, false);
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError({ name: 'NotSupportedError', message: '浏览器不支持 getUserMedia' }, false);
    return;
  }

  /* WebGL 上下文创建失败的保护 */
  if (!three.renderer || !three.renderer.getContext()) {
    showError(new Error('WebGL 初始化失败，请确认浏览器已启用硬件加速。'), false);
    return;
  }

  /* 预绑定鼠标兜底（真正生效需要进入演示模式） */
  bindMouseFallback();

  console.info(
    '%c指尖花开%c 已就绪：粒子数 ' + CONFIG.PARTICLE_COUNT +
    '，请点击「开启摄像头并开始」。',
    'color:#ff3f8e;font-weight:700;',
    'color:#8b5cff;'
  );
}

bootstrap();
