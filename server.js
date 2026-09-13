/* 家庭成长积分 · 小超人银行 —— 轻量后端
 * 功能：账号登录、积分状态持久化、加减分/审批/兑换/按账号授权/扣分/带娃备注
 * 运行：node server.js   （默认端口 8080，可用 PORT 环境变量覆盖）
 * 数据存于 ./data/ 目录（state.json 积分状态，accounts.json 账号权限）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
const STATE_FILE = path.join(DATA, 'state.json');
const ACCT_FILE = path.join(DATA, 'accounts.json');
const BACKUP_DIR = path.join(DATA, 'backup');
const PORT = process.env.PORT || 8080;

/* ============ 积分规则（单一事实来源，前端也通过 /api/rules 获取） ============ */
const RULES = {
  dim: [
    { key: '学习', name: '📘 学习小达人', color: '#3B82F6', type: '习惯' },
    { key: '运动', name: '🏀 运动小健将', color: '#F97316', type: '习惯' },
    { key: '家务', name: '🧺 家务小帮手', color: '#22C55E', type: '习惯' },
    { key: '自理', name: '⏰ 自理小能手', color: '#EAB308', type: '习惯' },
    { key: '品格', name: '🤝 品格小君子', color: '#A855F7', type: '习惯' },
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
    { name: '打人/说脏话等不文明行为', score: -5 },
    { name: '说谎', score: -5 },
    { name: '危险行为（如马路乱跑）', score: -5 },
    { name: '故意破坏他人/公共物品', score: -3 },
    { name: '未按约定执行（到时未关电视/未回家等）', score: -3 },
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
if (!Array.isArray(state.reminders)) state.reminders = []; // 兼容旧数据
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
const sessions = {}; // token -> accountId

function defaultState() {
  return { points: { 学习: 0, 运动: 0, 家务: 0, 自理: 0, 品格: 0, 勇气: 0 }, total: 0, records: [], exchanges: [], reminders: [], carer: '爸妈' };
}
function loadJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  // 自动备份：每天一份，最多保留最近 7 份（免费服务器重启可能清空数据，备份可作兜底）
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    fs.writeFileSync(path.join(BACKUP_DIR, 'state-' + stamp + '.json'), JSON.stringify(state));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^state-\d{8}\.json$/.test(f)).sort();
    while (files.length > 7) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) { /* 备份失败不影响主流程 */ }
}
function saveAccounts() { fs.writeFileSync(ACCT_FILE, JSON.stringify(accounts, null, 2)); }
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
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function sameDay(a, b) { return startOfDay(a).getTime() === startOfDay(b).getTime(); }
function weekKey(d) { const day = (d.getDay() + 6) % 7; const mon = new Date(d); mon.setDate(d.getDate() - day); return startOfDay(mon).getTime(); }
function samePeriod(ts, now, period) { const r = new Date(ts); if (period === 'day') return sameDay(r, now); if (period === 'week') return weekKey(r) === weekKey(now); return false; }
function usage(itemName, period) {
  const now = new Date();
  return state.records
    .filter(r => r.item === itemName && r.status !== 'rejected' && samePeriod(r.ts, now, period))
    .reduce((s, r) => s + (r.qty || 1), 0);
}
function usageScore(operatorName, period) {
  const now = new Date();
  return state.records
    .filter(r => r.type === 'add' && r.status === 'confirmed' && r.operator === operatorName && r.approver === operatorName && samePeriod(r.ts, now, period))
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

function auth(token) {
  if (!token) return null;
  const id = sessions[token];
  return id ? accounts.find(a => a.id === id) : null;
}

/* ============ 静态文件 ============ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  let f = pathname === '/' ? '/index.html' : pathname;
  const fp = path.join(ROOT, path.normalize(f));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
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

    // 登录
    if (p === '/api/login' && method === 'POST') {
      const a = accounts.find(x => x.name === b.name);
      if (!a || a.pin !== String(b.pin || '')) return err(res, 401, '账号或密码错误');
      const token = crypto.randomBytes(12).toString('hex');
      sessions[token] = a.id;
      return ok(res, { token, name: a.name, role: a.role, id: a.id, directDims: a.directDims || [], canDeclare: !!a.canDeclare });
    }

    const acc = auth(token);
    if (!acc) return err(res, 401, '登录失效，请重新登录');

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
      const direct = acc.role === 'admin' || (acc.role === 'elder' && (acc.directDims || []).includes(item.dim));
      // 外公外婆学习类直接加分：单笔≤3分，日累计≤6分
      if (acc.role === 'elder' && direct) {
        if (totalScore > 3) return err(res, 400, `外公外婆学习类直接加分单笔不超过 3 分，本次为 ${totalScore} 分`);
        const used = usageScore(acc.name, 'day');
        if (used + totalScore > 6) return err(res, 400, `外公外婆学习类直接加分每日累计不超过 6 分，今日已用 ${used} 分`);
      }
      const rec = {
        id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        ts: new Date().toLocaleString('zh-CN'),
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
      return ok(res, { ok: true, status: rec.status });
    }

    // 宝宝提醒：孩子点击「我做到了」生成，大人可见
    if (p === '/api/remind' && method === 'POST') {
      const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      state.reminders.unshift({ id, ts: new Date().toLocaleString('zh-CN'), item: b.item, operator: acc.name, status: 'pending' });
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
      const ex = { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), ts: new Date().toLocaleString('zh-CN'), name: b.name, cost: b.cost, applicant: acc.name, status, approver: status === 'approved' ? acc.name : '' };
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
        ts: new Date().toLocaleString('zh-CN'),
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

    // 数据备份：导出（仅管理员）
    if (p === '/api/export' && method === 'GET') {
      if (acc.role !== 'admin') return err(res, 403, '仅管理员可导出数据');
      return ok(res, { ok: true, exportedAt: new Date().toLocaleString('zh-CN'), state });
    }

    // 数据备份：导入恢复（仅管理员）
    if (p === '/api/import' && method === 'POST') {
      if (acc.role !== 'admin') return err(res, 403, '仅管理员可导入数据');
      const s = b.state;
      if (!s || typeof s !== 'object' || typeof s.total !== 'number' || !s.points || !Array.isArray(s.records))
        return err(res, 400, '备份文件格式不正确，请选择本系统导出的备份文件');
      const prevTotal = state.total;
      state = s;
      RULES.dim.forEach(d => { if (typeof state.points[d.key] !== 'number') state.points[d.key] = 0; });
      if (!Array.isArray(state.reminders)) state.reminders = [];
      if (!Array.isArray(state.exchanges)) state.exchanges = [];
      if (!state.carer) state.carer = '爸妈';
      saveState();
      return ok(res, { ok: true, total: state.total, records: state.records.length, prevTotal });
    }

    return err(res, 404, '接口不存在');
  });
});

server.listen(PORT, () => console.log(`椰子小超人银行已启动： http://localhost:${PORT}`));
