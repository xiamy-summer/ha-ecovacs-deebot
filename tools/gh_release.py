#!/usr/bin/env python3
"""GitHub Release 打包发布工具（无需 gh CLI）。

用法：
    export GH_TOKEN_=<personal-access-token>
    python3 tools/gh_release.py --list                      # 只读：列出全部 release 与附件
    python3 tools/gh_release.py --publish v0.3.0 v0.2.0     # 确保这些 tag 有 release，并附上 dist/*.zip

前置：先用 `git archive` 打出 dist/ecovacs_deebot-<ver>.zip（见 tools/README 或发版流程），
      并把该版本的更新说明写进 CHANGELOG.md（会作为 release 正文）。
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

REPO = "xiamy-summer/ha-ecovacs-deebot"
ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


def token() -> str:
    tok = os.environ.get("GH_TOKEN_", "")
    if not tok:
        sys.exit("缺少 GH_TOKEN_ 环境变量（GitHub Personal Access Token）")
    return tok


def api(path: str, method: str = "GET", payload: dict | None = None) -> dict | list:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request("https://api.github.com" + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token())
    req.add_header("Accept", "application/vnd.github+json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            body = r.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"API {method} {path} -> {e.code}: {e.read().decode()[:400]}")


def upload_asset(release_id: int, path: pathlib.Path) -> dict:
    url = f"https://uploads.github.com/repos/{REPO}/releases/{release_id}/assets?name={path.name}"
    req = urllib.request.Request(url, data=path.read_bytes(), method="POST")
    req.add_header("Authorization", "Bearer " + token())
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Content-Type", "application/zip")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"上传 {path.name} 失败 -> {e.code}: {e.read().decode()[:400]}")


def changelog_sections() -> dict[str, tuple[str, str]]:
    """从 CHANGELOG.md 抽取 {tag: (标题, 正文)}，标题取 `## ` 行中 '—' 之后的描述。"""
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    out: dict[str, tuple[str, str]] = {}
    for m in re.finditer(r"^## (v[\d.]+)[^\n]*\n(.*?)(?=^## |\Z)", text, re.S | re.M):
        head = m.group(0).splitlines()[0]
        title = head.split("—", 1)[1].strip() if "—" in head else m.group(1)
        out[m.group(1)] = (title, m.group(2).strip())
    return out


def list_releases() -> list[dict]:
    return api(f"/repos/{REPO}/releases")  # type: ignore[return-value]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="列出全部 release 与附件")
    ap.add_argument("--publish", nargs="*", metavar="TAG", help="需要确保存在的 tag（如 v0.3.0）")
    args = ap.parse_args()

    if args.list or not args.publish:
        rels = list_releases()
        if not rels:
            print("(no releases yet)")
        for r in rels:
            print(f"- {r['tag_name']:10s} draft={r['draft']} assets={[a['name'] for a in r['assets']]}")
        return

    sections = changelog_sections()
    existing = {r["tag_name"]: r for r in list_releases()}

    for tag in args.publish:
        ver = tag.lstrip("v")
        subtitle, body = sections.get(tag, (tag, ""))
        title = f"{tag} — {subtitle}" if subtitle != tag else tag
        rel = existing.get(tag)
        if rel is None:
            rel = api(
                f"/repos/{REPO}/releases",
                method="POST",
                payload={"tag_name": tag, "name": title, "body": body, "draft": False, "prerelease": False},
            )
            print(f"[created] {tag} -> {rel['html_url']}")
        else:
            print(f"[exists ] {tag} -> {rel['html_url']}")

        zip_path = DIST / f"ecovacs_deebot-{ver}.zip"
        names = [a["name"] for a in rel.get("assets", [])]
        if not zip_path.exists():
            print(f"[skip   ] {tag}: 未找到 {zip_path}（先用 git archive 打包）")
        elif zip_path.name in names:
            print(f"[skip   ] {tag}: 附件 {zip_path.name} 已存在")
        else:
            asset = upload_asset(rel["id"], zip_path)
            print(f"[upload ] {tag}: {asset['name']} ({asset['size']} bytes)")


if __name__ == "__main__":
    main()
