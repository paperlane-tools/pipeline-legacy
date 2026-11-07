"""测试当前配置的模型是否支持图片输入（决定油猴脚本是否内置 OCR）。

用法：python scripts\\test_vision.py [图片路径]
"""

import base64
import json
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paper_pipeline import load_ai_config, CONFIG_FILE  # noqa: E402


class Args:
    base_url = None
    model = None
    api_key = None


def main():
    img = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "outputs", "record", "547941", "paper.png")
    base, model, key, src = load_ai_config(Args())
    print(f"base={base} model={model} key来源={src}")
    b64 = base64.b64encode(open(img, "rb").read()).decode()
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "这张图里的英文短文有几个空位？只回答一个数字。"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
        ]}],
        "max_tokens": 200,
    }
    r = requests.post(base + "/chat/completions", json=payload,
                      headers={"Authorization": "Bearer " + key}, timeout=180)
    print("HTTP", r.status_code)
    body = r.json()
    if r.status_code == 200:
        print("模型回答：", body["choices"][0]["message"]["content"][:300])
        print("usage:", body.get("usage"))
    else:
        print(json.dumps(body, ensure_ascii=False)[:600])


if __name__ == "__main__":
    main()
