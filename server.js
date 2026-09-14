/* 家庭成长积分 · 小超人银行 —— 轻量后端
 * 功能：账号登录、积分状态持久化、加减分/审批/兑换/按账号授权/扣分/带娃备注
 * 运行：node server.js   （默认端口 8080，可用 PORT 环境变量覆盖）
 * 数据存于 ./data/ 目录（state.json 积分状态，accounts.json 账号权限）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ============ 外部持久化：GitHub 私密 Gist（根治免费层临时磁盘重启丢数据） ============
 * 未配置时自动降级为纯本地模式，不影响任何功能。
 * 配置方式（Render 环境变量）：GIST_TOKEN=你的GitHub令牌(仅gist权限)  GIST_ID=你的私密gist的ID
 */
const GIST_TOKEN = process.env.GIST_TOKEN || '';
const GIST_ID = process.env.GIST_ID || '';
const GIST_ON = !!(GIST_TOKEN && GIST_ID);
const GIST_FILE = 'bank-data.json';
// 签名 token 密钥（固定即可，重启后旧 token 仍有效）
const SECRET = process.env.BANK_SECRET || 'coco-bank-2026-secret';

/* ============ 北京时间（UTC+8）工具函数（避免 Render 等服务器默认 UTC 导致显示差 8 小时） ============ */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
function nowCN() { return new Date(Date.now() + TZ_OFFSET_MS); }
function asCN(d) { return new Date(d.getTime() + TZ_OFFSET_MS); }
function fmtCN(d = new Date()) {
  // 输出 ISO 8601 +08:00，例如 2026-09-14T16:59:10+08:00
  // 既保留精确绝对时间，又明确标注北京时间，跨时区服务器解析不会错
  const c = asCN(d); const p = n => String(n).padStart(2, '0');
  return c.getUTCFullYear() + '-' + p(c.getUTCMonth() + 1) + '-' + p(c.getUTCDate()) + 'T' +
         p(c.getUTCHours()) + ':' + p(c.getUTCMinutes()) + ':' + p(c.getUTCSeconds()) + '+08:00';
}
function fileStamp(d = new Date()) {
  const c = asCN(d); const p = n => String(n).padStart(2, '0');
  return c.getUTCFullYear() + p(c.getUTCMonth() + 1) + p(c.getUTCDate()) + '-' + p(c.getUTCHours()) + p(c.getUTCMinutes()) + p(c.getUTCSeconds());
}
function startOfDayCN(d = new Date()) {
  const c = asCN(d);
  return new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate()) - TZ_OFFSET_MS);
}
function sameDayCN(a, b) { return startOfDayCN(a).getTime() === startOfDayCN(b).getTime(); }
function weekKeyCN(d = new Date()) {
  const sod = startOfDayCN(d); const c = asCN(d);
  const dow = (c.getUTCDay() + 6) % 7; // 周一为 0
  return sod.getTime() - dow * 86400000;
}
function samePeriodCN(ts, now, period) {
  let r;
  if (typeof ts === 'number') r = new Date(ts);
  else if (typeof ts === 'string' && (ts.includes('T') || ts.includes('+') || ts.includes('Z'))) r = new Date(ts); // 新 ISO
  else r = new Date(String(ts) + ' UTC'); // 旧版 locale 字符串按 UTC 解析（旧版在 UTC 服务器生成）
  if (isNaN(r)) r = new Date();
  if (period === 'day') return sameDayCN(r, now);
  if (period === 'week') return weekKeyCN(r) === weekKeyCN(now);
  return false;
}
function migrateLegacyTs(ts) {
  if (!ts || typeof ts !== 'string') return ts;
  if (ts.includes('T') || ts.includes('+') || ts.includes('Z')) return ts; // 已为新 ISO
  const d = new Date(ts + ' UTC');
  return isNaN(d) ? ts : fmtCN(d);
}
function migrateAllTimestamps(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach(migrateAllTimestamps); return; }
  for (const k of Object.keys(obj)) {
    if ((k === 'ts' || k === 'voidAt' || k === 'exportedAt') && typeof obj[k] === 'string') obj[k] = migrateLegacyTs(obj[k]);
    else if (typeof obj[k] === 'object') migrateAllTimestamps(obj[k]);
  }
}

function gistReq(method, apiPath, body) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'User-Agent': 'coco-bank', 'Authorization': 'token ' + GIST_TOKEN };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request({ hostname: 'api.github.com', path: apiPath, method, headers }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (data) req.write(data);
    req.end();
  });
}
async function pushGist() {
  if (!GIST_ON) return;
  const payload = { files: {} };
  payload.files[GIST_FILE] = { content: JSON.stringify({ accounts, state, rules: RULES, audit }) };
  gistReq('PATCH', '/gists/' + GIST_ID, payload); // 异步、不阻塞主流程
}
async function pullGist() {
  if (!GIST_ON) return null;
  const g = await gistReq('GET', '/gists/' + GIST_ID);
  if (g && g.files && g.files[GIST_FILE]) { try { return JSON.parse(g.files[GIST_FILE].content); } catch (e) { return null; } }
  return null;
}

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
const STATE_FILE = path.join(DATA, 'state.json');
const ACCT_FILE = path.join(DATA, 'accounts.json');
const CONFIG_FILE = path.join(DATA, 'config.json');
const AUDIT_FILE = path.join(DATA, 'audit.json');
const BACKUP_DIR = path.join(DATA, 'backup');
const PORT = process.env.PORT || 8080;

/* ============ 积分规则（单一事实来源，运行时来自 data/config.json，可前端编辑） ============ */
let RULES = {
  dim: [
    { key: '学习', name: '📘 学习小达人', color: '#3B82F6', type: '习惯' },
    { key: '运动', name: '🏀 运动小健将', color: '#F97316', type: '习惯' },
    { key: '家务', name: '🧺 家务小帮手', color: '#22C55E', type: '习惯' },
    { key: '自理', name: '⏰ 自理小能手', color: '#EAB308', type: '习惯' },
    { key: '品格', name: '🤝 品格小君子', color: '#A855F7', type: '品格' },
    { key: '勇气', name: '🦸 勇气小超人', color: '#EF4444', type: '品质' },
  ],
  items: [
    // 学习
    { dim: '学习', name: '完成作业', score: '2', mode: '固定', freq: '每日1次', op: '爸妈/外公外婆', desc: '孩子记不住作业，家长告知后完成', eg: '今天独立完成口算作业' },
    { dim: '学习', name: '作业不拖拉', score: '0~2', mode: '质量', freq: '每日1次', op: '爸妈/外公外婆', desc: '20分钟内自开始=2｜催1次=1｜催2次+=0', opts: [['按时(20分钟内自开始)', 2], ['催1次', 1], ['催2次以上', 0]], eg: '20分钟内自己开始写，没催' },
    { dim: '学习', name: '自主订正（只说有错，自己找出）', score: '3', mode: '固定', freq: '每日1次', op: '爸妈/外公外婆', desc: '未指位置才算自主；前两周给范围提示仍算', eg: '自己找出错字并改正' },
    { dim: '学习', name: '按要求订正（指出具体错误后改）', score: '1', mode: '固定', freq: '每日1次', op: '爸妈/外公外婆', desc: '与上式不重复，取高者', eg: '老师说第3题错了，我改对' },
    { dim: '学习', name: '算术 1 页', score: '1', mode: '固定', freq: '可累计·日上限2页', op: '爸妈/外公外婆', eg: '完成算术1页' },
    { dim: '学习', name: '练字 1 页', score: '1', mode: '固定', freq: '可累计·日上限2页', op: '爸妈/外公外婆', eg: '练字1页' },
    { dim: '学习', name: '英语单词 4 个', score: '2', mode: '固定', freq: '可累计·日上限2组', op: '爸妈/外公外婆', eg: '背会4个新单词 apple/book/cat/dog' },
    { dim: '学习', name: '古诗 1 首（背/复习）', score: '2', mode: '固定', freq: '可累计·日上限2首', op: '爸妈/外公外婆', eg: '背诵《静夜思》' },
    { dim: '学习', name: '课外阅读 20 分钟', score: '3', mode: '固定', freq: '每日1次', op: '爸妈', eg: '读了20分钟绘本' },
    { dim: '学习', name: '主动讲解知识/教别人', score: '2', mode: '固定', freq: '每日1次', op: '爸妈/外公外婆', eg: '给爸爸讲恐龙知识' },
    { dim: '学习', name: '复习/预习 15 分钟', score: '2', mode: '固定', freq: '每日1次', op: '爸妈/外公外婆', eg: '预习了明天课文' },
    // 运动
    { dim: '运动', name: '跳绳不间断 6 分钟', score: '2~4', mode: '特殊', special: 'rope', floor: 2, freq: '可累计', op: '爸妈/长辈', desc: '完成6分钟=保底2分；备注两项数量，每项≥上次+1分（最高4分）', eg: '跳绳138个，超过上次' },
    { dim: '运动', name: '篮球练习（每组15分钟）', score: '2', mode: '固定', freq: '可累计·日上限2组', op: '长辈', eg: '拍球15分钟 / 运球15分钟' },
    { dim: '运动', name: '篮球训练质量（陪同家长观察打分）', score: '0~5', mode: '复合', freq: '每课1次', op: '陪同家长', desc: '三项分别计分求和：听讲解不分心、队列训练认真、主动观察模仿练习', subs: [{ label: '听讲解不分心', opts: [0, 1, 2] }, { label: '队列训练认真', opts: [0, 1, 2] }, { label: '主动观察模仿练习', opts: [0, 1] }], eg: '听课不闲聊，主动看教练示范' },
    { dim: '运动', name: '亲子跑步（每500米得1分）', score: '1', mode: '固定', freq: '可累计·日上限10组', op: '爸妈/长辈', desc: '每500米得1分；填完成组数（1组=500米）', eg: '绕小区跑2组=1000米=2分' },
    { dim: '运动', name: '亲子骑车（每1公里得1分）', score: '1', mode: '固定', freq: '可累计·日上限10组', op: '爸妈/长辈', desc: '每1公里得1分；填完成公里数', eg: '骑了3公里=3分' },
    { dim: '运动', name: '轮滑练习（每组15分钟）', score: '2', mode: '固定', freq: '可累计·日上限2组', op: '长辈', eg: '轮滑15分钟' },
    { dim: '运动', name: '平板撑（循序渐进·完成2组）', score: '1', mode: '固定', freq: '每日1次', op: '爸妈/长辈', desc: '按循序渐进时间长度完成2组（目前每组约1分半）', eg: '坚持1分半×2组' },
    { dim: '运动', name: '运动三项小标兵（跑步+跳绳+平板撑全做）', score: '1', mode: '固定', freq: '每日1次', op: '爸妈', desc: '当天跑步、跳绳、平板撑都完成，额外+1分（由家长确认三项均做到后申报）', eg: '今日三项运动全做到' },
    // 家务
    { dim: '家务', name: '整理书桌', score: '1', mode: '固定', freq: '每日1次', op: '爸妈/长辈', eg: '书桌收拾干净' },
    { dim: '家务', name: '收拾玩具/书籍，保持整洁', score: '2', mode: '固定', freq: '可累计·日上限2次', op: '爸妈/长辈', eg: '积木归位、绘本放回书架' },
    { dim: '家务', name: '摆收碗筷（仅自己）', score: '1', mode: '固定', freq: '每餐1次', op: '爸妈/长辈', eg: '吃完自己收碗' },
    { dim: '家务', name: '擦餐桌', score: '1', mode: '固定', freq: '每餐1次', op: '爸妈/长辈', eg: '擦干净餐桌' },
    { dim: '家务', name: '洗碗/洗自己的碗', score: '2', mode: '固定', freq: '每日1次', op: '爸妈/长辈', eg: '吃完自己把碗洗干净' },
    { dim: '家务', name: '扫地或擦地一个区域', score: '2', mode: '固定', freq: '每日1次', op: '爸妈/长辈', eg: '扫一块地或擦一块地' },
    { dim: '家务', name: '晾/收衣服', score: '2', mode: '固定', freq: '每日1次', op: '爸妈/长辈', eg: '帮忙晾衣服或收叠干衣' },
    { dim: '家务', name: '把衣服整齐收入衣柜', score: '3', mode: '固定', freq: '每日1次', op: '爸妈/长辈', desc: '稳定后降至2（衰减）', eg: '把叠好的衣服整齐放进衣柜' },
    { dim: '家务', name: '铺床', score: '2', mode: '固定', freq: '每日1次', op: '爸妈/长辈', eg: '铺好被子' },
    { dim: '家务', name: '出门主动带垃圾', score: '2', mode: '固定', freq: '可累计·日上限2次', op: '爸妈/长辈', eg: '出门顺手带垃圾下楼' },
    { dim: '家务', name: '取快递', score: '2', mode: '固定', freq: '可累计·日上限2次', op: '爸妈/长辈', eg: '下楼取了快递' },
    // 自理
    { dim: '自理', name: '闹钟响后自己下床', score: '0~2', mode: '质量', freq: '每日1次', op: '爸妈', desc: '自己起=2｜叫1次=1｜叫2次+=0', opts: [['自己起', 2], ['叫1次', 1], ['叫2次以上', 0]], eg: '闹钟响自己起床' },
    { dim: '自理', name: '自己穿好衣服', score: '1', mode: '固定', freq: '每日1次', op: '爸妈', eg: '自己穿好衣服' },
    { dim: '自理', name: '独立洗漱', score: '1', mode: '固定', freq: '每日1次', op: '爸妈', eg: '自己刷牙洗脸' },
    { dim: '自理', name: '早餐不拖沓', score: '0~2', mode: '质量', freq: '每日1次', op: '爸妈', desc: '15分钟内吃完=2｜催1次=1｜催2次+=0', opts: [['15分钟内吃完', 2], ['催1次', 1], ['叫2次以上', 0]], eg: '15分钟内吃完早餐' },
    { dim: '自理', name: '中餐不拖沓', score: '0~2', mode: '质量', freq: '每日1次', op: '爸妈', desc: '30分钟内吃完=2｜催1次=1｜催2次+=0', opts: [['30分钟内吃完', 2], ['催1次', 1], ['叫2次以上', 0]], eg: '30分钟内吃完中饭' },
    { dim: '自理', name: '晚餐不拖沓', score: '0~2', mode: '质量', freq: '每日1次', op: '爸妈', desc: '30分钟内吃完=2｜催1次=1｜催2次+=0', opts: [['30分钟内吃完', 2], ['催1次', 1], ['叫2次以上', 0]], eg: '30分钟内吃完晚饭' },
    { dim: '自理', name: '按时上床不拖延', score: '3', mode: '固定', freq: '每日1次', op: '爸妈', eg: '到点主动上床' },
    { dim: '自理', name: '上床后不反复起身', score: '2', mode: '固定', freq: '每日1次', op: '爸妈', eg: '上床后没起来玩' },
    { dim: '自理', name: '独立入睡', score: '1~5', mode: '质量', freq: '每日1次', op: '爸妈', desc: '大人在房不陪床=1｜不进房=3｜整晚独立=5', opts: [['大人在房不陪床', 1], ['不进房', 3], ['整晚独立', 5]], eg: '自己睡整晚没进爸妈房' },
    { dim: '自理', name: '自己洗澡', score: '2~4', mode: '质量', freq: '每日1次', op: '爸妈', desc: '独立=4｜需协助=2', opts: [['独立洗', 4], ['需协助', 2]], eg: '自己洗完澡' },
    { dim: '自理', name: '自己擦屁股', score: '1~2', mode: '质量', freq: '可累计', op: '爸妈', desc: '尝试+补擦=1｜独立擦净=2', opts: [['尝试+补擦', 1], ['独立擦净', 2]], eg: '自己擦干净' },
    { dim: '自理', name: '按课表整理书包', score: '3', mode: '固定', freq: '每日1次', op: '爸妈/长辈', eg: '按课表收好书本' },
    // 品格
    { dim: '品格', name: '主动说请/谢谢/对不起', score: '2', mode: '固定', freq: '可累计·日上限3次', op: '爸妈', eg: '主动说谢谢' },
    { dim: '品格', name: '帮助家人/小朋友（摆全家餐具等）', score: '2', mode: '固定', freq: '可累计·每周上限5次', op: '爸妈/长辈', desc: '主动承担额外任务；递杯子等日常关心不算', eg: '帮摆全家餐具' },
    { dim: '品格', name: '诚实（主动承认错误）', score: '4', mode: '固定', freq: '可累计', op: '爸妈', eg: '主动承认打翻了水杯' },
    { dim: '品格', name: '不受同伴影响、守住规则', score: '4', mode: '固定', freq: '可累计', op: '爸妈', eg: '别人吵闹时我守住规矩' },
    { dim: '品格', name: '小主人·迎接朋友（提醒换鞋、洗手、引导）', score: '1', mode: '固定', freq: '每周1次', op: '爸妈', eg: '朋友来，提醒换鞋洗手并引导玩' },
    { dim: '品格', name: '小主人·主动分享玩具/书籍/零食', score: '2', mode: '固定', freq: '每周1次', op: '爸妈', eg: '主动把玩具或零食分享给朋友' },
    { dim: '品格', name: '小主人·遵守约定时间、不超时', score: '2', mode: '固定', freq: '每周1次', op: '爸妈', eg: '到约定时间主动结束游戏' },
    { dim: '品格', name: '小主人·事后自己收拾场地', score: '2', mode: '固定', freq: '每周1次', op: '爸妈', eg: '朋友走后自己收拾玩具和场地' },
    // 勇气品质层
    { dim: '勇气', name: '抗挫坚持（遇挫不放弃、继续尝试）', score: '3~5', mode: '质量', freq: '可累计·日上限2次', op: '爸妈', desc: '英语配音练到满意｜跳绳快速续上｜积木卡住继续', opts: [['坚持完成', 3], ['较难坚持下来', 4], ['多次想放弃仍完成', 5]], eg: '配音没满分仍练到满意' },
    { dim: '勇气', name: '控制情绪、不发脾气（语言代替哭闹）', score: '3', mode: '固定', freq: '每日1次', op: '爸妈', desc: '发脾气时不加分+事后复盘；仅攻击行为走扣分', eg: '想买玩具没买，没哭闹' },
    { dim: '勇气', name: '主动表达/社交勇气', score: '3~5', mode: '质量', freq: '日上限2次', op: '爸妈', desc: '超市问路5｜餐厅点单4｜打招呼/表演3', opts: [['主动问路/办事', 5], ['主动点单', 4], ['主动打招呼/表演', 3]], eg: '在超市主动问阿姨商品在哪' },
    { dim: '勇气', name: '学校举手/朗读/竞选', score: '4', mode: '固定', freq: '每周上限2次', op: '爸妈', desc: '避免与学校积分重复；每周与老师沟通佐证', eg: '课堂上举手朗读' },

  ],
  deduct: [
    { name: '打人/说脏话等不文明行为', score: -5, icon: '✋', desc: '动手或说脏话，伤害别人' },
    { name: '说谎', score: -5, icon: '🙊', desc: '被确认的说谎行为' },
    { name: '危险行为（如马路乱跑）', score: -5, icon: '⚠️', desc: '危及自身或他人安全的行为' },
    { name: '故意破坏他人/公共物品', score: -3, icon: '💔', desc: '故意损坏东西' },
    { name: '未按约定执行（到时未关电视/未回家等）', score: -3, icon: '📺', desc: '已经约定好、提醒后仍不执行' },
  ],
  exchange: [
    { tier: '小兑换（日常）', items: [
      { name: '指定明晚 1 道菜', cost: 5 },
      { name: '多 15 分钟玩具时间', cost: 5 },
      { name: '优质内容时间 20 分钟', cost: 8 },
      { name: '自选动画时间 15 分钟（每周≤3次）', cost: 15 },
      { name: '倾听券（先不批评，听他说完）', cost: 10 },
      { name: '免责沟通券（小错改一起想办法）', cost: 12 },
      { name: '现金 1~5 元（5分/元）', cost: 5 },
      { name: '周末睡前多 1 个故事（延后15分）', cost: 10 },
      { name: '指定家人陪入睡', cost: 8 },
      { name: '指定家人陪整晚', cost: 15 },
    ] },
    { tier: '中兑换（周目标）', items: [
      { name: '延长户外玩耍 30 分钟（基线外）', cost: 20 },
      { name: '邀请朋友来家玩 30 分钟', cost: 25 },
      { name: '决定一次家庭小安排（免费/低成本）', cost: 30 },
    ] },
    { tier: '大兑换（月目标）', items: [
      { name: '邀请朋友来家玩 2 小时', cost: 60 },
      { name: '爸妈专属陪伴日（半天·孩子主导）', cost: 80 },
      { name: '现金包 20 元', cost: 100 },
      { name: '现金包 50 元', cost: 250 },
    ] },
  ],
};

/* ============ 账号与权限（管理员可在「账号权限」中调整） ============ */
const DEFAULT_ACCOUNTS = [
  { id: 'mama', name: '妈妈', role: 'admin', pin: '0000', canDeclare: true },
  { id: 'baba', name: '爸爸', role: 'admin', pin: '0000', canDeclare: true },
  { id: 'waigong', name: '外公', role: 'elder', pin: '1111', directDims: ['学习'], canDeclare: true },
  { id: 'waipo', name: '外婆', role: 'elder', pin: '1111', directDims: ['学习'], canDeclare: true },
  { id: 'yeye', name: '爷爷', role: 'elder', pin: '2222', directDims: [], canDeclare: true },
  { id: 'nainai', name: '奶奶', role: 'elder', pin: '2222', directDims: [], canDeclare: true },
  { id: 'baobao', name: '宝宝', role: 'kid', pin: '3333', canDeclare: false },
];

let accounts = loadJson(ACCT_FILE, DEFAULT_ACCOUNTS);
let state = loadJson(STATE_FILE, defaultState());
let audit = loadJson(AUDIT_FILE, []);
if (!Array.isArray(audit)) audit = [];
// 规则配置持久化：首次从初始 RULES 写入 config.json，之后以 config 为准（支持前端编辑）
const DEFAULT_RULES = JSON.parse(JSON.stringify(RULES));
// 规则自愈：旧版本保存计分卡曾丢失 deduct/exchange，加载后自动补全
function healRules() {
  if (!RULES || !Array.isArray(RULES.dim) || !Array.isArray(RULES.items)) { RULES = JSON.parse(JSON.stringify(DEFAULT_RULES)); return; }
  if (!Array.isArray(RULES.deduct) || !RULES.deduct.length) RULES.deduct = JSON.parse(JSON.stringify(DEFAULT_RULES.deduct));
  if (!Array.isArray(RULES.exchange) || !RULES.exchange.length) RULES.exchange = JSON.parse(JSON.stringify(DEFAULT_RULES.exchange));
}
let cfgRules = loadJson(CONFIG_FILE, null);
if (!cfgRules) { cfgRules = RULES; saveConfig(); } else { RULES = cfgRules; }
healRules();
if (!Array.isArray(state.reminders)) state.reminders = []; // 兼容旧数据
// 时区迁移：把旧版 UTC locale 时间戳转成北京时间字符串（仅影响显示，总分/排序不变）
migrateAllTimestamps(state); migrateAllTimestamps(audit);
// v4 迁移：旧的「日常好习惯」维度按各条目新归属重算到 自理/品格（总分不变）
if (state.points && ('日常好习惯' in state.points)) {
  const pts = {}; RULES.dim.forEach(d => pts[d.key] = 0);
  for (const r of (state.records || [])) {
    if (r.status !== 'confirmed') continue;
    const it = RULES.items.find(i => i.name === r.item);
    if (it && pts[it.dim] !== undefined) pts[it.dim] += (r.type === 'sub' ? -Math.abs(r.score) : r.score);
  }
  state.points = pts; saveState();
}
// 外部持久化：从 Gist 拉取最新数据（根治免费层临时磁盘重启丢数据），异步、不阻塞启动
if (GIST_ON) {
  pullGist().then(d => {
    if (d && d.state && d.accounts) {
      accounts = d.accounts; state = d.state;
      if (d.rules && (Array.isArray(d.rules) || d.rules.items)) { RULES = d.rules; healRules(); }
      if (Array.isArray(d.audit)) audit = d.audit;
      if (!Array.isArray(state.reminders)) state.reminders = [];
      migrateAllTimestamps(state); migrateAllTimestamps(audit);
      saveState();
    }
  }).catch(() => {});
}

function defaultState() {
  return { points: { 学习: 0, 运动: 0, 家务: 0, 自理: 0, 品格: 0, 勇气: 0 }, total: 0, records: [], exchanges: [], reminders: [], carer: '爸妈' };
}
function loadJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
// 本地滚动备份：文件名含北京时分秒，保留最近 6 份（约 1 小时，每 10 分钟一份），避免占空间
function backupRolling() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = fileStamp(new Date());
    fs.writeFileSync(path.join(BACKUP_DIR, 'state-' + stamp + '.json'), JSON.stringify(state));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^state-\d{8}-\d{6}\.json$/.test(f)).sort();
    while (files.length > 6) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) { /* 备份失败不影响主流程 */ }
}
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {} backupRolling(); pushGist(); }
function saveAccounts() { try { fs.writeFileSync(ACCT_FILE, JSON.stringify(accounts, null, 2)); } catch (e) {} pushGist(); }
function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(RULES, null, 2)); } catch (e) {} pushGist(); }
function saveAudit() { try { fs.writeFileSync(AUDIT_FILE, JSON.stringify(audit, null, 2)); } catch (e) {} pushGist(); }
function logAudit(actor, action, detail) {
  audit.unshift({ ts: fmtCN(), actor, action, detail });
  if (audit.length > 200) audit.length = 200;
  saveAudit();
}
function genOf(acc) {
  if (acc.role === 'admin') return '爸妈';
  if (acc.name.includes('外公') || acc.name.includes('外婆')) return '外公外婆';
  return '爷爷奶奶';
}

/* ============ 频次上限解析与统计 ============ */
function parseCap(freq) {
  if (!freq) return null;
  let period = null, max = null;
  const dm = freq.match(/每日1次|每餐1次|每课1次/);
  const dmax = freq.match(/日上限(\d+)/);
  const wm = freq.match(/每周(上限)?1次/);
  const wmax = freq.match(/每周上限(\d+)/);
  if (dm) { period = 'day'; max = freq.includes('每餐') ? 3 : 1; }
  if (dmax) { period = 'day'; max = parseInt(dmax[1], 10); }
  if (wm) { period = 'week'; max = 1; }
  if (wmax) { period = 'week'; max = parseInt(wmax[1], 10); }
  return period ? { period, max } : null;
}
function capUnit(freq) { const m = freq && freq.match(/(次|组|页|首)/); return m ? m[1] : '次'; }
function usage(itemName, period) {
  const now = new Date();
  return state.records
    .filter(r => r.item === itemName && r.status !== 'rejected' && samePeriodCN(r.ts, now, period))
    .reduce((s, r) => s + (r.qty || 1), 0);
}
function usageScore(operatorName, period) {
  const now = new Date();
  return state.records
    .filter(r => r.type === 'add' && r.status === 'confirmed' && r.operator === operatorName && r.approver === operatorName && samePeriodCN(r.ts, now, period))
    .reduce((s, r) => s + r.score, 0);
}

/* ============ 计分核心（与前端 LocalStore 保持一致） ============ */
function computeScore(item, b) {
  if (item.special === 'rope') {
    let s = item.floor || 2;
    const prev = [...state.records].reverse().find(r => r.item === item.name && r.status !== 'rejected' && r.remarks);
    if (prev && prev.remarks) {
      if (Number(b.cont) >= Number(prev.remarks.cont)) s += 1;
      if (Number(b.one) >= Number(prev.remarks.one)) s += 1;
    }
    return Math.min(4, Math.max(item.floor || 2, s));
  }
  if (item.mode === '复合') {
    const vals = (b.subs || []).map(Number);
    return item.subs.reduce((s, sub, i) => s + (vals[i] || 0), 0);
  }
  // 固定分值项：若前端未传分值，则以规则中的固定分为准（避免漏传导致 0 分）
  let sc = parseInt(b.score, 10);
  if (isNaN(sc)) sc = parseInt(String(item.score), 10);
  return Math.max(0, sc || 0);
}

/* ============ HTTP 工具 ============ */
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function ok(res, obj) { send(res, 200, obj); }
function err(res, code, msg) { send(res, code, { error: msg }); }

function makeToken(id) {
  const sig = crypto.createHmac('sha256', SECRET).update(String(id)).digest('hex').slice(0, 16);
  return Buffer.from(String(id)).toString('base64') + '.' + sig;
}
function auth(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const id = Buffer.from(b64, 'base64').toString();
  const expect = crypto.createHmac('sha256', SECRET).update(String(id)).digest('hex').slice(0, 16);
  if (sig !== expect) return null;
  return accounts.find(a => a.id === id) || null;
}

/* ============ 静态文件 ============ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  let f = pathname === '/' ? '/index.html' : pathname;
  const fp = path.join(ROOT, path.normalize(f));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
  // 关键：禁止浏览器缓存页面，避免「打开的还是上次的旧文件」导致登录页身份卡不显示等问题
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
  fs.createReadStream(fp).pipe(res);
}

/* ============ API ============ */
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = req.method;

    if (method === 'GET' && (p === '/' || p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css'))) {
      return serveStatic(req, res, p);
    }

    let b = {};
    try { if (body) b = JSON.parse(body); } catch (e) {}
    const token = b.token || url.searchParams.get('token');

    if (p === '/api/ping') return ok(res, { ok: true, mode: 'server', accounts: accounts.map(a => ({ id: a.id, name: a.name, role: a.role, canDeclare: !!a.canDeclare })) });

    if (p === '/api/rules') return ok(res, RULES);

    // 游客只读视图（无需登录，仅公开概览）
    if (p === '/api/guest' && method === 'GET') {
      const recent = state.records.filter(r => !r.void).slice(0, 20).map(r => ({ ts: r.ts, dim: r.dim, item: r.item, score: r.score, status: r.status }));
      return ok(res, { ok: true, rules: RULES, public: { points: state.points, total: state.total, carer: state.carer, recent } });
    }

    // 登录
    if (p === '/api/login' && method === 'POST') {
      const a = accounts.find(x => x.name === b.name);
      if (!a || a.pin !== String(b.pin || '')) return err(res, 401, '账号或密码错误');
      const token = makeToken(a.id);
      return ok(res, { token, name: a.name, role: a.role, id: a.id, directDims: a.directDims || [], canDeclare: !!a.canDeclare });
    }

    const acc = auth(token);
    if (!acc) return err(res, 401, '登录失效，请重新登录');

    // 计分卡：管理员保存（数据驱动，前端可编辑，无需改文件/重部署）
    if (p === '/api/rules/save' && method === 'POST') {
      if (acc.role !== 'admin') return err(res, 403, '仅管理员可编辑计分卡');
      const nr = b.rules;
      if (!nr || !Array.isArray(nr.dim) || !Array.isArray(nr.items)) return err(res, 400, '计分卡格式不正确');
      const keys = new Set(nr.dim.map(d => d.key));
      for (const it of nr.items) if (!keys.has(it.dim)) return err(res, 400, '项目「' + it.name + '」所属维度不存在');
      const before = JSON.stringify(RULES);
      RULES = Object.assign({}, RULES, nr); // 合并而非整体替换：deduct/exchange 等未编辑部分必须保留
      healRules();
      saveConfig();
      logAudit(acc.name, '编辑计分卡', before === JSON.stringify(RULES) ? '未变化' : '已更新计分卡配置');
      return ok(res, { ok: true });
    }
    // 计分卡修改审计日志（管理员可查，妈妈为最高权限可查看全部）
    if (p === '/api/rules/log' && method === 'GET') {
      if (acc.role !== 'admin') return err(res, 403, '仅管理员可查看');
      return ok(res, { ok: true, audit: audit.filter(a => a.action === '编辑计分卡') });
    }
    // 撤销记录（管理员）：软删除并回滚积分
    if (p === '/api/undo' && method === 'POST') {
      if (acc.role !== 'admin') return err(res, 403, '仅管理员可撤销');
      const r = state.records.find(x => x.id === b.recId);
      if (!r) return err(res, 404, '记录不存在');
      if (r.void) return err(res, 400, '该记录已撤销');
      if (r.status === 'confirmed') {
        if (r.type === 'add') { state.points[r.dim] = Math.max(0, (state.points[r.dim] || 0) - r.score); state.total = Math.max(0, state.total - r.score); }
        else if (r.type === 'sub') { state.total = Math.max(0, state.total - r.score); }
      }
      r.void = true; r.voidBy = acc.name; r.voidAt = fmtCN();
      saveState();
      return ok(res, { ok: true, state });
    }

    if (p === '/api/state' && method === 'GET') return ok(res, state);

    // 加减分
    if (p === '/api/record' && method === 'POST') {
      const item = RULES.items.find(i => i.name === b.item);
      if (!item) return err(res, 400, '项目不存在');
      // 授权：仅管理员、或直接加分者、或被授权申报的长辈可操作
      const authorized = acc.role === 'admin' || (acc.role === 'elder' && acc.canDeclare) || (acc.role === 'elder' && (acc.directDims || []).includes(item.dim));
      if (!authorized) return err(res, 403, '当前账号未获「申报/加分」授权，请联系管理员在「账号权限」中开启');
      const qty = (item.special === 'rope' || item.mode === '复合') ? 1 : Math.max(1, parseInt(b.qty, 10) || 1);
      // 上限校验：先算数量，超出则拒绝
      const cap = parseCap(item.freq);
      if (cap) {
        const used = usage(item.name, cap.period);
        if (used + qty > cap.max)
          return err(res, 400, `「${item.name}」${cap.period === 'day' ? '今日' : '本周'}上限 ${cap.max}${capUnit(item.freq)}，已用 ${used}${capUnit(item.freq)}`);
      }
      const score = computeScore(item, b);
      const totalScore = score * qty;
      let direct = acc.role === 'admin' || (acc.role === 'elder' && (acc.directDims || []).includes(item.dim));
      let notice = '';
      // 外公外婆学习类直接加分：单笔≤3分、日累计≤6分。
      // 超出不禁止提交，而是自动降级为「申报」，待爸妈确认后计分。
      if (acc.role === 'elder' && direct) {
        const used = usageScore(acc.name, 'day');
        if (totalScore > 3) {
          direct = false;
          notice = `本次 ${totalScore} 分超过单笔 3 分上限，已转为申报，等爸妈确认后计分`;
        } else if (used + totalScore > 6) {
          direct = false;
          notice = `今日已直接加 ${used} 分，再加 ${totalScore} 分会超过 6 分上限，已转为申报，等爸妈确认后计分`;
        }
      }
      const rec = {
        id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        ts: fmtCN(),
        dim: item.dim, item: item.name, score: totalScore, qty,
        type: 'add', reason: b.reason || '', operator: acc.name,
        status: direct ? 'confirmed' : 'pending', approver: direct ? acc.name : '',
        remarks: item.special === 'rope' ? { cont: Number(b.cont) || 0, one: Number(b.one) || 0 } : undefined,
      };
      state.records.unshift(rec);
      if (direct) { state.points[item.dim] += totalScore; state.total += totalScore; }
      // 宝宝点击「我做到了」生成的提醒，在大人提交对应项目后自动消除
      state.reminders = state.reminders.filter(rm => rm.item !== item.name);
      saveState();
      return ok(res, { ok: true, status: rec.status, notice });
    }

    // 宝宝提醒：孩子点击「我做到了」生成，大人可见
    if (p === '/api/remind' && method === 'POST') {
      const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      state.reminders.unshift({ id, ts: fmtCN(), item: b.item, operator: acc.name, status: 'pending' });
      saveState();
      return ok(res, { ok: true });
    }

    // 处理/忽略宝宝提醒
    if (p === '/api/remindDismiss' && method === 'POST') {
      if (acc.role === 'kid') return err(res, 403, '仅家长可处理提醒');
      state.reminders = state.reminders.filter(rm => rm.id !== b.id);
      saveState();
      return ok(res, { ok: true });
    }

    // 审批加减分/扣分申请
    if (p === '/api/confirm' && method === 'POST') {
      if (acc.role !== 'admin') return err(res, 403, '仅管理员可审批');
      const r = state.records.find(x => x.id === b.recId);
      if (!r) return err(res, 404, '记录不存在');
      if (b.approve) {
        if (r.status !== 'confirmed') {
          r.status = 'confirmed'; r.approver = acc.name;
          if (r.type === 'add') { state.points[r.dim] += r.score; state.total += r.score; }
          else if (r.type === 'sub') { state.total += r.score; }
        }
      } else {
        if (r.status !== 'rejected') { r.status = 'rejected'; r.approver = acc.name; }
      }
      saveState();
      return ok(res, { ok: true });
    }

    // 兑换申请（无论角色均预扣，防止超额申请）
    if (p === '/api/exchange' && method === 'POST') {
      if (state.total < b.cost) return err(res, 400, '积分不足');
      const status = acc.role === 'admin' ? 'approved' : 'pending';
      const ex = { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), ts: fmtCN(), name: b.name, cost: b.cost, applicant: acc.name, status, approver: status === 'approved' ? acc.name : '' };
      state.total -= b.cost; // 预扣
      state.exchanges.unshift(ex);
      saveState();
      return ok(res, { ok: true, status: ex.status });
    }

    // 审批兑换（提交时已预扣；批准不改 total，驳回加回）
    if (p === '/api/exchangeConfirm' && method === 'POST') {
      if (acc.role !== 'admin') return err(res, 403, '仅管理员可审批');
      const ex = state.exchanges.find(x => x.id === b.recId);
      if (!ex) return err(res, 404, '兑换记录不存在');
      if (b.approve) {
        if (ex.status !== 'approved') {
          // 提交时已预扣，批准仅改状态
          ex.status = 'approved'; ex.approver = acc.name;
        }
      } else {
        if (ex.status !== 'rejected') {
          ex.status = 'rejected'; ex.approver = acc.name;
          state.total += ex.cost; // 驳回加回积分
        }
      }
      saveState();
      return ok(res, { ok: true });
    }

    // 扣分（管理员即时扣分；长辈提交需 admin 双签确认）
    if (p === '/api/deduct' && method === 'POST') {
      if (acc.role === 'kid') return err(res, 403, '仅家长可登记扣分');
      const d = RULES.deduct.find(x => x.name === b.name);
      if (!d) return err(res, 400, '扣分项不存在');
      if (!b.reason || !b.reason.trim()) return err(res, 400, '扣分必须填写原因');
      const isAdmin = acc.role === 'admin';
      const rec = {
        id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        ts: fmtCN(),
        dim: '扣分', item: d.name, score: d.score, qty: 1,
        type: 'sub', reason: b.reason.trim(), operator: acc.name,
        status: isAdmin ? 'confirmed' : 'pending', approver: isAdmin ? acc.name : '',
      };
      state.records.unshift(rec);
      if (isAdmin) state.total += d.score;
      saveState();
      return ok(res, { ok: true, status: rec.status });
    }

    // 带娃备注（仅信息记录，不再限制操作；限制由按账号授权实现）
    if (p === '/api/carer' && method === 'POST') {
      if (acc.role !== 'admin') return err(res, 403, '仅管理员可设置');
      if (!['爸妈', '外公外婆', '爷爷奶奶'].includes(b.carer)) return err(res, 400, '无效的带娃人');
      state.carer = b.carer;
      saveState();
      return ok(res, { ok: true });
    }

    // 账号权限管理（管理员）：直接加分维度 / 是否可申报 / 改密码
    if (p === '/api/account' && method === 'POST') {
      if (acc.role !== 'admin') return err(res, 403, '仅管理员可管理');
      const t = accounts.find(x => x.id === b.id);
      if (!t) return err(res, 404, '账号不存在');
      if (b.directDims !== undefined) t.directDims = b.directDims;
      if (b.canDeclare !== undefined) t.canDeclare = !!b.canDeclare;
      if (b.pin !== undefined) t.pin = String(b.pin);
      saveAccounts();
      return ok(res, { ok: true, accounts: accounts.map(a => ({ id: a.id, name: a.name, role: a.role, directDims: a.directDims || [], canDeclare: !!a.canDeclare })) });
    }

    // 修改自己的密码（任何已登录账号，需验证原密码）
    if (p === '/api/mypin' && method === 'POST') {
      const t = accounts.find(x => x.id === acc.id);
      if (!t) return err(res, 404, '账号不存在');
      if (String(b.oldPin || '') !== String(t.pin)) return err(res, 400, '当前密码不正确');
      const np = String(b.newPin || '');
      if (!/^\d{4,}$/.test(np)) return err(res, 400, '新密码需为至少 4 位数字');
      if (np === String(t.pin)) return err(res, 400, '新密码不能与当前密码相同');
      t.pin = np;
      saveAccounts();
      return ok(res, { ok: true });
    }

    // 数据备份：导出（仅管理员）—— 含账号(密码)、规则、审计，便于完整恢复
    if (p === '/api/export' && method === 'GET') {
      if (acc.role !== 'admin') return err(res, 403, '仅管理员可导出数据');
      return ok(res, { ok: true, exportedAt: fmtCN(), state, accounts, rules: RULES, audit });
    }

    // 数据备份：导入恢复（仅管理员）—— 合并而非覆盖：密码以备份为准恢复，积分记录按 id 去重合并
    if (p === '/api/import' && method === 'POST') {
      if (acc.role !== 'admin') return err(res, 403, '仅管理员可导入数据');
      const s = b.state;
      if (!s || typeof s !== 'object' || typeof s.total !== 'number' || !s.points || !Array.isArray(s.records))
        return err(res, 400, '备份文件格式不正确，请选择本系统导出的备份文件');
      // 1) 账号密码以备份为准恢复（解决"导入不能恢复修改后的密码"）
      if (Array.isArray(b.accounts)) {
        for (const ba of b.accounts) {
          const t = accounts.find(x => x.id === ba.id);
          if (t) { t.pin = String(ba.pin); if (ba.directDims) t.directDims = ba.directDims; if (typeof ba.canDeclare === 'boolean') t.canDeclare = ba.canDeclare; }
        }
        saveAccounts();
      }
      // 2) 积分记录按 id 去重合并（保留当前历史 + 补入备份中新增的记录）
      const existing = new Set(state.records.map(r => r.id));
      let added = 0;
      for (const r of s.records) if (!existing.has(r.id)) { state.records.unshift(r); added++; }
      // 3) 以确认记录重算各维度与总分（避免重复累加）
      const pts = {}; RULES.dim.forEach(d => pts[d.key] = 0); let total = 0;
      for (const r of state.records) {
        if (r.status === 'rejected' || r.void) continue;
        const t = r.type || 'add'; // 旧/手动备份缺 type 时按加分兜底
        if (t === 'add' && r.status === 'confirmed') { pts[r.dim] = (pts[r.dim] || 0) + r.score; total += r.score; }
        else if (t === 'sub' && r.status === 'confirmed') { total += r.score; }
      }
      state.points = pts; state.total = total;
      if (!Array.isArray(state.reminders)) state.reminders = [];
      if (!Array.isArray(state.exchanges)) state.exchanges = [];
      if (!state.carer) state.carer = '爸妈';
      saveState();
      return ok(res, { ok: true, total: state.total, records: state.records.length, added });
    }

    return err(res, 404, '接口不存在');
  });
});

server.listen(PORT, () => console.log(`椰子小超人银行已启动： http://localhost:${PORT}`));
