/* 赛事默认配置
 *
 * 只在这里维护一份，seed / 迁移 / API 兜底都引用它，
 * 避免前后端各写一份学院列表导致不一致。
 */
'use strict';

const COLLEGES = [
  '数学与计算机科学学院', '物理与信息工程学院', '化学与材料学院',
  '海洋与食品学院', '资源与环境科学学院', '陈守仁商学院',
  '文学与传播学院', '外国语学院', '教育科学学院',
  '音乐与舞蹈学院', '美术与设计学院', '体育学院',
  '应用科技学院（航海学院）', '马克思主义学院'
];

const GROUPS = {
  competition: { key: 'competition', name: '竞赛组', timed: true, size: 1, desc: '单人报名 · 计时排名' },
  experience: { key: 'experience', name: '体验组', timed: false, size: 1, desc: '单人报名 · 不计时' },
  unity: { key: 'unity', name: '同心组', timed: true, size: 2, desc: '两人报名 · 取两人中较慢者成绩' }
};

const STATUS = ['draft', 'reg_open', 'reg_closed', 'running', 'finished', 'archived'];

const STATUS_TEXT = {
  draft: '筹备中',
  reg_open: '报名进行中',
  reg_closed: '报名已截止',
  running: '比赛进行中',
  finished: '赛事已结束',
  archived: '已归档'
};

module.exports = { COLLEGES, GROUPS, STATUS, STATUS_TEXT };
