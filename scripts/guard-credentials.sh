#!/usr/bin/env bash
#
# 凭据守卫：GitHub 凭据绝不能进入 git 历史。
#
# 为什么扫「提交范围」而不是「工作树」：
#   `git grep -- .` 只看检出后的那一棵树。一个「先提交 token、再在同一 PR 里删掉」
#   的改动，终态是干净的、能通过树扫描，但 token 已经进入 main 的历史——GitHub 的
#   secret scanning 一样会检测到并自动撤销它，现象是「昨天还好，今天所有用户静默
#   401」，无人干预也会挂，且极难定位。所以要扫 diff 文本，删除行同样要拦
#   （被删掉的 token 说明它进过历史）。
#
# 为什么正则是 {30,} 而不是 {20,}：
#   真实凭据的长度是确定的——classic PAT / OAuth / App / refresh / server-to-server
#   是 `gh[pousr]_` + 36 字符，fine-grained PAT 是 `github_pat_` + 80 余字符。
#   把阈值定在真实格式的长度上，测试用的合成串（必须短于真实长度）就永远不会
#   误报，守卫因此**不需要白名单**。
#
# 用法：
#   ./scripts/guard-credentials.sh --history
#       扫全量历史（--all）。发布前用：发布是本仓库唯一会把内置 token 送到所有
#       用户手上的动作。
#   ./scripts/guard-credentials.sh --range <base>..<head>
#       扫本次变更的提交范围。CI 用：快且精确。base 为空 / 全零 / 不可解析时
#       自动退回 --history（宁可多扫，不可漏扫）。
#
# 退出码：0 = 干净；1 = 命中凭据或扫描失败；2 = 用法错误。

set -euo pipefail

# 真实 GitHub 凭据格式的长度下限。合成串只要短于它就不会命中。
readonly PATTERN='github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}'

usage() {
  echo "usage: $0 [--history | --range <base>..<head>]" >&2
}

scan_range() {
  # 用 --format= 去掉提交头，只留 diff 正文；--no-pager 防止 CI 里挂住。
  git --no-pager log -p --format= "$@"
}

mode="--history"
range=""

if [ "$#" -gt 0 ]; then
  case "$1" in
    --history)
      mode="--history"
      ;;
    --range)
      mode="--range"
      range="${2:-}"
      if [ -z "$range" ]; then
        usage
        exit 2
      fi
      ;;
    *)
      usage
      exit 2
      ;;
  esac
fi

if [ "$mode" = "--range" ]; then
  base="${range%%..*}"
  # 空 base、全零 base（新分支的 push 事件）、或不在本地的 base，都退回全量历史。
  if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ] \
    || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
    echo "Range base '${base}' is unusable; falling back to full history." >&2
    mode="--history"
  fi
fi

if [ "$mode" = "--history" ]; then
  set -- --all
else
  set -- "$range"
fi

# git 与 grep 的退出码必须**分开取**。合成一条管道再读 $? 是不行的：
# `set -o pipefail` 取的是管道里**最右**的非零码，所以 `git log` 失败(128) 而 grep
# 无命中(1) 时管道退出码是 1，与「扫过了、干净」无法区分——守卫会把「读不到历史」
# 报成 CLEAN，正是它自己要防的那类静默失败。先让 git 落盘并单独判它的码，再判 grep。
tmp_log="$(mktemp)"
tmp_hit="$(mktemp)"
trap 'rm -f "$tmp_log" "$tmp_hit"' EXIT

rc_git=0
if scan_range "$@" > "$tmp_log"; then rc_git=0; else rc_git=$?; fi
if [ "$rc_git" -ne 0 ]; then
  echo "::error::Credential scan failed: git could not read the commit range (exit ${rc_git}). Refusing to report a clean result."
  exit 1
fi

rc_grep=0
grep -EI "$PATTERN" "$tmp_log" > "$tmp_hit" && rc_grep=0 || rc_grep=$?

if [ "$rc_grep" -eq 0 ]; then
  head -20 "$tmp_hit"
  echo "::error::A GitHub credential pattern was found in the scanned commit range. Tokens must never enter git: secret scanning revokes them automatically and the failure is silent."
  exit 1
fi

if [ "$rc_grep" -ne 1 ]; then
  echo "::error::Credential scan failed (grep exit ${rc_grep}); refusing to report a clean result."
  exit 1
fi

echo "No credential patterns in the scanned commits (${mode})."
