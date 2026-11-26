#!/usr/bin/env python3
"""Render clean, open-source engineering diagrams for README and doc/ using headless Chromium."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

BASE_CSS = """
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: #FFFFFF;
    color: #0F172A;
    font-family: "WenQuanYi Zen Hei", "Droid Sans Fallback", "DejaVu Sans", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  svg { flex-shrink: 0; }
  .mono {
    font-family: "Noto Sans Mono", "DejaVu Sans Mono", monospace;
    font-size: 11.5px;
  }
  .sheet {
    position: relative;
    width: 1400px;
    padding: 32px 36px 28px;
    background: #FFFFFF;
    border: 1px solid #E2E8F0;
  }
  .header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    padding-bottom: 16px;
    margin-bottom: 22px;
    border-bottom: 1px solid #E2E8F0;
  }
  .header-left {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .num-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px 10px;
    border-radius: 6px;
    background: #F1F5F9;
    border: 1px solid #CBD5E1;
    color: #0F172A;
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 0.04em;
  }
  h1 {
    font-size: 23px;
    font-weight: 700;
    color: #0F172A;
    letter-spacing: -0.01em;
  }
  .subtitle {
    font-size: 13.5px;
    color: #475569;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
    padding-top: 6px;
    font-size: 12.5px;
    color: #475569;
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  .lg-line {
    width: 24px;
    height: 0;
    border-top: 2px solid #475569;
  }
  .lg-line.blue { border-color: #2563EB; }
  .lg-line.teal { border-color: #0D9488; }
  .lg-line.dashed { border-top-style: dashed; border-color: #64748B; }
  .lg-dot {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    border: 1px solid currentColor;
  }
  .zone {
    position: relative;
    z-index: 1;
    background: #F8FAFC;
    border: 1px solid #CBD5E1;
    border-radius: 10px;
    padding: 15px 16px;
  }
  .zone.white { background: #FFFFFF; }
  .zone.teal-soft { background: #F0FDFA; border-color: #99F6E4; }
  .zone.blue-soft { background: #EFF6FF; border-color: #BFDBFE; }
  .zone.indigo-soft { background: #EEF2FF; border-color: #C7D2FE; }
  .zone.amber-soft { background: #FFFBEB; border-color: #FDE68A; }
  .zone.green-soft { background: #ECFDF5; border-color: #A7F3D0; }
  .zone.slate-grid {
    background-color: #FAFBFD;
    background-image: radial-gradient(#CBD5E1 1px, transparent 1px);
    background-size: 18px 18px;
  }
  .zone-title {
    font-size: 13px;
    font-weight: 700;
    color: #334155;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .card {
    position: relative;
    z-index: 2;
    background: #FFFFFF;
    border: 1px solid #CBD5E1;
    border-radius: 8px;
    padding: 11px 13px;
  }
  .card.accent-blue { border-left: 3px solid #2563EB; }
  .card.accent-teal { border-left: 3px solid #0D9488; }
  .card.accent-indigo { border-left: 3px solid #4F46E5; }
  .card.accent-amber { border-left: 3px solid #D97706; }
  .card.accent-green { border-left: 3px solid #059669; }
  .card.accent-violet { border-left: 3px solid #7C3AED; }
  .card.dashed { border-style: dashed; background: #F8FAFC; }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }
  .card-title {
    font-size: 14px;
    font-weight: 700;
    color: #0F172A;
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .card-desc {
    font-size: 12.5px;
    line-height: 1.55;
    color: #475569;
  }
  .pill-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 5px;
    font-size: 11.5px;
    line-height: 1.4;
    background: #F1F5F9;
    border: 1px solid #E2E8F0;
    color: #1E293B;
  }
  .pill.teal { background: #CCFBF1; border-color: #99F6E4; color: #115E59; }
  .pill.blue { background: #DBEAFE; border-color: #BFDBFE; color: #1E40AF; }
  .pill.indigo { background: #E0E7FF; border-color: #C7D2FE; color: #3730A3; }
  .pill.amber { background: #FEF3C7; border-color: #FDE68A; color: #92400E; }
  .pill.green { background: #D1FAE5; border-color: #A7F3D0; color: #065F46; }
  .pill.violet { background: #EDE9FE; border-color: #DDD6FE; color: #5B21B6; }
  .tag {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 4px;
    border: 1px solid #CBD5E1;
    background: #F8FAFC;
    color: #334155;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .tag.blue { background: #EFF6FF; border-color: #93C5FD; color: #1D4ED8; }
  .tag.teal { background: #F0FDFA; border-color: #5EEAD4; color: #0F766E; }
  .tag.indigo { background: #EEF2FF; border-color: #A5B4FC; color: #4338CA; }
  .tag.amber { background: #FFFBEB; border-color: #FCD34D; color: #B45309; }
  .tag.green { background: #ECFDF5; border-color: #6EE7B7; color: #047857; }
  .tag.violet { background: #F5F3FF; border-color: #C4B5FD; color: #6D28D9; }
  .footer-bar {
    position: relative;
    z-index: 2;
    margin-top: 18px;
    padding: 10px 16px;
    border-radius: 8px;
    background: #F8FAFC;
    border: 1px solid #E2E8F0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    color: #475569;
  }
  svg.wires {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 20;
    pointer-events: none;
    overflow: visible;
  }
  .wire-label {
    position: absolute;
    z-index: 25;
    background: #FFFFFF;
    border: 1px solid #E2E8F0;
    border-radius: 4px;
    padding: 1px 7px;
    font-size: 11px;
    font-weight: 700;
    color: #334155;
    transform: translate(-50%, -50%);
    white-space: nowrap;
    pointer-events: none;
  }
"""

ICON_TERMINAL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
ICON_LAYERS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>'
ICON_GIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>'
ICON_SHIELD = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
ICON_MSG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
ICON_SERVER = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>'

WIRE_JS = """
<script>
window.addEventListener('DOMContentLoaded', () => {
  const sheet = document.querySelector('.sheet');
  const svg = document.querySelector('svg.wires');
  if (!sheet || !svg) return;
  const sRect = sheet.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${sRect.width} ${sRect.height}`);

  function box(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const l = r.left - sRect.left;
    const t = r.top - sRect.top;
    return {
      l, r: r.right - sRect.left,
      t, b: r.bottom - sRect.top,
      w: r.width, h: r.height,
      cx: l + r.width / 2,
      cy: t + r.height / 2,
    };
  }

  for (const conn of window.CONNECTIONS || []) {
    const a = box(conn.from), b = box(conn.to);
    if (!a || !b) continue;
    let d = '';
    let lx = 0, ly = 0;
    const mode = conn.mode || 'lr';
    if (mode === 'lr') {
      const x1 = a.r;
      const y1 = conn.y1Frac !== undefined ? a.t + a.h * conn.y1Frac : (conn.y1 ?? a.cy);
      const x2 = b.l - 4;
      const y2 = conn.y2Frac !== undefined ? b.t + b.h * conn.y2Frac : (conn.y2 ?? b.cy);
      const mx = conn.mx ?? (x1 + (x2 - x1) * 0.5);
      d = `M ${x1} ${y1} H ${mx} V ${y2} H ${x2}`;
      lx = mx; ly = (y1 + y2) / 2;
    } else if (mode === 'tb') {
      const x1 = conn.x1Frac !== undefined ? a.l + a.w * conn.x1Frac : (conn.x1 ?? a.cx);
      const y1 = a.b;
      const x2 = conn.x2Frac !== undefined ? b.l + b.w * conn.x2Frac : (conn.x2 ?? b.cx);
      const y2 = b.t - 4;
      const my = conn.my ?? (y1 + (y2 - y1) * 0.5);
      d = Math.abs(x1 - x2) < 1 ? `M ${x1} ${y1} V ${y2}` : `M ${x1} ${y1} V ${my} H ${x2} V ${y2}`;
      lx = (x1 + x2) / 2; ly = my;
    } else if (mode === 'bt') {
      const x1 = conn.x1Frac !== undefined ? a.l + a.w * conn.x1Frac : (conn.x1 ?? a.cx);
      const y1 = a.t;
      const x2 = conn.x2Frac !== undefined ? b.l + b.w * conn.x2Frac : (conn.x2 ?? b.cx);
      const y2 = b.b + 4;
      const my = conn.my ?? (y1 - (y1 - y2) * 0.5);
      d = Math.abs(x1 - x2) < 1 ? `M ${x1} ${y1} V ${y2}` : `M ${x1} ${y1} V ${my} H ${x2} V ${y2}`;
      lx = (x1 + x2) / 2; ly = my;
    }
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', conn.color || '#475569');
    p.setAttribute('stroke-width', conn.width || '1.8');
    if (conn.dash) p.setAttribute('stroke-dasharray', '5 4');
    p.setAttribute('marker-end', `url(#${conn.marker || 'arr-slate'})`);
    svg.appendChild(p);
    if (conn.label) {
      const lbl = document.createElement('div');
      lbl.className = 'wire-label';
      lbl.textContent = conn.label;
      lbl.style.left = `${conn.lx ?? lx}px`;
      lbl.style.top = `${conn.ly ?? ly}px`;
      sheet.appendChild(lbl);
    }
  }
});
</script>
"""

SVG_DEFS = """
<svg class="wires">
  <defs>
    <marker id="arr-slate" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M 0 1 L 7 4 L 0 7 z" fill="#475569"/>
    </marker>
    <marker id="arr-blue" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M 0 1 L 7 4 L 0 7 z" fill="#2563EB"/>
    </marker>
    <marker id="arr-teal" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M 0 1 L 7 4 L 0 7 z" fill="#0D9488"/>
    </marker>
    <marker id="arr-indigo" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M 0 1 L 7 4 L 0 7 z" fill="#4F46E5"/>
    </marker>
    <marker id="arr-amber" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M 0 1 L 7 4 L 0 7 z" fill="#D97706"/>
    </marker>
  </defs>
</svg>
"""


def wrap_html(title: str, extra_css: str, body: str, connections_js: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>{title}</title>
<style>{BASE_CSS}\n{extra_css}</style>
</head>
<body>
<div class="sheet">
  {SVG_DEFS}
  {body}
</div>
<script>window.CONNECTIONS = {connections_js};</script>
{WIRE_JS}
</body>
</html>"""


def doc_architecture_overview() -> str:
    extra = """
      .cols { display: grid; grid-template-columns: 290px 310px 1fr; gap: 68px; align-items: stretch; }
      .col-stack { display: flex; flex-direction: column; gap: 14px; justify-content: space-between; }
      .mode-box { display: flex; flex-direction: column; gap: 10px; }
      .sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    """
    body = f"""
      <div class="header">
        <div class="header-left">
          <div class="title-row">
            <span class="num-badge">01</span>
            <h1>Pi Research Harness 总体架构与双模式协同</h1>
          </div>
          <div class="subtitle">单会话内快速派发 Subagents · 项目工作台参考 Claude Code Agent Teams 编排 Multi-Agents</div>
        </div>
        <div class="legend">
          <span class="legend-item"><span class="lg-line blue"></span>安装与调度流</span>
          <span class="legend-item"><span class="lg-line teal"></span>会话内子代理流</span>
          <span class="legend-item"><span class="lg-line dashed"></span>状态同步与观测</span>
        </div>
      </div>

      <div class="cols">
        <div id="setup-zone" class="zone col-stack">
          <div class="zone-title"><span>① 安装与接入准备</span><span class="tag">5 分钟部署</span></div>
          <div id="setup-entry" class="card">
            <div class="card-head">
              <div class="card-title">{ICON_TERMINAL} 用户或 AI 助手</div>
              <span class="tag blue">人工 / Agent</span>
            </div>
            <div class="card-desc">克隆后按说明人工安装，或让编码 AI 助手按规范自动完成环境检查与配置：</div>
            <div class="pill-row">
              <span class="pill mono">doc/install-for-agents.md</span>
            </div>
          </div>

          <div id="setup-install" class="card">
            <div class="card-head">
              <div class="card-title">一键初始化脚本</div>
              <span class="tag">防覆盖</span>
            </div>
            <div class="card-desc">安装 Pi 1.3.0、应用 25 角色目录补丁并构建 Web 前端：</div>
            <div class="pill-row">
              <span class="pill mono">bash scripts/install.sh</span>
              <span class="pill mono">--dry-run / --host-only</span>
            </div>
          </div>

          <div id="setup-model" class="card">
            <div class="card-head">
              <div class="card-title">模型认证与首轮配置</div>
              <span class="tag amber">使用前核对</span>
            </div>
            <div class="card-desc">配置账号真实可用模型并启用 Subagent 首轮直开：</div>
            <div class="pill-row">
              <span class="pill mono">/login</span>
              <span class="pill mono">models.json</span>
              <span class="pill mono">sync-cliproxy.mjs</span>
              <span class="pill mono">toolActivation: "eager"</span>
            </div>
          </div>
        </div>

        <div id="runtime-hub" class="zone white col-stack" style="border-color:#94A3B8;">
          <div class="zone-title"><span>② 本地核心运行时（回环绑定）</span><span class="tag blue">127.0.0.1</span></div>
          <div id="svc-dashboard" class="card accent-blue">
            <div class="card-head">
              <div class="card-title">{ICON_LAYERS} Web Dashboard</div>
              <span class="tag blue">:8000</span>
            </div>
            <div class="card-desc">终端 1 启动：主工作台、主 Agent Plan 进度条、L0–L4 拓扑画布与「详情与纠偏」弹窗。</div>
            <div class="pill-row"><span class="pill mono">./bin/pi-research-dashboard</span></div>
          </div>

          <div id="svc-sync" class="card accent-blue">
            <div class="card-head">
              <div class="card-title">{ICON_SERVER} 工作台状态同步 Sync</div>
              <span class="tag blue">:18767</span>
            </div>
            <div class="card-desc">终端 2 启动：实时投影独立 Pi 会话、Plan 任务图进度、排队等待原因与用量。</div>
            <div class="pill-row"><span class="pill mono">./bin/pi-research-workbench-sync</span></div>
          </div>

          <div id="svc-host" class="card">
            <div class="card-head">
              <div class="card-title">{ICON_TERMINAL} 独立宿主 &amp; 纯 CLI</div>
              <span class="tag">:18768</span>
            </div>
            <div class="card-desc">无浏览器环境也可通过独立宿主总线运行调度与持久通信：</div>
            <div class="pill-row">
              <span class="pill mono">./bin/pi-research</span>
              <span class="pill mono">pi-research host</span>
            </div>
          </div>
        </div>

        <div class="col-stack">
          <div id="mode-subagents" class="zone teal-soft mode-box">
            <div class="zone-title">
              <span style="color:#0F766E;">③ Subagents · 单会话内子代理（pi-subagents@0.79.2）</span>
              <span class="tag teal">轻量并行帮手</span>
            </div>
            <div class="sub-grid">
              <div class="card accent-teal">
                <div class="card-head">
                  <div class="card-title">首轮直开与目录扩容</div>
                  <span class="tag teal">首轮即用</span>
                </div>
                <div class="card-desc">配置 <span class="mono">eager</span> 后首轮对话直接挂载；常驻目录扩至 <b>25 角色 / 20 KiB</b>，保留 7 通用 + 11 专职角色。</div>
              </div>
              <div class="card accent-teal">
                <div class="card-head">
                  <div class="card-title">三档模型路由与 agy-advisor</div>
                  <span class="tag teal">自动降级</span>
                </div>
                <div class="card-desc">按任务轻重分派 <b>工人 → 指挥 → 智力</b>三档；<span class="mono">agy-advisor</span> 先探索模型再由用户确认执行。</div>
              </div>
            </div>
            <div class="pill-row">
              <span class="pill teal">scout（仅只读）</span>
              <span class="pill teal">worker（隔离修复）</span>
              <span class="pill teal">reviewer（双盲审查）</span>
              <span class="pill teal">evidence-auditor（疑难推理）</span>
              <span class="pill teal">research-* 专职矩阵</span>
            </div>
          </div>

          <div id="mode-multiagents" class="zone indigo-soft mode-box">
            <div class="zone-title">
              <span style="color:#3730A3;">④ Multi-Agents · res-workflow 团队协同（参考 Claude Code Agent Teams）</span>
              <span class="tag indigo">项目级并行团队</span>
            </div>
            <div class="sub-grid">
              <div class="card accent-indigo">
                <div class="card-head">
                  <div class="card-title">{ICON_GIT} 先 Plan 后 Work（1:N）</div>
                  <span class="tag indigo">Task List</span>
                </div>
                <div class="card-desc">主 Agent 提交 <b>1~64 项</b>带依赖 Plan DAG；首次确认一次后，按 <b>4 主并发 × 3 子并发</b>滚动排队补位。</div>
              </div>
              <div class="card accent-amber">
                <div class="card-head">
                  <div class="card-title">{ICON_MSG} 持久兄弟邮箱（策略 A）</div>
                  <span class="tag amber">Mailbox</span>
                </div>
                <div class="card-desc">同 <span class="mono">plan</span> 独立会话经 <span class="mono">research_communication</span> 协同：进行中直达、排队中异步备忘、已结束转父级。</div>
              </div>
            </div>
            <div class="pill-row">
              <span class="pill indigo">主 Agent Plan 完成进度条</span>
              <span class="pill indigo">L0→L1→L2→L3→L4 原地展开（不切屏）</span>
              <span class="pill amber">to: "peers" 广播</span>
              <span class="pill amber">8 条上限 + peerSettled</span>
            </div>
          </div>
        </div>
      </div>

      <div class="footer-bar">
        <span><b>安全与部署底线：</b>全服务默认仅监听 127.0.0.1 · 前端覆盖层 SHA-256 校验 · 不复制个人 auth.json 与密钥</span>
        <span>只读（readOnly）/ 禁委派（noDelegate）/ 禁外发（exportLimited）约束沿派生会话严格继承</span>
      </div>
    """
    conns = """[
      { from: 'setup-entry', to: 'setup-install', mode: 'tb', color: '#475569', marker: 'arr-slate' },
      { from: 'setup-install', to: 'setup-model', mode: 'tb', color: '#475569', marker: 'arr-slate' },
      { from: 'setup-zone', to: 'runtime-hub', mode: 'lr', y1Frac: 0.56, y2Frac: 0.56, color: '#2563EB', marker: 'arr-blue', label: '初始化配置' },
      { from: 'svc-dashboard', to: 'svc-sync', mode: 'tb', color: '#64748B', marker: 'arr-slate', dash: true },
      { from: 'runtime-hub', to: 'mode-subagents', mode: 'lr', y1Frac: 0.28, color: '#0D9488', marker: 'arr-teal', label: '会话内派发' },
      { from: 'runtime-hub', to: 'mode-multiagents', mode: 'lr', y1Frac: 0.72, color: '#4F46E5', marker: 'arr-indigo', label: '立项并协同' }
    ]"""
    return wrap_html("01 系统架构总览", extra, body, conns)


def doc_subagent_routing() -> str:
    extra = """
      .cols { display: grid; grid-template-columns: 310px 1fr 310px; gap: 76px; align-items: stretch; }
      .col-stack { display: flex; flex-direction: column; gap: 18px; justify-content: space-between; }
      .tier-grid { display: flex; flex-direction: column; gap: 14px; justify-content: center; }
      .chain { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: #334155; }
      .step-card { padding: 10px 12px; border: 1px solid #FDE68A; border-radius: 7px; background: #FFFFFF; }
      .step-num { display: inline-flex; width: 20px; height: 20px; align-items: center; justify-content: center; border-radius: 99px; background: #FEF3C7; color: #92400E; font-weight: 700; font-size: 11px; margin-right: 6px; }
      .policy-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
      .policy-item { padding: 6px 9px; border-radius: 6px; font-size: 12px; line-height: 1.45; }
      .policy-item.teal { background: #CCFBF1; border: 1px solid #99F6E4; color: #115E59; }
      .policy-item.blue { background: #DBEAFE; border: 1px solid #BFDBFE; color: #1E40AF; }
    """
    body = f"""
      <div class="header">
        <div class="header-left">
          <div class="title-row">
            <span class="num-badge">02</span>
            <h1>Subagents 动态路由、三档模型顺位与 agy-advisor 门控</h1>
          </div>
          <div class="subtitle">根据工作形态自动决策直接执行或并行子代理，并按 model-policy.json 三档配额自动平替模型</div>
        </div>
        <div class="legend">
          <span class="legend-item"><span class="lg-line teal"></span>并行派发路由</span>
          <span class="legend-item"><span class="lg-line dashed"></span>单点直读旁路 / 确认拦截</span>
        </div>
      </div>

      <div class="cols">
        <div class="col-stack">
          <div id="turn1-card" class="card accent-teal">
            <div class="card-head">
              <div class="card-title">{ICON_TERMINAL} 主会话首轮对话</div>
              <span class="tag teal">eager 首轮可用</span>
            </div>
            <div class="card-desc">在 <span class="mono">extensions/subagent/config.json</span> 开启 <span class="mono">toolActivation: "eager"</span>，首轮即挂载 <span class="mono">subagent</span> 工具，无两段唤醒延迟。</div>
          </div>

          <div id="router-card" class="zone white" style="border-color:#0D9488; padding:14px;">
            <div class="zone-title" style="margin-bottom:6px;">
              <span style="color:#0F766E;">动态委派路由器</span>
              <span class="tag mono">delegation-policy.mjs</span>
            </div>
            <div class="card-desc">依据当前激活工具集自适应切换引导：</div>
            <div class="policy-list">
              <div class="policy-item teal"><b>普通独立会话：</b>优先 7 通用角色 + 按需 agy-advisor</div>
              <div class="policy-item blue"><b>接入 res-workflow：</b>开放全量科研角色，工程检索/日志下放 subagent</div>
            </div>
          </div>

          <div id="bypass-card" class="card dashed">
            <div class="card-head">
              <div class="card-title">单点任务直接执行旁路</div>
              <span class="tag">免派发</span>
            </div>
            <div class="card-desc">单个已知文件读取或极小修改直接执行；连续读/搜达到 <b>6 次</b>时自动注入分派提醒，避免污染主上下文。</div>
          </div>
        </div>

        <div class="zone white tier-grid">
          <div class="zone-title" style="margin-bottom:2px;">
            <span>三档模型调度顺位（父会话动态传入顶层 model 参数）</span>
            <span class="tag mono">model-policy.json</span>
          </div>

          <div id="tier-worker" class="card accent-teal">
            <div class="card-head">
              <div class="card-title">工人档 <span class="mono">worker</span> · 高并发 / 低延迟检索与执行</div>
              <span class="tag teal">首选省额度</span>
            </div>
            <div class="chain">
              <span class="pill teal">1. Flash 模型池（ark-deepseek-v4.1-flash → glm-5.3-flash → qwen3.8-flash 等）</span>
              <span>→</span>
              <span class="pill">2. gpt-6.1-terra</span>
              <span>→</span>
              <span class="pill">3. 兜底 bailian-deepseek-pro-0813</span>
            </div>
            <div class="pill-row">
              <span class="pill"><b>scout</b>（严格只读）</span>
              <span class="pill"><b>worker</b>（隔离修改构建）</span>
              <span class="pill"><b>researcher</b>（外部资料查证）</span>
              <span class="pill"><b>delegate</b>（有界通用委派）</span>
            </div>
          </div>

          <div id="tier-commander" class="card accent-blue">
            <div class="card-head">
              <div class="card-title">指挥档 <span class="mono">commander</span> · 多步规划与双盲审查</div>
              <span class="tag blue">结构把控</span>
            </div>
            <div class="chain">
              <span class="pill blue">1. gpt-6.2-sol(max)</span>
              <span>→</span>
              <span class="pill">2. glm-5.3（bailian / ark）</span>
              <span>→</span>
              <span class="pill">3. kimi-k3.1-pro / k3</span>
              <span>→</span>
              <span class="pill">4. qwen3.8-max</span>
            </div>
            <div class="pill-row">
              <span class="pill"><b>reviewer</b>（diff 审查与合规复核）</span>
              <span class="pill"><b>oracle</b>（计划一致性与架构对照）</span>
            </div>
          </div>

          <div id="tier-intelligence" class="card accent-violet">
            <div class="card-head">
              <div class="card-title">智力档 <span class="mono">intelligence</span> · 疑难根因与顶层理论首解</div>
              <span class="tag violet">按需升级</span>
            </div>
            <div class="chain">
              <span class="pill violet">1. gpt-6.2-astra(high)</span>
              <span>→ 未解决且确需深度推理 →</span>
              <span class="pill violet">2. gpt-6.2-astra(xhigh)</span>
            </div>
            <div class="pill-row">
              <span class="pill"><b>evidence-auditor</b>（疑难证据交叉验证与根因定位）</span>
            </div>
          </div>
        </div>

        <div class="col-stack">
          <div id="agy-gate" class="zone amber-soft" style="display:flex; flex-direction:column; gap:10px;">
            <div class="zone-title" style="margin-bottom:2px; color:#92400E;">
              <span>{ICON_SHIELD} agy-advisor 外部 CLI 安全门控</span>
              <span class="tag amber">高阶底座</span>
            </div>
            <div class="step-card">
              <div style="font-weight:700; font-size:13px; margin-bottom:4px;"><span class="step-num">1</span>只读探测在线资源</div>
              <div class="card-desc">执行 <span class="mono">"$HOME/.local/bin/agy" models</span> 与 <span class="mono">--help</span>，读取实时模型列表及推理档位。</div>
            </div>
            <div class="step-card">
              <div style="font-weight:700; font-size:13px; margin-bottom:4px;"><span class="step-num">2</span>弹窗请用户最终拍板</div>
              <div class="card-desc">经 <span class="mono">contact_supervisor</span> → 父会话 <span class="mono">ask_user</span> 确认模型、档位、外发范围与用途，<b>未确认绝不外发</b>。</div>
            </div>
            <div class="step-card">
              <div style="font-weight:700; font-size:13px; margin-bottom:4px;"><span class="step-num">3</span>隔离工作目录执行</div>
              <div class="card-desc">在受控 <span class="mono">AGY_WORKDIR</span> 内调用 <span class="mono">agy-subagent</span>；外部返回只作意见，不扩权限。</div>
            </div>
          </div>

          <div class="card">
            <div class="card-head">
              <div class="card-title">{ICON_SHIELD} 全局安全护栏与并发上限</div>
            </div>
            <div class="card-desc">对话声明「只读 / 禁委派 / 禁外发」后实时锁定；默认单会话并发 <b>3</b>、最大嵌套 <b>2</b> 层；6 个外部 CLI 默认不自动广播。</div>
          </div>
        </div>
      </div>

      <div class="footer-bar">
        <span><b>标准调用约束：</b>参数须顶层显式传入 <span class="mono">agent / task / model</span>，控制项置于 <span class="mono">options</span>，建议默认启用 <span class="mono">async: true</span></span>
        <span>配置路径：config/settings.example.json · agents/*.md · extensions/research-loop/model-policy.json</span>
      </div>
    """
    conns = """[
      { from: 'turn1-card', to: 'router-card', mode: 'tb', color: '#0D9488', marker: 'arr-teal' },
      { from: 'router-card', to: 'bypass-card', mode: 'tb', color: '#64748B', marker: 'arr-slate', dash: true, label: '单点 / 旁路' },
      { from: 'router-card', to: 'tier-worker', mode: 'lr', y1Frac: 0.30, color: '#0D9488', marker: 'arr-teal', label: '常规工程检索' },
      { from: 'router-card', to: 'tier-commander', mode: 'lr', y1Frac: 0.55, color: '#2563EB', marker: 'arr-blue', label: '审校与规划' },
      { from: 'router-card', to: 'tier-intelligence', mode: 'lr', y1Frac: 0.80, color: '#4F46E5', marker: 'arr-indigo', label: '疑难与首解' },
      { from: 'tier-intelligence', to: 'agy-gate', mode: 'lr', color: '#D97706', marker: 'arr-amber', dash: true, label: '外部模型' }
    ]"""
    return wrap_html("02 Subagents 路由与模型调度", extra, body, conns)


def doc_multiagent_topology() -> str:
    extra = """
      .inspire-bar {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
        margin-bottom: 18px;
      }
      .inspire-card {
        background: #F8FAFC;
        border: 1px solid #CBD5E1;
        border-radius: 8px;
        padding: 10px 12px;
      }
      .inspire-top { font-size: 11.5px; color: #64748B; margin-bottom: 4px; font-weight: 700; }
      .inspire-bot { font-size: 13px; color: #0F172A; font-weight: 700; }
      .split { display: grid; grid-template-columns: 760px 1fr; gap: 24px; align-items: stretch; }
      .ribbon {
        position: relative;
        z-index: 2;
        background: #FFFFFF;
        border: 1px solid #CBD5E1;
        border-radius: 8px;
        padding: 10px 14px;
        margin-bottom: 14px;
      }
      .ribbon-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12.5px; }
      .prog-track {
        height: 8px;
        border-radius: 99px;
        background: #E2E8F0;
        overflow: hidden;
        display: flex;
        margin: 8px 0;
      }
      .tree-canvas {
        display: flex;
        flex-direction: column;
        gap: 24px;
        padding: 8px 6px 4px;
      }
      .l2-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
      }
      .l3-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .center-box { margin: 0 auto; width: 430px; }
      .peer-stack { display: flex; flex-direction: column; gap: 12px; }
      .guard-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 2px; }
      .guard-card { background: #FFFFFF; border: 1px solid #CBD5E1; border-radius: 7px; padding: 9px 10px; }
    """
    body = f"""
      <div class="header">
        <div class="header-left">
          <div class="title-row">
            <span class="num-badge">03</span>
            <h1>Multi-Agents（res-workflow）团队协同：借鉴 Claude Code Agent Teams 与工程升级</h1>
          </div>
          <div class="subtitle">结合「先 Plan 后 Work」、Web 同图四层内联拓扑，以及同 Plan 兄弟三态通信（Policy A）与持久排队机制</div>
        </div>
        <div class="legend">
          <span class="legend-item"><span class="lg-dot" style="background:#DBEAFE;border-color:#2563EB;"></span>进行中</span>
          <span class="legend-item"><span class="lg-dot" style="background:#FEF3C7;border-color:#D97706;"></span>排队中</span>
          <span class="legend-item"><span class="lg-dot" style="background:#D1FAE5;border-color:#059669;"></span>已结束</span>
        </div>
      </div>

      <div class="inspire-bar">
        <div class="inspire-card">
          <div class="inspire-top">Claude Code · Team Lead + Teammates</div>
          <div class="inspire-bot">→ 主 Agent + 独立顶级 Pi 会话</div>
        </div>
        <div class="inspire-card">
          <div class="inspire-top">Claude Code · Shared Task List</div>
          <div class="inspire-bot">→ 先 Plan 后 Work + 1:N 依赖队列</div>
        </div>
        <div class="inspire-card">
          <div class="inspire-top">Claude Code · Teammate Mailbox</div>
          <div class="inspire-bot">→ 同 Plan 兄弟三态信箱（策略 A）</div>
        </div>
        <div class="inspire-card">
          <div class="inspire-top">Web 工作台可视化增强</div>
          <div class="inspire-bot">→ 主进度条 + L0–L4 原地展开拓扑</div>
        </div>
      </div>

      <div class="split">
        <div class="zone slate-grid">
          <div class="zone-title">
            <span>{ICON_LAYERS} 前端视图：Plan 完成进度条与四层同图内联拓扑（不切换界面）</span>
            <span class="tag blue">1 个 Plan ↔ N 个 Multi-Agent</span>
          </div>

          <div class="ribbon">
            <div class="ribbon-row">
              <span><span class="pill">先 Plan 后 Work</span> <b>主 Agent Plan 进度：1/2 Plan 已结束 · 2/4 任务 (50%)</b></span>
              <span style="display:flex; gap:6px;">
                <span class="pill blue">进行中 1</span>
                <span class="pill amber">排队中 1</span>
                <span class="pill green">已结束 2</span>
              </span>
            </div>
            <div class="prog-track">
              <div style="width:50%; background:#059669;"></div>
              <div style="width:25%; background:#2563EB;"></div>
              <div style="width:25%; background:#D97706;"></div>
            </div>
            <div class="ribbon-row" style="font-size:11.5px; color:#64748B;">
              <span>顶部支持实时调整并发：默认 <b>Multi-Agent 4 · Subagent 3</b>，超额自动入队补位</span>
              <span>工具栏：过滤 / 隐藏已结束 / Esc 收起</span>
            </div>
          </div>

          <div class="tree-canvas">
            <div id="node-l0" class="card accent-indigo center-box" style="padding:10px 14px;">
              <div class="card-head" style="margin-bottom:3px;">
                <div class="card-title">L0 主 Agent（对标 Team Lead）</div>
                <span class="tag indigo">主会话控制中枢</span>
              </div>
              <div class="card-desc">提交初始分工 Plan，当前目标弹窗确认一次后，同目标补位与分支自拆免重复弹窗。</div>
            </div>

            <div id="node-l1" class="card accent-blue center-box" style="padding:10px 14px;">
              <div class="card-head" style="margin-bottom:3px;">
                <div class="card-title">L1 Plan 节点 · exp-ablation-v1</div>
                <span class="tag blue">1:3 Multi-Agent · 点击原地展开 ⌄</span>
              </div>
              <div class="card-desc">声明 1~64 项任务与 <span class="mono">dependsOn</span> 依赖图；支持同时并行或接续多个 Plan。</div>
            </div>

            <div class="l2-grid">
              <div id="node-l2-run" class="card accent-blue" style="padding:10px 12px;">
                <div class="card-head">
                  <div class="card-title" style="font-size:13.5px;">L2 · 数值实验</div>
                  <span class="tag blue">进行中</span>
                </div>
                <div class="card-desc">独立 Pi 会话 · 依赖已满足，持续产出实验证据。</div>
                <div class="pill-row"><span class="pill blue">Subagent ×2 ⌄</span><span class="pill">详情与纠偏</span></div>
              </div>

              <div id="node-l2-queue" class="card accent-amber" style="padding:10px 12px;">
                <div class="card-head">
                  <div class="card-title" style="font-size:13.5px;">L2 · 交叉复核</div>
                  <span class="tag amber">排队中</span>
                </div>
                <div class="card-desc">等待原因：<b>依赖前置任务</b>或<b>并发槽位已满</b>，前置就绪自动补位。</div>
                <div class="pill-row"><span class="pill amber">仅可留异步备忘</span></div>
              </div>

              <div id="node-l2-end" class="card accent-green" style="padding:10px 12px;">
                <div class="card-head">
                  <div class="card-title" style="font-size:13.5px;">L2 · 文献基线</div>
                  <span class="tag green">已结束</span>
                </div>
                <div class="card-desc">已提交正式 <span class="mono">report</span> 与相对证据路径至父会话。</div>
                <div class="pill-row"><span class="pill green">已交卷</span><span class="pill">详情与纠偏</span></div>
              </div>
            </div>

            <div id="node-l3" class="card accent-teal" style="padding:10px 12px; width: 490px;">
              <div class="card-head" style="margin-bottom:6px;">
                <div class="card-title" style="font-size:13.5px;">L3 Subagent 角色组 → L4 多次执行记录（画布内原地展开）</div>
                <span class="tag teal">同图展开</span>
              </div>
              <div class="l3-row">
                <div class="pill teal" style="justify-content:space-between; width:100%;"><span>scout（只读检索）</span><span>2 次运行</span></div>
                <div class="pill" style="justify-content:space-between; width:100%;"><span>worker（脚本修复）</span><span>1 次运行</span></div>
              </div>
            </div>
          </div>
        </div>

        <div class="zone white peer-stack">
          <div class="zone-title" style="margin-bottom:2px;">
            <span>{ICON_MSG} 同 Plan 横向兄弟通信（<span class="mono">research_communication</span>）</span>
            <span class="tag indigo">策略 A 三态</span>
          </div>

          <div class="card dashed" style="padding:10px 12px;">
            <div class="card-desc">
              <b>队友发现与同队边界：</b>调用 <span class="mono">research_dispatch(status)</span> 获取同 <span class="mono">plan</span> 有界花名册 <span class="mono">peers</span>（≤32 项）；必须同时满足 <b>同 Plan + 同直接父会话 + 同届次 + 同已验证工作台作用域</b>。
            </div>
          </div>

          <div class="card accent-blue">
            <div class="card-head">
              <div class="card-title">状态 1：进行中 <span class="mono">in_progress</span></div>
              <span class="tag blue">即时互通</span>
            </div>
            <div class="card-desc">可通过 <span class="mono">sessionId</span> 或 <span class="mono">taskId</span> 发送 <span class="mono">progress / decision / request</span> 并执行 <span class="mono">reply</span>；请求与决策会即时唤醒对方，仅 <span class="mono">ack</span> 不会结案询问。</div>
          </div>

          <div class="card accent-amber">
            <div class="card-head">
              <div class="card-title">状态 2：排队中 <span class="mono">queued</span></div>
              <span class="tag amber">异步备忘 · 不插队</span>
            </div>
            <div class="card-desc">仅允许按 <span class="mono">taskId</span> 发送 <span class="mono">progress / decision</span> 记为<b>延迟异步备忘</b>，等待该任务按序启动时带入初始上下文，<b>绝不唤醒或变更队列</b>；发 <span class="mono">request</span> 直接拒绝（<span class="mono">409 peer-queued</span>）。</div>
          </div>

          <div class="card accent-green">
            <div class="card-head">
              <div class="card-title">状态 3：已结束 <span class="mono">ended</span></div>
              <span class="tag green">只读封存</span>
            </div>
            <div class="card-desc">拒绝继续发送（<span class="mono">409 peer-ended</span>），广播自动跳过；若问题仍未解决，协作者须携带新 <span class="mono">requestId</span> 上报父会话 <span class="mono">parent</span> 裁决。</div>
          </div>

          <div class="guard-grid">
            <div class="guard-card">
              <div style="font-size:12px; font-weight:700; color:#0F172A; margin-bottom:3px;">团队广播 <span class="mono">to: "peers"</span></div>
              <div style="font-size:11.5px; color:#475569;">仅发进展/决策，跳过已结束节点。</div>
            </div>
            <div class="guard-card">
              <div style="font-size:12px; font-weight:700; color:#0F172A; margin-bottom:3px;">防死循环配额上限</div>
              <div style="font-size:11.5px; color:#475569;">同对队友单 Plan 最多 <b>8 条（4 轮）</b>直聊。</div>
            </div>
            <div class="guard-card">
              <div style="font-size:12px; font-weight:700; color:#0F172A; margin-bottom:3px;"><span class="mono">peerSettled</span> 保护</div>
              <div style="font-size:11.5px; color:#475569;">一方先退出即结案询问，不阻塞回收。</div>
            </div>
          </div>
        </div>
      </div>

      <div class="footer-bar">
        <span><b>权限与交付原则：</b>兄弟消息绝不扩大任务范围或豁免只读/禁外发；正式阶段/终态交付 <span class="mono">report</span> 永远仅上报给直属父会话 <span class="mono">parent</span></span>
        <span>对应文档：doc/multi-agents.md · extensions/research-host/services/</span>
      </div>
    """
    conns = """[
      { from: 'node-l0', to: 'node-l1', mode: 'tb', color: '#4F46E5', marker: 'arr-indigo' },
      { from: 'node-l1', to: 'node-l2-run', mode: 'tb', x1Frac: 0.25, color: '#2563EB', marker: 'arr-blue' },
      { from: 'node-l1', to: 'node-l2-queue', mode: 'tb', x1Frac: 0.50, color: '#D97706', marker: 'arr-amber' },
      { from: 'node-l1', to: 'node-l2-end', mode: 'tb', x1Frac: 0.75, color: '#059669', marker: 'arr-slate' },
      { from: 'node-l2-run', to: 'node-l3', mode: 'tb', x2Frac: 0.22, color: '#0D9488', marker: 'arr-teal' }
    ]"""
    return wrap_html("03 Multi-Agents 协同与三态通信", extra, body, conns)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "doc" / "images")
    args = parser.parse_args()
    out = args.output_dir
    out.mkdir(parents=True, exist_ok=True)
    specs = [
        ("architecture-overview.png", doc_architecture_overview()),
        ("subagent-routing-tiers.png", doc_subagent_routing()),
        ("multiagent-plan-topology.png", doc_multiagent_topology()),
    ]
    chrome_bin = shutil.which("google-chrome") or shutil.which("chromium")
    launch_kwargs = {"headless": True}
    if chrome_bin:
        launch_kwargs["executable_path"] = chrome_bin

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_kwargs)
        page = browser.new_page(viewport={"width": 1440, "height": 1200}, device_scale_factor=2)
        for filename, html in specs:
            page.set_content(html, wait_until="load")
            page.evaluate("() => document.fonts ? document.fonts.ready : Promise.resolve()")
            sheet = page.locator(".sheet")
            target = out / filename
            sheet.screenshot(path=str(target), type="png")
            print(f"rendered {target} ({target.stat().st_size} bytes)")
        browser.close()


if __name__ == "__main__":
    main()
