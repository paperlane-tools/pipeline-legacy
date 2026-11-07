"""check_task.py —— 查某套题的成绩与逐题对错（无需浏览器，只用 work\\session.json）

用法：python scripts\\check_task.py 547942 468270
"""

import json
import os
import sys

import requests

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SESSION = os.path.join(ROOT, "work", "session.json")
API = "https://www.csgmooc.com/uni-gateway/jxapi2/"


def main():
    tmid = sys.argv[1] if len(sys.argv) > 1 else "547942"
    sclassid = sys.argv[2] if len(sys.argv) > 2 else "468270"
    sess = json.load(open(SESSION, encoding="utf-8"))
    data = requests.get(API + "student/testvalidatedetail/getanswersheetofstudent",
                        params={"tmid": tmid, "sclassid": sclassid},
                        headers={"authtoken": sess["authtoken"]}, timeout=30).json().get("data") or {}
    cards = [a for c in (data.get("answerSheetOfCards") or []) for a in (c.get("answerOfCards") or [])]
    print(f"tmid={tmid} 成绩={data.get('task_score')} 交卷时间={data.get('sub_time')}")
    line = []
    right = 0
    for i, a in enumerate(cards):
        mark = "✓" if a.get("is_right") == 1 else ("✗" if a.get("is_right") is not None else "－")
        right += 1 if a.get("is_right") == 1 else 0
        line.append(f"{i + 1}:{a.get('tq_answer') or '未答'}{mark}")
    print(" ".join(line))
    print(f"正确 {right}/{len(cards)}")


if __name__ == "__main__":
    main()
