"""抓取英文新闻（国内可访问站点）作为纯统计语言模型的语料。

不依赖任何 AI 服务：只是把网页正文里的英文句子抽出来存成 corpus.txt。
"""

import argparse
import re
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse

import requests

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) research-corpus-builder"}
SEEDS = [
    "https://www.chinadaily.com.cn/",
    "https://www.chinadaily.com.cn/business",
    "https://www.chinadaily.com.cn/china",
    "https://www.chinadaily.com.cn/world",
    "https://www.chinadaily.com.cn/life",
    "https://www.chinadaily.com.cn/opinion",
    "https://www.chinadaily.com.cn/culture",
    "https://www.chinadaily.com.cn/sports",
    "https://en.people.cn/",
    "https://en.people.cn/90882/index.html",
    "https://en.people.cn/90777/index.html",
    "https://en.people.cn/90785/index.html",
    "https://www.globaltimes.cn/china/index.html",
    "https://www.globaltimes.cn/world/index.html",
    "https://www.globaltimes.cn/business/index.html",
    "https://www.globaltimes.cn/life/index.html",
    "https://www.cgtn.com/",
]

TAG_RE = re.compile(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>|<[^>]+>")
PARA_RE = re.compile(r"<p[^>]*>([\s\S]*?)</p>", re.I)
LINK_RE = re.compile(r'<a[^>]+href="([^"]+)"', re.I)
SENT_RE = re.compile(r"[A-Z][^.!?]{20,400}[.!?]")
WORD_OK = re.compile(r"^[\x20-\x7E]+$")


def clean(html_text):
    text = TAG_RE.sub(" ", html_text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", '"')
                .replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">"))
    return re.sub(r"\s+", " ", text).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="work/corpus.txt")
    ap.add_argument("--articles", type=int, default=150)
    ap.add_argument("--delay", type=float, default=0.3)
    ap.add_argument("--threads", type=int, default=1)
    args = ap.parse_args()

    queue = deque(SEEDS)
    seen_pages, seen_articles = set(), set()
    sentences, pages = [], 0

    def visit(url, sess):
        """抓一个页面：返回 (正文句子, 同域候选链接)。"""
        if url in seen_pages or not url.startswith("http"):
            return [], []
        seen_pages.add(url)
        try:
            resp = sess.get(url, timeout=15)
            if resp.status_code != 200 or "html" not in resp.headers.get("Content-Type", ""):
                return [], []
            resp.encoding = resp.apparent_encoding or resp.encoding
            html = resp.text
        except Exception as exc:  # 网络问题直接跳过
            print(f"skip {url}: {exc}", file=sys.stderr)
            return [], []

        host = urlparse(url).netloc
        links = []
        for href in LINK_RE.findall(html):
            nxt = urljoin(url, href)
            p = urlparse(nxt)
            if p.netloc != host or nxt in seen_pages:
                continue
            path = p.path.lower()
            if any(k in path for k in ("/a/", "/article", "/news", "/2025", "/2026")) and path.endswith((".html", "/")):
                links.append(nxt)

        # 正文：<p> 里成句的英文
        body = " ".join(PARA_RE.findall(html)) or html
        plain = clean(body)
        found = []
        for s in SENT_RE.findall(plain):
            s = s.strip()
            if WORD_OK.match(s) and sum(c.isalpha() for c in s) > len(s) * 0.6:
                found.append(s)
        return found, links

    def worker(url):
        sess = requests.Session()
        sess.headers.update(HEADERS)
        body, links = visit(url, sess)
        time.sleep(args.delay)
        return url, body, links

    if args.threads > 1:
        with ThreadPoolExecutor(max_workers=args.threads) as pool:
            while queue and len(seen_articles) < args.articles:
                batch = [queue.popleft() for _ in range(min(args.threads * 2, len(queue)))]
                for url, body, links in pool.map(worker, batch):
                    pages += 1
                    if body:
                        sentences.extend(body)
                        seen_articles.add(url)
                        print(f"[{len(seen_articles):>3}] {len(sentences):>6} sents  {url}", flush=True)
                    for nxt in links:
                        if len(queue) < 5000 and nxt not in seen_pages:
                            queue.append(nxt)
    else:
        sess = requests.Session()
        sess.headers.update(HEADERS)
        while queue and len(seen_articles) < args.articles:
            url = queue.popleft()
            body, links = visit(url, sess)
            pages += 1
            if body:
                sentences.extend(body)
                seen_articles.add(url)
                print(f"[{len(seen_articles):>3}] {len(sentences):>6} sents  {url}", flush=True)
            for nxt in links:
                if len(queue) < 5000 and nxt not in seen_pages:
                    queue.append(nxt)
            time.sleep(args.delay)

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(sentences))
    print(f"\npages={pages} articles={len(seen_articles)} sentences={len(sentences)} -> {args.out}")


if __name__ == "__main__":
    main()
