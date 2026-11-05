#!/usr/bin/env python3
"""Render the README's source-grounded workflow diagrams.

The diagrams are documentation of the checked-in implementation, not execution
reports. All geometry, labels and edges are explicit; no model or network call
is involved. See docs/images/workflow-source-map.md for the source of each edge.

Requires Python 3.10+, Matplotlib, Pillow, and a Noto Sans CJK font. Example:
    python scripts/render-readme-diagrams.py
    python scripts/render-readme-diagrams.py --font /path/to/NotoSansCJKsc-Regular.otf
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from io import BytesIO
import os
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch
from matplotlib.path import Path as MplPath
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
WIDTH = 1920
EXPORT_WIDTH = 3840
MAX_BYTES = 5 * 1024 * 1024
COLORS = {
    "background": "#081423",
    "panel": "#102439",
    "panel_alt": "#0C1C2F",
    "line": "#2A4964",
    "cyan": "#6ADBE7",
    "blue": "#89B6FF",
    "gold": "#EAC57C",
    "gold_panel": "#27251F",
    "text": "#F1F7FD",
    "muted": "#BACBDD",
}
matplotlib.rcParams.update({
    "svg.fonttype": "none",  # Keep editable text; the PNG fixes the CJK glyphs.
    "svg.hashsalt": "pi-research-harness-readme-workflow-v1",
    "path.simplify": False,
    "axes.unicode_minus": False,
})


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    w: float
    h: float


class Diagram:
    """A fixed 1920-unit canvas; text sizes are expressed in source pixels."""

    def __init__(self, stem: str, height: int, font: Path, title: str, subtitle: str, number: str):
        self.stem, self.height = stem, height
        self.title, self.subtitle = title, subtitle
        self.font = FontProperties(fname=str(font))
        self.fig = plt.figure(figsize=(WIDTH / 100, height / 100), dpi=100)
        self.fig.patch.set_facecolor(COLORS["background"])
        self.ax = self.fig.add_axes([0, 0, 1, 1])
        self.ax.set(xlim=(0, WIDTH), ylim=(height, 0))
        self.ax.set_axis_off()
        self.bounds: list[tuple[object, Box, str]] = []
        self.rect("figure-number", Box(80, 64, 86, 66), color="cyan", fill="panel")
        self.text(123, 96, number, 34, color="cyan", ha="center", va="center")
        self.text(195, 63, title, 54)
        self.text(80, 153, subtitle, 31, color="muted")

    def rect(self, key: str, b: Box, color: str = "line", fill: str = "panel", dash: bool = False, radius: int = 18):
        patch = FancyBboxPatch(
            (b.x, b.y), b.w, b.h,
            boxstyle=f"round,pad=0,rounding_size={radius}",
            linewidth=2.1 * .72, edgecolor=COLORS[color],
            facecolor=COLORS[fill], linestyle=(0, (7, 5)) if dash else "solid",
            zorder=2,
        )
        patch.set_gid(f"node-{key}")
        self.ax.add_patch(patch)
        return b

    def text(self, x: float, y: float, value: str, size: float = 30, *, color: str = "text", ha: str = "left", va: str = "top", bounds: Box | None = None, bg: bool = False):
        if size < 26:
            raise ValueError("Diagram text must be at least 26 source pixels")
        artist = self.ax.text(
            x, y, value, fontsize=size * .72, fontproperties=self.font,
            color=COLORS[color], ha=ha, va=va, linespacing=1.34,
            bbox={"facecolor": COLORS["background"], "edgecolor": "none", "pad": 4} if bg else None,
            zorder=5,
        )
        self.bounds.append((artist, bounds or Box(28, 25, WIDTH - 56, self.height - 50), value))
        return artist

    def card(self, key: str, box: Box, title: str, lines: list[str], *, accent: str = "cyan", title_size: int = 36, body_size: int = 30, line_gap: int = 43, title_y: int = 25, body_y: int = 83, dash: bool = False):
        self.rect(key, box, color=accent, fill="gold_panel" if accent == "gold" else "panel", dash=dash)
        content = Box(box.x + 24, box.y + 14, box.w - 48, box.h - 25)
        self.text(box.x + 28, box.y + title_y, title, title_size, color=accent, bounds=content)
        for n, line in enumerate(lines):
            self.text(box.x + 28, box.y + body_y + n * line_gap, line, body_size, bounds=content)
        return box

    def arrow(self, key: str, points: list[tuple[float, float]], *, color: str = "cyan", dash: bool = False, width: float = 3, head: bool = True):
        path = MplPath(points, [MplPath.MOVETO] + [MplPath.LINETO] * (len(points) - 1))
        patch = FancyArrowPatch(
            path=path, arrowstyle="-|>" if head else "-",
            mutation_scale=23 * .72, linewidth=width * .72,
            color=COLORS[color], linestyle=(0, (8, 6)) if dash else "solid",
            capstyle="round", joinstyle="round", zorder=3,
        )
        patch.set_gid(f"edge-{key}")
        self.ax.add_patch(patch)

    def footer(self):
        y = self.height - 75
        self.ax.plot([80, 1840], [y - 25, y - 25], color=COLORS["line"], linewidth=1)
        self.text(80, y, "依据源码绘制；不代表真实研究任务已运行", 27, color="muted")
        self.text(1840, y, "源码映射：workflow-source-map.md", 26, color="muted", ha="right")

    def save(self, destination: Path):
        self.footer()
        self.fig.canvas.draw()
        renderer = self.fig.canvas.get_renderer()
        # Check full text extents at the 1920-unit source scale. This catches
        # accidental clipping after a label or font change without exercising
        # research execution, external providers, or the Dashboard runtime.
        for artist, box, label in self.bounds:
            extent = artist.get_window_extent(renderer).transformed(self.ax.transData.inverted())
            x0, x1 = sorted([extent.x0, extent.x1])
            y0, y1 = sorted([extent.y0, extent.y1])
            if x0 < box.x - 1 or x1 > box.x + box.w + 1 or y0 < box.y - 1 or y1 > box.y + box.h + 1:
                raise ValueError(f"Text outside its bounds in {self.stem}: {label!r}")
        destination.mkdir(parents=True, exist_ok=True)
        svg = destination / f"{self.stem}.svg"
        png = destination / f"{self.stem}.png"
        svg_buffer = BytesIO()
        self.fig.savefig(svg_buffer, format="svg", facecolor=COLORS["background"], metadata={
            "Title": self.title,
            "Description": self.subtitle + " 依据源码绘制；不代表真实研究任务已运行。",
            "Creator": "scripts/render-readme-diagrams.py",
            "Date": None,
        })
        buffer = BytesIO()
        self.fig.savefig(buffer, format="png", dpi=200, facecolor=COLORS["background"], metadata={"Software": "pi-research-harness deterministic diagram renderer"})
        buffer.seek(0)
        png_buffer = BytesIO()
        with Image.open(buffer) as image:
            if image.width != EXPORT_WIDTH or image.height != self.height * 2:
                raise ValueError(f"Unexpected PNG dimensions: {png}")
            dimensions = f"{image.width}x{image.height}"
            image.convert("RGB").save(png_buffer, format="PNG", optimize=True)
        plt.close(self.fig)
        # Matplotlib emits spaces before newlines in SVG paths. Normalize them
        # here so every regeneration remains clean under git diff --check.
        svg_text = svg_buffer.getvalue().decode("utf-8")
        svg_data = ("\n".join(line.rstrip() for line in svg_text.splitlines()) + "\n").encode("utf-8")
        outputs = [(svg, svg_data), (png, png_buffer.getvalue())]
        for file, data in outputs:
            if len(data) >= MAX_BYTES:
                raise ValueError(f"Image exceeds the 5 MiB limit: {file}")
        # Readers see either the complete old file or the complete new file.
        for file, data in outputs:
            temporary = file.with_suffix(file.suffix + ".tmp")
            try:
                temporary.write_bytes(data)
                temporary.replace(file)
            finally:
                temporary.unlink(missing_ok=True)
        print(f"{self.stem}: SVG 1920x{self.height}, PNG {dimensions}; "
              f"{svg.stat().st_size:,} / {png.stat().st_size:,} bytes")


def project_structure(font: Path) -> Diagram:
    d = Diagram("project-illustration", 1600, font,
                "项目实际运行结构", "同一工作空间中的执行、显式科研记录与观测回流", "01")
    d.arrow("legend-call", [(82, 216), (155, 216)])
    d.text(173, 199, "调用 / 写入", 28)
    d.arrow("legend-observation", [(510, 216), (583, 216)], color="blue", dash=True)
    d.text(601, 199, "读取 / 观测回流", 28)
    d.arrow("legend-optional", [(1085, 216), (1158, 216)], color="gold", dash=True)
    d.text(1176, 199, "可选入口 / 另行创建", 28)

    d.card("cli", Box(80, 275, 360, 150), "Pi CLI", ["用户任务与约束"], title_size=38, body_y=87)
    d.card("dashboard", Box(520, 275, 1320, 150), "Dashboard · 当前工作空间", ["对话 / 研究工作台 / 智能体 / 文件 / Science"], title_size=38, body_y=87)
    d.card("main-session", Box(520, 490, 800, 170), "Pi 主会话", ["读取项目 · 组织任务 · 承接实际返回", "research_loop：冻结目标与预算"], title_size=42, body_y=83, line_gap=42)
    d.card("science", Box(1400, 490, 440, 230), "Science（可选）", ["独立查看通道", "原生画面 / 状态 / 产物", "不由 Pi 自动派发"], accent="gold", title_size=34, body_y=87, line_gap=42)

    d.arrow("cli-to-main", [(260, 425), (260, 575), (520, 575)])
    d.arrow("chat-to-main", [(920, 425), (920, 490)])
    d.arrow("user-opens-science", [(1620, 425), (1620, 490)], color="gold", dash=True)
    d.arrow("science-view-to-dashboard", [(1760, 490), (1760, 425)], color="blue", dash=True)

    d.card("subordinate", Box(80, 770, 540, 200), "subagent / workflow", ["当前父会话下的执行", "角色任务 · auto-research"], title_size=36, body_y=88)
    d.card("top-level-session", Box(780, 770, 540, 200), "research_session", ["创建独立顶层 Pi 会话", "加入同一已确认工作台"], accent="gold", title_size=36, body_y=88)
    d.arrow("main-delegates", [(620, 660), (620, 710), (350, 710), (350, 770)])
    d.text(350, 684, "委派", 27, ha="center", bg=True)
    d.arrow("main-creates-collaborator", [(1100, 660), (1100, 710), (1050, 710), (1050, 770)], color="gold", dash=True)
    d.text(1050, 684, "需要独立协作者时", 27, ha="center", bg=True)

    d.card("tool-results", Box(80, 1055, 1240, 165), "工具执行与原始结果", ["本地计算 / 文件 / 检索 / 已授权 SSH", "命令 · stdout/stderr · 产物路径 · 实际状态"], title_size=38, body_y=81, line_gap=40)
    d.arrow("subordinate-tools", [(350, 970), (350, 1055)])
    d.arrow("collaborator-tools", [(1050, 970), (1050, 1055)])
    d.arrow("main-direct-tools", [(700, 660), (700, 1055)])
    d.text(700, 850, "直接\n调用", 27, ha="center", bg=True)

    d.card("explicit-record", Box(80, 1300, 580, 155), "主会话显式登记", ["log / claim", "整理可审查的科研记录"], title_size=36, body_y=76, body_size=29, line_gap=37)
    d.card("research-ledger", Box(760, 1300, 560, 155), ".pi/research-loop", ["state.json · ledger.jsonl", "events.jsonl"], title_size=36, body_y=76, body_size=29, line_gap=37)
    d.arrow("return-to-explicit-record", [(700, 1220), (700, 1260), (370, 1260), (370, 1300)])
    d.arrow("write-ledger", [(660, 1378), (760, 1378)])

    d.card("observation-source", Box(1410, 810, 430, 155), "会话 / native status", ["transcript 与执行元数据"], accent="blue", title_size=32, body_y=85, body_size=28)
    d.card("workbench-sync", Box(1410, 1015, 430, 255), "工作台 sync", ["观察已加入会话", "与原生执行记录", "投影状态 / 关系 / 用量", "不替代正式科研账本"], title_size=35, body_y=80, body_size=28, line_gap=39)
    d.arrow("observe-execution-records", [(1625, 965), (1625, 1015)], color="blue", dash=True)
    d.arrow("sync-to-dashboard", [(1840, 1143), (1880, 1143), (1880, 350), (1840, 350)], color="blue", dash=True)
    d.arrow("ledger-read-to-dashboard", [(1320, 1380), (1880, 1380), (1880, 1143)], color="blue", dash=True, head=False)
    d.text(1410, 1406, "工作台读取正式记录", 28, color="blue")
    return d


def auto_research(font: Path) -> Diagram:
    d = Diagram("research-capabilities-dark", 1850, font,
                "auto-research 的实际执行顺序", "自动链路止于 Stage 3；后续总结与写作由主会话另行组织", "02")

    d.card("run-entry", Box(80, 230, 1760, 170), "显式启动 research_loop · action: run", ["入口检查：冻结目标 / 有限预算 / 原生 budget bridge / 内存余量", "需配置角色和模型；当前发布模板缺少 research-explorer / research-strategist"], title_size=38, body_y=81, body_size=30, line_gap=42)
    d.arrow("admitted-run", [(645, 400), (645, 475)])

    d.rect("stage-1", Box(80, 475, 1130, 240), fill="panel_alt")
    d.text(110, 498, "STAGE 1 · 假设与计划", 36, color="cyan")
    d.card("explorers", Box(110, 572, 315, 112), "并行 explorer", ["独立角度 → 假设卡"], title_size=31, body_size=28, title_y=17, body_y=65)
    d.card("screen", Box(470, 572, 280, 112), "critic 筛选", ["新颖性 / 可证伪性"], title_size=31, body_size=26, title_y=17, body_y=65)
    d.card("strategist", Box(820, 572, 360, 112), "strategist 规划", ["选择方向与里程碑"], title_size=31, body_size=28, title_y=17, body_y=65)
    d.arrow("cards-to-screen", [(425, 628), (470, 628)])
    d.arrow("screen-to-plan", [(750, 628), (820, 628)])
    d.card("plan-return", Box(1330, 555, 510, 150), "stopAfter: plan", ["返回 planned"], title_size=34, body_size=34, body_y=84)
    d.arrow("return-plan", [(1180, 628), (1330, 628)])

    d.arrow("plan-to-experiments", [(1000, 684), (1000, 755), (645, 755), (645, 805)])
    d.text(645, 741, "继续执行", 27, ha="center", bg=True)
    d.rect("stage-2", Box(80, 805, 1130, 250), fill="panel_alt")
    d.text(110, 828, "STAGE 2 · 顺序执行里程碑", 36, color="cyan")
    d.card("milestones", Box(110, 900, 1070, 105), "numerics 本地计算  /  已授权 SSH", ["逐项运行 → 保存命令、stdout/stderr 与证据路径"], title_size=32, body_size=29, title_y=15, body_y=62)
    d.text(110, 1017, "milestone 1 → 2 → …；首个 blocked / failed 即停止", 27, color="muted")
    d.card("experiment-return", Box(1330, 875, 510, 170), "stopAfter: experiment", ["返回", "experiments_completed"], title_size=31, body_size=31, body_y=77, line_gap=42)
    d.arrow("return-experiments", [(1180, 952), (1330, 952)])

    d.arrow("experiments-to-review", [(645, 1055), (645, 1135)])
    d.rect("stage-3", Box(80, 1135, 1130, 295), fill="panel_alt")
    d.text(110, 1158, "STAGE 3 · 重复评审，最多 4 轮", 36, color="cyan")
    d.text(110, 1213, "同一批实验结果；循环不自动执行 fixes", 29, color="muted")
    d.card("critic-review", Box(110, 1268, 600, 105), "critic · fresh context", ["评分 / verdict / weaknesses / fixes"], title_size=32, body_size=28, title_y=15, body_y=62)
    d.card("review-memory", Box(850, 1268, 330, 105), "memory", ["传给下一轮"], title_size=32, body_size=28, title_y=15, body_y=62)
    d.arrow("review-to-memory", [(710, 1320), (850, 1320)])
    d.arrow("memory-to-next-round", [(1015, 1373), (1015, 1404), (410, 1404), (410, 1373)])
    d.text(710, 1386, "未收敛且未达轮次上限", 26, ha="center", bg=True)
    d.card("review-return", Box(1330, 1145, 510, 285), "工作流返回", ["score ≥ 6 且 ready / almost", "→ converged", "到上限：max_rounds_reached", "缺少必要结果 → blocked"], title_size=34, body_size=28, body_y=80, line_gap=46)
    d.arrow("return-review", [(1210, 1320), (1330, 1320)])

    d.arrow("main-session-continuation", [(1585, 1430), (1585, 1490), (475, 1490), (475, 1565)], color="gold", dash=True)
    d.text(1020, 1473, "返回主会话后，另行接续", 31, color="gold", ha="center", bg=True)
    d.card("stage-4", Box(80, 1565, 790, 160), "STAGE 4 · 总结交接", ["整理结论、限制与证据索引", "不属于 auto-research 自动产物"], accent="gold", title_size=36, body_size=30, body_y=78, line_gap=40, dash=True)
    d.card("stage-5", Box(1010, 1565, 830, 160), "STAGE 5 · 可选写作", ["论文计划 / LaTeX / 编译与审计", "按任务需要由主会话组织"], accent="gold", title_size=36, body_size=30, body_y=78, line_gap=40, dash=True)
    d.arrow("summary-to-optional-writing", [(870, 1645), (1010, 1645)], color="gold", dash=True)
    return d


def evidence_and_gates(font: Path) -> Diagram:
    d = Diagram("evidence-review-loop", 1930, font,
                "科学记录、评审与授权边界", "运行结果、记录状态、验收字段与用户授权分别保留", "03")

    d.card("raw-evidence", Box(80, 235, 1760, 150), "原始输出与可追溯路径", ["命令 · 配置 · 结果文件 · 退出状态；由主会话检查并组织"], title_size=40, body_size=32, body_y=87)
    d.arrow("explicit-log-and-claim", [(960, 385), (960, 470)])
    d.text(960, 414, "显式登记", 28, ha="center", bg=True)
    d.card("log-claim", Box(80, 470, 1760, 215), "research_loop · log / claim", ["登记尝试、主张与证据路径；以下是可录入的主张状态", "supported · partially_supported · refuted · undetermined · failed"], title_size=38, body_size=32, body_y=86, line_gap=58)

    d.arrow("record-review-path", [(495, 685), (495, 790)])
    d.arrow("record-claim-path", [(1425, 685), (1425, 790)])
    d.text(960, 725, "由主会话分别调用；不是自动串行验收", 29, color="muted", ha="center")

    d.card("review-round", Box(80, 790, 830, 155), "review-round", ["记录实际模型、评分、memory 与 trace"], title_size=38, body_size=31, body_y=86)
    d.arrow("trace-to-review-gate", [(495, 945), (495, 1020)])
    d.card("review-gate", Box(80, 1020, 830, 235), "review-gate", ["核对轨迹、响应去重与收敛条件", "accepted = 评审契约通过", "不等于科学事实被自动证实"], title_size=38, body_size=31, body_y=84, line_gap=46)

    d.card("claim-gate", Box(1010, 790, 830, 290), "claim-gate · 验收字段契约", ["证据路径 · 至少两个不同模型 family", "反例检查 completed · 无未解义务", "不会自动读证据或运行陪审团"], title_size=36, body_size=31, body_y=91, line_gap=53)
    d.arrow("accepted-to-user-authorization", [(1425, 1080), (1425, 1190)], color="gold", dash=True)
    d.text(1425, 1119, "已有内部 accepted，且用户确认", 28, color="gold", ha="center", bg=True)
    d.card("publication-authorization", Box(1010, 1190, 830, 205), "用户确认 → publish", ["记录该主张的对外发布授权", "仅写授权记录；不执行外部发布"], accent="gold", title_size=38, body_size=31, body_y=88, line_gap=47)

    d.rect("supervision-side-channel", Box(80, 1500, 1760, 300), fill="panel_alt")
    d.text(110, 1525, "主线监督（启用后）· 异步旁路", 36, color="cyan")
    d.text(110, 1580, "主会话提交研究节点；不作为上述各步的串行批准", 29, color="muted")
    d.card("new-material-checkpoint", Box(110, 1640, 450, 105), "新材料 + 研究节点", ["触发有界证据审查"], title_size=31, body_size=28, title_y=15, body_y=62)
    d.card("three-review-dimensions", Box(705, 1640, 450, 105), "方向 / 科学 / 健康", ["分别记录评审结果"], title_size=31, body_size=28, title_y=15, body_y=62)
    d.card("scoped-restriction", Box(1300, 1640, 510, 105), "有据的 OFF_TRACK", ["仅限制具体路径"], title_size=31, body_size=28, title_y=15, body_y=62)
    d.arrow("checkpoint-to-supervisor", [(560, 1693), (705, 1693)])
    d.arrow("review-to-scoped-policy", [(1155, 1693), (1300, 1693)])
    d.text(110, 1758, "缺信息或审查失败：记录盲点；不会冻结整个项目", 28, color="muted")
    return d


def locate_font(explicit: str | None) -> Path:
    candidates = [explicit, os.environ.get("README_DIAGRAM_FONT"),
                  "/usr/local/share/fonts/noto/NotoSansCJKsc-Regular.otf",
                  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate).resolve()
    raise SystemExit("Noto Sans CJK font not found. Pass --font /path/to/font.otf")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "docs" / "images")
    parser.add_argument("--font", help="Noto Sans CJK font file; README_DIAGRAM_FONT is also supported")
    args = parser.parse_args()
    font = locate_font(args.font)
    for build in (project_structure, auto_research, evidence_and_gates):
        build(font).save(args.output_dir)


if __name__ == "__main__":
    main()
