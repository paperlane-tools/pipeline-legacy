#!/usr/bin/env python
"""paper_pipeline.py — 「图片版试卷」自动作答流水线（程序负责作答，AI 只在兜底时介入）

阶段：
  fetch     取试卷图片 + 题目 id 列表（走站点接口）
  ocr       本地离线 OCR（Windows OCR / RapidOCR），把图片转成带坐标的文本行
  parse     从文本行还原成「短文 + 10 个空 + 每题 A~D 选项」
  solve     纯统计语言模型给每个选项打分，取最高分（不调用任何 AI 服务）
  fallback  对低置信度 / 反复摇摆的题目标记人工（AI）兜底答案
  submit    逐题调用站点接口写入答案（默认 dry-run）
  report    把整套题目、程序选择、置信度、来源整理成 Markdown 与 JSON 归档

用法示例：
  python paper_pipeline.py all --task 0                     # 识图+判题+归档（不写入服务器）
  python paper_pipeline.py fallback --tmid 547940 --set 9=A
  python paper_pipeline.py submit --tmid 547940             # 真写入（加 --yes 才执行）
"""

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
try:  # 让中文/符号在 Windows 控制台也按 UTF-8 输出
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
# 项目根目录：E:\yzj-js（可用环境变量 YZJ_ROOT 覆盖）
#   E:\yzj-js\scripts\   所有脚本（本文件与 OCR / 语料等工具）
#   E:\yzj-js\outputs\   交付物：record\<tmid>\、报告、截图
#   E:\yzj-js\work\      中间文件：session.json、语料、临时图
ROOT = os.environ.get("YZJ_ROOT") or os.path.dirname(HERE)
TOOLS = HERE
RECORD_ROOT = os.path.join(ROOT, "outputs", "record")
SESSION_FILE = os.path.join(ROOT, "work", "session.json")
API_BASE = "https://www.csgmooc.com/uni-gateway/jxapi2/"
SITE = "https://www.csgmooc.com"
def _find_node():
    """自动定位 Codex 自带 node（版本号会随更新变化，不要写死）。"""
    env = os.environ.get("PIPELINE_NODE")
    if env:
        return env
    base = os.path.join(os.environ.get("LOCALAPPDATA", ""), "OpenAI", "Codex", "runtimes", "cua_node")
    try:
        cands = [os.path.join(base, d, "bin", "node.exe") for d in os.listdir(base)]
        cands = [c for c in cands if os.path.exists(c)]
        if cands:
            return max(cands, key=os.path.getmtime)
    except Exception:
        pass
    return "node"


NODE = _find_node()


# ---------------------------------------------------------------- 工具

def rec_dir(tmid):
    path = os.path.join(RECORD_ROOT, str(tmid))
    os.makedirs(path, exist_ok=True)
    return path


def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)


def session():
    data = load_json(SESSION_FILE)
    if not data or not data.get("authtoken"):
        raise SystemExit("缺少会话信息，先运行：node outputs/get_session.mjs")
    return data


def api_headers(sess, form=False):
    return {"authtoken": sess["authtoken"],
            "Content-Type": "application/x-www-form-urlencoded" if form else "application/json"}


# ---------------------------------------------------------------- fetch

def stage_fetch(args):
    sess = session()
    mods = requests.get(API_BASE + "student/task/gettaskmodule",
                        params={"stuid": sess["stuId"], "gid": sess["gid"], "ttid": "", "sclassid": "",
                                "key": "", "taskTypeJson": "", "sublastType": "", "type": 0, "pcFlag": 0},
                        headers=api_headers(sess), timeout=30).json()
    modules = [m for group in mods.get("data", []) for m in group.get("taskModuleInfos", [])]
    if args.list:
        for i, m in enumerate(modules):
            print(f"[{i}] {m['tm_name']:>6}  {m['tt_name']}-{m['tc_name']}  tmid={m['tmid']}")
        return
    target = modules[args.task]
    tmid, sclassid, submit_id = target["tmid"], target["sclassid"], target["tm_subid"]

    paper = requests.get(API_BASE + "student/testvalidatedetail/gettestpaperofimage",
                         params={"tmid": tmid}, headers=api_headers(sess), timeout=30).json()
    images = [SITE + a["imgurl"] for a in (paper.get("data", {}).get("attrlist") or [])]
    answers = requests.post(API_BASE + "student/testquiz/v1/getStuTestQuizAnswer",
                            data={"stuClassId": sclassid, "submitId": submit_id, "tmid": tmid},
                            headers=api_headers(sess, form=True), timeout=30).json()
    question_ids = [a["questionId"] for a in answers.get("data", [])]

    out = rec_dir(tmid)
    meta = {
        "tmid": tmid, "sclassid": sclassid, "submitId": submit_id,
        "tm_name": target["tm_name"], "training": f"{target['tt_name']}-{target['tc_name']}",
        "questionIds": question_ids, "imageUrls": images,
        "expectedQuestions": target.get("number") and len(question_ids),
        "deadline": target.get("tm_sumlasttime"), "fetchedAt": datetime.now().isoformat(timespec="seconds"),
    }
    save_json(os.path.join(out, "paper.json"), meta)
    for idx, url in enumerate(images):
        img_path = os.path.join(out, f"paper{'' if idx == 0 else idx}.png")
        if not os.path.exists(img_path):
            img_path_bytes = requests.get(url, timeout=60).content
            with open(img_path, "wb") as fh:
                fh.write(img_path_bytes)
        meta.setdefault("imageSha256", []).append(hashlib.sha256(open(img_path, "rb").read()).hexdigest())
    save_json(os.path.join(out, "paper.json"), meta)
    print(f"tmid={tmid} 题数={len(question_ids)} 图片={len(images)} -> {out}")
    return tmid


# ---------------------------------------------------------------- ocr

def stage_ocr(args):
    out = rec_dir(args.tmid)
    paper = load_json(os.path.join(out, "paper.json"))
    img = os.path.join(out, "paper.png")
    if not os.path.exists(img):
        raise SystemExit(f"缺少试卷图片：{img}")

    upscaled = os.path.join(out, "paper_x3.png")
    subprocess.run([sys.executable, os.path.join(TOOLS, "upscale.py"), img, upscaled, "3"], check=True)
    ocr_json = os.path.join(out, "ocr.json")
    subprocess.run([sys.executable, os.path.join(TOOLS, "ocr_rapid.py"), upscaled, ocr_json], check=True)
    lines = load_json(ocr_json, [])
    with open(os.path.join(out, "ocr.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(l["text"] for l in lines))
    print(f"OCR 行数={len(lines)} -> {ocr_json}")


# ---------------------------------------------------------------- parse

OPT_LINE = re.compile(r"^\s*[\)\]]?\s*(\d{1,2})?[.、]?\s*([A-D])\s*[.、,]\s*(.+?)\s*$")
OPT_LINE_ANY = re.compile(r"^\s*[\)\]]?\s*(\d{1,2})?[.、]?\s*([A-J])\s*[.、,]\s*(.+?)\s*$")
BLANK = re.compile(r"_{1,}\s{0,4}(\d{1,2})?\s{0,4}_{0,}")
NUM_TOKEN = re.compile(r"(?<![\w.,])(\d{1,2})(?![\w.,])")
NON_ASCII = re.compile(r"[^\x00-\x7F]")


def ascii_ratio(text):
    letters = sum(c.isalpha() and c.isascii() for c in text)
    return letters / max(1, len(text.replace(" ", "")))


def stage_parse(args):
    out = rec_dir(args.tmid)
    lines = load_json(os.path.join(out, "ocr.json"), [])
    paper = load_json(os.path.join(out, "paper.json"))
    expected = len(paper["questionIds"])
    rows = []
    for line in lines:
        m = OPT_LINE_ANY.match(line["text"])
        if not m or len(m.group(3)) > 40:
            continue
        qnum, letter, text = m.group(1), m.group(2), m.group(3).strip()
        key = round(line["y"] / 40)
        rows.append((key, line, qnum, letter, text))

    grouped = defaultdict(list)
    for key, line, qnum, letter, text in rows:
        grouped[key].append((line, qnum, letter, text))
    option_rows = []
    for key in sorted(grouped):
        entries = sorted(grouped[key], key=lambda e: e[0]["x"])
        if len(entries) < 2:
            continue
        row = {"y": min(e[0]["y"] for e in entries), "options": {}}
        for line, qnum, letter, text in entries:
            row["options"].setdefault(letter, text)
            if qnum:
                row["qnum"] = int(qnum)
        option_rows.append(row)

    # 版式一：每题一行选项（如完型，10 行 × A~D）
    per_question = [r for r in option_rows if len(r["options"]) >= 4 and len(option_rows) > 2]
    # 版式二：共享词库（如选词填空，一个框里 A~E 供所有空位使用）
    shared_bank = None
    if not per_question and len(option_rows) == 1 and len(option_rows[0]["options"]) >= 3:
        shared_bank = option_rows[0]

    def keep(line):
        text = line["text"].strip()
        if re.fullmatch(r"[_0-9\s]{1,8}", text):   # 空位/序号这种短行也要保留
            return True
        return ascii_ratio(text) > 0.5 and len(text) >= 2

    if shared_bank is not None:
        passage_lines = [l for l in lines if l["y"] > shared_bank["y"] + 40 and keep(l)]
    else:
        first_option_y = per_question[0]["y"] if per_question else 10 ** 9
        passage_lines = [l for l in lines if l["y2"] < first_option_y - 4 and keep(l)]
    # 同一视觉行可能被空位切成多段（y 略有差异），先按 y 聚成行，再在行内按 x 排
    passage_lines.sort(key=lambda l: l["y"])
    rows = []
    for line in passage_lines:
        if rows and abs(line["y"] - rows[-1][0]["y"]) < 60:
            rows[-1].append(line)
        else:
            rows.append([line])
    passage = " ".join(l["text"] for row in sorted(rows, key=lambda r: r[0]["y"])
                       for l in sorted(row, key=lambda l: l["x"]))
    passage = re.sub(r"\s+", " ", passage).strip()

    blanks = []
    matches = list(BLANK.finditer(passage))
    prev_end = 0
    for i, m in enumerate(matches):
        left = passage[prev_end:m.start()]
        nxt = matches[i + 1].start() if i + 1 < len(matches) else len(passage)
        right = passage[m.end():nxt]
        prev_end = m.end()
        printed = int(m.group(1)) if m.group(1) and 1 <= int(m.group(1)) <= 30 else None
        blanks.append({"order": i + 1, "printed": printed, "left": left.strip(), "right": right.strip()})

    # 兜底：有些版式里空位只印了序号（如 __11__ 被识别成裸数字 11），用递增数字序列找空位
    if len(blanks) != expected:
        nums = [(m.start(), m.end(), int(m.group(1))) for m in NUM_TOKEN.finditer(passage)]
        best = []
        for start in range(len(nums)):
            run = [nums[start]]
            for nxt in nums[start + 1:]:
                if nxt[2] == run[-1][2] + 1:
                    run.append(nxt)
                elif nxt[2] > run[-1][2] + 1:
                    break
            if len(run) > len(best):
                best = run
        if len(best) == expected:
            blanks = [{"order": i + 1, "printed": n[2], "left": passage[:n[0]].strip(),
                       "right": passage[n[1]: (best[i + 1][0] if i + 1 < len(best) else len(passage))].strip()}
                      for i, n in enumerate(best)]
            for i, b in enumerate(blanks):
                b["left"] = b["left"].split("  ")[-1]
            print(f"  空位用「递增序号」兜底识别：{ [b['printed'] for b in blanks] }")

    # 用印在空位里的序号校正题号；缺号时按出现顺序补
    seq = [b["printed"] for b in blanks]
    ordered = seq == sorted(x for x in seq if x) and all(seq[i] and seq[i] == i + 1 for i in range(len(seq)) if seq[i])
    for i, b in enumerate(blanks):
        b["q"] = b["printed"] if (ordered and b["printed"]) else i + 1

    items = []
    if shared_bank is not None:
        for i in range(expected):
            items.append({"q": i + 1, "options": shared_bank["options"], "rowY": round(shared_bank["y"], 1),
                          "mode": "shared-bank"})
    else:
        for row in per_question:
            q = row.get("qnum") or (len(items) + 1)
            items.append({"q": q, "options": row["options"], "rowY": round(row["y"], 1), "mode": "per-question"})
    items.sort(key=lambda x: x["q"])
    for item in items:
        blank = next((b for b in blanks if b["q"] == item["q"]), None)
        item["blank"] = blank

    parsed = {"passage": passage, "blanks": blanks, "items": items,
              "questionIds": paper["questionIds"],
              "mode": "shared-bank" if shared_bank is not None else "per-question"}
    save_json(os.path.join(out, "parsed.json"), parsed)
    ok = sum(1 for it in items if it["blank"])
    print(f"识别到 {len(blanks)} 个空位、{len(items)} 道题（{ok} 道匹配到上下文）-> parsed.json")


# ---------------------------------------------------------------- solve（纯统计）

TOKEN = re.compile(r"[a-z]+(?:'[a-z]+)?")


def tokenize(text):
    return TOKEN.findall(text.lower())


class NGramLM:
    """三元语言模型，线性插值回退；纯计数，不含任何神经网络。"""

    def __init__(self, corpus_path):
        self.uni, self.bi, self.tri = Counter(), Counter(), Counter()
        self.total = 0
        with open(corpus_path, encoding="utf-8") as fh:
            for line in fh:
                toks = ["<s>", "<s>"] + tokenize(line) + ["</s>"]
                self.uni.update(toks)
                for i in range(len(toks) - 1):
                    self.bi[(toks[i], toks[i + 1])] += 1
                for i in range(len(toks) - 2):
                    self.tri[(toks[i], toks[i + 1], toks[i + 2])] += 1
        self.total = sum(self.uni.values())

    def logp(self, w, a=None, b=None):
        p1 = (self.uni.get(w, 0) + 0.1) / (self.total + 0.1 * (len(self.uni) + 1))
        p2 = (self.bi.get((b, w), 0) + 0.1) / (self.uni.get(b, 0) + 0.1 * (len(self.uni) + 1)) if b else p1
        p3 = (self.tri.get((a, b, w), 0) + 0.1) / (self.bi.get((a, b), 0) + 0.1 * (len(self.uni) + 1)) if a and b else p2
        return math.log(0.6 * p3 + 0.3 * p2 + 0.1 * p1)

    def score(self, left, cand_tokens, right):
        """只累加「与候选词有关」的三元组概率，避免长选项被长度惩罚。

        窗口：<s> <s> L2 L1 [候选…] R1 R2
        记分项：候选词本身的 P(w|前两词)，以及紧随其后的第一个词的 P(R1|…,候选末词)。
        """
        pre = left[-2:]
        seq = ["<s>"] * (2 - len(pre)) + pre + cand_tokens + right[:2]
        cand_idx = list(range(2, 2 + len(cand_tokens)))
        total = 0.0
        for i in range(2, len(seq)):
            if i in cand_idx or i == cand_idx[-1] + 1:
                total += self.logp(seq[i], seq[i - 2], seq[i - 1])
        return total


def stage_solve(args):
    out = rec_dir(args.tmid)
    parsed = load_json(os.path.join(out, "parsed.json"))
    corpus = args.corpus if os.path.isabs(args.corpus) else os.path.join(ROOT, args.corpus)
    lm = NGramLM(corpus)
    print(f"语言模型：unigram={len(lm.uni)} bigram={len(lm.bi)} trigram={len(lm.tri)}（语料 {corpus}）")

    # 摇摆检测：把语料随机切若干份，看答案是否稳定；不稳定的题判为需要兜底
    import random
    sentences = [ln for ln in open(corpus, encoding="utf-8").read().split("\n") if ln.strip()]
    random.seed(0)
    boot = []
    for _ in range(args.boot):
        sample = random.sample(sentences, max(1, int(len(sentences) * 0.7)))
        tmp = os.path.join(ROOT, "work", "_boot.txt")
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write("\n".join(sample))
        boot.append(NGramLM(tmp))

    results = []
    for item in parsed["items"]:
        blank = item["blank"]
        left = tokenize(blank["left"]) if blank else []
        right = tokenize(blank["right"]) if blank else []
        scores = {}
        for letter, text in sorted(item["options"].items()):
            scores[letter] = lm.score(left, tokenize(text), right)
        ranked = sorted(scores.items(), key=lambda kv: -kv[1])
        best, second = ranked[0], ranked[1] if len(ranked) > 1 else ("-", ranked[0][1] - 10)
        agree = 0
        for sub in boot:
            sub_rank = sorted(((L, sub.score(left, tokenize(t), right)) for L, t in item["options"].items()),
                              key=lambda kv: -kv[1])
            agree += 1 if sub_rank[0][0] == best[0] else 0
        stability = agree / len(boot) if boot else 1.0
        margin = best[1] - second[1]
        needs_fallback = (blank is None) or margin < args.margin or stability < args.stability
        results.append({
            "q": item["q"], "questionId": parsed["questionIds"][item["q"] - 1] if item["q"] - 1 < len(parsed["questionIds"]) else None,
            "options": item["options"],
            "scores": {k: round(v, 3) for k, v in scores.items()},
            "answer": best[0], "margin": round(margin, 3), "stability": round(stability, 2),
            "source": "program", "decidedBy": "ngram-lm",
            "needsFallback": bool(needs_fallback),
            "fallbackReason": ("无上下文" if blank is None else
                               ("边际过小" if margin < args.margin else "") +
                               ("／答案摇摆" if stability < args.stability else "")),
        })
        print(f"  第{item['q']:>2}题 -> {best[0]}  (边际 {margin:.2f} 稳定度 {stability:.2f}{'  [需兜底]' if needs_fallback else ''})  "
              + " ".join(f"{k}:{v:.1f}" for k, v in ranked))

    save_json(os.path.join(out, "answers.json"),
              {"tmid": args.tmid, "items": results, "solvedAt": datetime.now().isoformat(timespec="seconds")})
    save_json(os.path.join(out, "program_answers.json"),
              {"tmid": args.tmid, "items": results, "note": "纯统计模型的原始判定（未做 AI 兜底）"})


# ---------------------------------------------------------------- fallback / submit / report

def stage_fallback(args):
    out = rec_dir(args.tmid)
    data = load_json(os.path.join(out, "answers.json"))
    if not data:
        # 还没跑过统计模型也能直接用 AI 的答案：先按识图结果建一份骨架
        parsed = load_json(os.path.join(out, "parsed.json"))
        ids = parsed["questionIds"]
        data = {"tmid": args.tmid, "items": [
            {"q": it["q"], "questionId": ids[it["q"] - 1] if it["q"] - 1 < len(ids) else None,
             "options": it["options"], "scores": {}, "answer": None, "margin": None,
             "stability": None, "source": "pending"}
            for it in parsed["items"]]}
    for pair in args.set:
        q, _, letter = pair.partition("=")
        item = next((i for i in data["items"] if i["q"] == int(q)), None)
        if not item:
            raise SystemExit(f"没有第 {q} 题")
        item["answer"] = letter.strip().upper()
        item["source"] = "ai-fallback"
        item["decidedBy"] = args.reason or "ai-fallback"
    save_json(os.path.join(out, "answers.json"), data)
    print(f"已标注兜底答案：{', '.join(args.set)}")


# ---------------------------------------------------------------- AI 判题：标准接口

AI_REQUEST_SCHEMA = "csgmooc-answer-request/v1"
AI_RESPONSE_SCHEMA = "csgmooc-answer-response/v1"


def build_ai_request(tmid):
    """把识图结果压成 AI 只需要看的内容：短文 + 每题选项 + 空位上下文。"""
    out = rec_dir(tmid)
    paper = load_json(os.path.join(out, "paper.json"))
    parsed = load_json(os.path.join(out, "parsed.json"))
    questions = []
    for item in parsed["items"]:
        blank = item.get("blank") or {}
        questions.append({
            "q": item["q"],
            "options": item["options"],
            "left": " ".join(blank.get("left", "").split()[-12:]),
            "right": " ".join(blank.get("right", "").split()[:12]),
        })
    return {
        "schema": AI_REQUEST_SCHEMA,
        "tmid": str(tmid),
        "task": f"{paper['tm_name']} · {paper['training']}",
        "instruction": ("为每个空位从给定选项字母中选出最合适的一项；"
                        "只输出符合 outputSchema 的 JSON，不要多余文字。"),
        "passage": parsed["passage"],
        "questions": questions,
        "outputSchema": {
            "schema": AI_RESPONSE_SCHEMA,
            "tmid": str(tmid),
            "answers": {"<题号>": "<A|B|C|D>"},
            "confidence": {"<题号>": "0~1 的小数（可选）"},
            "reason": {"<题号>": "一句话理由（可选）"},
        },
    }


def validate_ai_response(req, resp):
    """严格校验 AI 的返回：题号齐全、字母在选项内。返回错误列表。"""
    errs = []
    if resp.get("schema") != AI_RESPONSE_SCHEMA:
        errs.append(f"schema 必须是 {AI_RESPONSE_SCHEMA}")
    if str(resp.get("tmid")) != str(req["tmid"]):
        errs.append(f"tmid 必须是 {req['tmid']}")
    answers = resp.get("answers") or {}
    for q in req["questions"]:
        key = str(q["q"])
        letter = answers.get(key)
        if letter is None:
            errs.append(f"第 {key} 题缺少答案")
        elif letter not in q["options"]:
            errs.append(f"第 {key} 题答案 {letter} 不在选项 {sorted(q['options'])} 内")
    extra = set(answers) - {str(q["q"]) for q in req["questions"]}
    if extra:
        errs.append(f"多出未知题号：{sorted(extra)}")
    return errs


def stage_ai_request(args):
    out = rec_dir(args.tmid)
    req = build_ai_request(args.tmid)
    path = args.out or os.path.join(out, "ai_request.json")
    save_json(path, req)
    print(f"AI 请求已生成：{path}（{len(req['questions'])} 题，{len(req['passage'])} 字符短文）")
    print("把这个文件交给 AI，让它按 outputSchema 返回 JSON 即可。")


def stage_ai_apply(args):
    out = rec_dir(args.tmid)
    req = load_json(args.file if os.path.isabs(args.file) else os.path.join(out, args.file.split("\\")[-1]))
    if req is None:
        raise SystemExit("找不到 AI 请求文件")
    resp = load_json(args.response)
    if resp is None:
        raise SystemExit(f"找不到 AI 返回文件：{args.response}")
    errs = validate_ai_response(req, resp)
    if errs:
        print("AI 返回不合格，未写入：")
        for e in errs:
            print("  - " + e)
        raise SystemExit(1)

    data = load_json(os.path.join(out, "answers.json"))
    if not data:
        # 没跑过统计模型也能直接用 AI 的答案：按识图结果建一份骨架
        parsed = load_json(os.path.join(out, "parsed.json"))
        ids = parsed["questionIds"]
        data = {"tmid": args.tmid, "items": [
            {"q": it["q"], "questionId": ids[it["q"] - 1] if it["q"] - 1 < len(ids) else None,
             "options": it["options"], "scores": {}, "answer": None, "margin": None,
             "stability": None, "source": "pending"}
            for it in parsed["items"]]}
    conf = resp.get("confidence") or {}
    reason = resp.get("reason") or {}
    for item in data["items"]:
        key = str(item["q"])
        item["answer"] = resp["answers"][key]
        item["source"] = "ai"
        item["decidedBy"] = args.model or "ai-model"
        item["aiConfidence"] = conf.get(key)
        item["aiReason"] = reason.get(key)
    save_json(os.path.join(out, "answers.json"), data)
    save_json(os.path.join(out, "ai_response.json"), resp)
    print("AI 返回已校验通过并写入 answers.json：" +
          " ".join(f"{i['q']}={i['answer']}" for i in data["items"]))


CONFIG_FILE = os.path.join(ROOT, "config.json")


def load_ai_config(args):
    """AI 接入配置：命令行参数 > 环境变量 > config.json。返回 (base_url, model, api_key, 来源)。"""
    cfg = load_json(CONFIG_FILE) or {}
    ai = cfg.get("ai") or {}
    env_name = ai.get("api_key_env") or "DEEPSEEK_API_KEY"
    base = args.base_url or ai.get("base_url") or "https://api.deepseek.com"
    model = args.model or ai.get("model") or "deepseek-chat"
    key, src = "", "无"
    if args.api_key:
        key, src = args.api_key, "命令行 --api-key"
    elif os.environ.get(env_name):
        key, src = os.environ[env_name], f"环境变量 {env_name}"
    elif ai.get("api_key"):
        key, src = ai["api_key"], f"{CONFIG_FILE}"
    return base.rstrip("/"), model, key, src


def build_ai_messages(req):
    """给模型的对话：system 固定角色，user 里塞结构化请求（含 passage 与 outputSchema）。"""
    return [
        {"role": "system",
         "content": "你是英语试卷判题程序的一部分。只输出一个 json 对象（JSON object），"
                    "不要解释、不要 Markdown 代码块。"},
        {"role": "user",
         "content": json.dumps(req, ensure_ascii=False)},
    ]


def extract_json_object(text):
    """从模型输出里抠出第一个完整的 JSON 对象（容错：代码块、前后废话）。"""
    if not text:
        return None
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    start = text.find("{")
    if start < 0:
        return None
    depth, in_str, esc = 0, False, False
    for i, ch in enumerate(text[start:], start):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def stage_ai_solve_api(args):
    """程序自己请求 AI：POST /chat/completions（OpenAI 兼容，支持 DeepSeek），拿回严格 JSON 再作答。

    依赖 config.json（api_key / base_url / model）或 --api-key / 环境变量。
    --print-request 只打印将发送的请求（不联网）；--mock-response 用本地假响应测试解析链路。
    """
    base, model, key, key_src = load_ai_config(args)

    if args.list_models:
        if not key:
            raise SystemExit(f"没有拿到 API key（可在 {CONFIG_FILE} 里填，或用 --api-key）")
        r = requests.get(base + "/models", headers={"Authorization": "Bearer " + key}, timeout=60)
        print(f"GET {base}/models -> {r.status_code}")
        try:
            for m in (r.json().get("data") or []):
                print("  " + str(m.get("id")))
        except Exception:
            print(r.text[:500])
        return

    out = rec_dir(args.tmid)
    req = build_ai_request(args.tmid)
    save_json(os.path.join(out, "ai_request.json"), req)

    payload = {
        "model": model,
        "messages": build_ai_messages(req),
        "temperature": args.temperature,
        "max_tokens": args.max_tokens,
        "response_format": {"type": "json_object"},
    }
    if args.print_request:
        shown = json.loads(json.dumps(payload))
        shown["messages"][1]["content"] = shown["messages"][1]["content"][:400] + " ...(截断)"
        print(f"POST {base}/chat/completions")
        print(f"Authorization: Bearer {'*' * 8 if key else '(未配置)'}   [来源：{key_src}]")
        print(json.dumps(shown, ensure_ascii=False, indent=1))
        return

    if args.mock_response:
        envelope = load_json(args.mock_response)
        if envelope is None:
            raise SystemExit(f"找不到 mock 响应文件：{args.mock_response}")
        print(f"[mock] 使用 {args.mock_response} 模拟模型返回，不联网")
    else:
        if not key:
            raise SystemExit(f"没有 API key：在 {CONFIG_FILE} 填 api_key，或设环境变量 DEEPSEEK_API_KEY，"
                             f"或用 --api-key 传入")
        if not args.allow_upload:
            raise SystemExit(f"程序会把试卷内容发送到 {base}，确认后加 --allow-upload 再跑")
        t0 = datetime.now().isoformat(timespec="seconds")
        r = requests.post(base + "/chat/completions", json=payload,
                          headers={"Authorization": "Bearer " + key}, timeout=args.timeout)
        if r.status_code == 400 and "response_format" in r.text:
            # 有些模型（如推理型）不支持 JSON 模式，去掉该参数重试一次
            payload.pop("response_format", None)
            print("[warn] 该模型不支持 response_format，已去掉后重试")
            r = requests.post(base + "/chat/completions", json=payload,
                              headers={"Authorization": "Bearer " + key}, timeout=args.timeout)
        if r.status_code != 200:
            raise SystemExit(f"接口返回 {r.status_code}：{r.text[:400]}")
        envelope = r.json()
        save_json(os.path.join(out, "ai_api_raw.json"),
                  {"at": t0, "model": model, "base_url": base, "usage": envelope.get("usage"),
                   "raw": envelope})

    try:
        content = envelope["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        save_json(os.path.join(out, "ai_response.invalid.json"), envelope)
        raise SystemExit("模型返回里没有 choices[0].message.content")

    resp = extract_json_object(content)
    if not isinstance(resp, dict):
        save_json(os.path.join(out, "ai_response.invalid.json"), envelope)
        raise SystemExit("模型输出不是合法 JSON：" + content[:300])
    # 容错：JSON 模式下模型常省略 schema/tmid，按请求补上；答案部分仍严格校验
    resp.setdefault("schema", AI_RESPONSE_SCHEMA)
    resp.setdefault("tmid", str(req["tmid"]))
    save_json(os.path.join(out, "ai_response.json"), resp)

    errs = validate_ai_response(req, resp)
    if errs:
        raise SystemExit("模型返回不符合约定：" + "; ".join(errs))
    print(f"模型 {model} 判定：" + " ".join(f"{k}={v}" for k, v in sorted(resp["answers"].items(), key=lambda kv: int(kv[0]))))
    if args.no_apply:
        print("--no-apply：只校验，不写入 answers.json")
        return
    stage_ai_apply(argparse.Namespace(tmid=args.tmid, file="ai_request.json",
                                      response=os.path.join(out, "ai_response.json"), model=model))


def stage_submit(args):
    out = rec_dir(args.tmid)
    data = load_json(os.path.join(out, "answers.json"))
    paper = load_json(os.path.join(out, "paper.json"))
    sess = session()
    results = []
    for item in data["items"]:
        if not item.get("questionId"):
            continue
        payload = {"answerStr": item["answer"], "needAnalysis": 0, "questionId": item["questionId"],
                   "stuClassId": paper["sclassid"], "submitId": paper["submitId"], "tmid": paper["tmid"],
                   "files": None, "gradeId": None, "isActiveRepulse": 0}
        if not args.yes:
            results.append({"q": item["q"], "answer": item["answer"], "dryRun": True})
            continue
        resp = requests.post(API_BASE + "student/testquiz/v1/saveQuestionRecord", json=payload,
                             headers=api_headers(sess), timeout=30).json()
        results.append({"q": item["q"], "answer": item["answer"], "flag": resp.get("data", {}).get("flag"),
                        "message": resp.get("message")})
        time.sleep(0.2)
    save_json(os.path.join(out, "submit.json"), {"submittedAt": datetime.now().isoformat(timespec="seconds"),
                                                 "yes": bool(args.yes), "results": results})
    print(json.dumps(results, ensure_ascii=False))


def stage_report(args):
    out = rec_dir(args.tmid)
    paper = load_json(os.path.join(out, "paper.json"))
    parsed = load_json(os.path.join(out, "parsed.json"))
    answers = load_json(os.path.join(out, "answers.json"))
    verify = load_json(os.path.join(out, "verify.json"))
    sources = {i.get("source") for i in answers["items"]}
    if sources <= {"ai"}:
        source_text = "判题：AI（程序只负责识图 / 提交 / 归档）"
    elif "ai" in sources:
        source_text = "判题：程序先判（三元统计），AI 复核兜底"
    else:
        source_text = "判题：程序（三元统计语言模型）"
    lines = [f"# 自动作答记录 · {paper['tm_name']}（{paper['training']}）", "",
             f"- 试卷图片：{', '.join(paper['imageUrls'])}",
             f"- 图片 SHA256：{paper.get('imageSha256', [''])[0]}",
             f"- 题数：{len(answers['items'])}　截止：{paper.get('deadline')}",
             f"- {source_text}", ""]
    if verify:
        lines += [f"- 交卷成绩：**{verify.get('task_score')} 分**，"
                  f"{sum(1 for r in verify['rows'] if r.get('right') == 1)}/{len(verify['rows'])} 题正确", ""]
    lines += [
             "## 识图出的短文", "", parsed["passage"], "",
             "## 逐题结果", "",
             "| 题号 | 选项（A/B/C/D） | 程序选择 | 边际 | 稳定度 | 最终答案 | 官方判定 |", "|---|---|---|---|---|---|---|"]
    verify_rows = {r["no"]: r for r in (verify or {}).get("rows", [])}
    for item in answers["items"]:
        opts = " / ".join(f"{k}.{v}" for k, v in sorted(item["options"].items()))
        prog = next((i for i in (load_json(os.path.join(out, "program_answers.json")) or {}).get("items", [])
                     if i["q"] == item["q"]), None)
        right = verify_rows.get(item["q"], {}).get("right")
        lines.append(f"| {item['q']} | {opts} | {prog['answer'] if prog else '-'} | {prog['margin'] if prog else '-'} | "
                     f"{prog['stability'] if prog else '-'} | **{item['answer']}** | {'✓' if right == 1 else ('×' if right is not None else '—')} |")
    lines += ["", "## 每个选项的模型打分（log 概率，越大越顺）", ""]
    for item in answers["items"]:
        scores = "　".join(f"{k}:{v}" for k, v in item["scores"].items())
        lines.append(f"- 第 {item['q']} 题：{scores}")
    with open(os.path.join(out, "report.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"归档完成 -> {out}\\report.md")


def stage_verify(args):
    """交卷后回读官方批改结果，写入 verify.json（用于检验程序+AI 的准确率）。"""
    out = rec_dir(args.tmid)
    paper = load_json(os.path.join(out, "paper.json"))
    sess = session()
    data = requests.get(API_BASE + "student/testvalidatedetail/getanswersheetofstudent",
                        params={"tmid": paper["tmid"], "sclassid": paper["sclassid"]},
                        headers=api_headers(sess), timeout=30).json().get("data") or {}
    cards = [a for c in data.get("answerSheetOfCards", []) for a in c.get("answerOfCards", [])]
    verify = {"task_score": data.get("task_score"), "sub_time": data.get("sub_time"),
              "checkedAt": datetime.now().isoformat(timespec="seconds"),
              "rows": [{"no": i + 1, "mine": a.get("tq_answer"), "official": a.get("q_answer"),
                        "right": a.get("is_right"), "score": a.get("tq_score")} for i, a in enumerate(cards)]}
    save_json(os.path.join(out, "verify.json"), verify)
    print(f"成绩 {verify['task_score']} 分；正确 {sum(1 for r in verify['rows'] if r['right'] == 1)}/{len(verify['rows'])}")


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="图片版试卷自动作答流水线")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("fetch"); p.add_argument("--task", type=int, default=0); p.add_argument("--list", action="store_true")
    p.set_defaults(func=stage_fetch)
    p = sub.add_parser("ocr"); p.add_argument("--tmid", required=True); p.set_defaults(func=stage_ocr)
    p = sub.add_parser("parse"); p.add_argument("--tmid", required=True); p.set_defaults(func=stage_parse)
    p = sub.add_parser("solve"); p.add_argument("--tmid", required=True)
    p.add_argument("--corpus", default="work/corpus_big.txt")
    p.add_argument("--margin", type=float, default=0.5, help="边际低于此值判为需要兜底")
    p.add_argument("--stability", type=float, default=0.8, help="摇摆稳定度低于此值判为需要兜底")
    p.add_argument("--boot", type=int, default=6, help="摇摆检测的子模型数量")
    p.set_defaults(func=stage_solve)
    p = sub.add_parser("fallback"); p.add_argument("--tmid", required=True)
    p.add_argument("--set", nargs="+", required=True); p.add_argument("--reason", default="")
    p.set_defaults(func=stage_fallback)
    p = sub.add_parser("ai-request"); p.add_argument("--tmid", required=True); p.add_argument("--out", default=None)
    p.set_defaults(func=stage_ai_request)
    p = sub.add_parser("ai-apply"); p.add_argument("--tmid", required=True)
    p.add_argument("--file", default="ai_request.json"); p.add_argument("--response", required=True)
    p.add_argument("--model", default=""); p.set_defaults(func=stage_ai_apply)
    p = sub.add_parser("ai-solve", help="程序自己请求 AI 判题（OpenAI 兼容 / DeepSeek）")
    p.add_argument("--tmid", required=True)
    p.add_argument("--model", default=None, help="默认取 config.json 或 deepseek-chat")
    p.add_argument("--base-url", default=None, help="默认 https://api.deepseek.com")
    p.add_argument("--api-key", default=None, help="也可以写进 config.json 或环境变量")
    p.add_argument("--temperature", type=float, default=0)
    p.add_argument("--max-tokens", type=int, default=2000)
    p.add_argument("--timeout", type=int, default=180)
    p.add_argument("--allow-upload", action="store_true", help="确认把试卷内容发送给该服务")
    p.add_argument("--print-request", action="store_true", help="只打印将发送的请求，不联网")
    p.add_argument("--mock-response", default=None, help="用本地假响应测试解析/校验链路，不联网")
    p.add_argument("--no-apply", action="store_true", help="只校验不写入 answers.json")
    p.add_argument("--list-models", action="store_true", help="列出该 key 可用的模型")
    p.set_defaults(func=stage_ai_solve_api)
    p = sub.add_parser("submit"); p.add_argument("--tmid", required=True); p.add_argument("--yes", action="store_true")
    p.set_defaults(func=stage_submit)
    p = sub.add_parser("verify"); p.add_argument("--tmid", required=True); p.set_defaults(func=stage_verify)
    p = sub.add_parser("report"); p.add_argument("--tmid", required=True); p.set_defaults(func=stage_report)
    p = sub.add_parser("all"); p.add_argument("--task", type=int, default=0)
    p.add_argument("--corpus", default="work/corpus_big.txt")
    p.add_argument("--margin", type=float, default=0.5)
    p.add_argument("--stability", type=float, default=0.8)
    p.add_argument("--boot", type=int, default=6)
    p.set_defaults(func=None)

    args = ap.parse_args()
    if args.cmd == "all":
        tmid = stage_fetch(argparse.Namespace(task=args.task, list=False))
        for fn, ns in ((stage_ocr, argparse.Namespace(tmid=tmid)),
                       (stage_parse, argparse.Namespace(tmid=tmid)),
                       (stage_solve, argparse.Namespace(tmid=tmid, corpus=args.corpus, margin=args.margin,
                                                        stability=args.stability, boot=args.boot)),
                       (stage_report, argparse.Namespace(tmid=tmid))):
            fn(ns)
        return
    args.func(args)


if __name__ == "__main__":
    main()
