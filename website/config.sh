#!/bin/sh
# Puts the website's E8 configuration in DIR, as ~/.config/e8 would hold it
# after e8.usePackage installed the ports in packages.txt: init.ts, each
# port checked out in repos/NAME at its newest tag, with .git/HEAD naming the
# commit, and e8-lock.json pinning them, so usePackage finds them installed
# and runs no git, which a page cannot. files.json maps each file here to
# where it goes in ~/.config/e8, for the page to fetch: .git/HEAD is kept as
# git-head, as Pages leaves out .git directories. Needs git and python3.
set -eu
rm -rf "$1"
mkdir -p "$1/repos"
out=$(cd "$1" && pwd)
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cp init.ts "$out/init.ts"
lock="$work/lock.tsv"
: > "$lock"
grep -v '^#' packages.txt | grep -v '^$' | while read -r source; do
  url="https://github.com/$source.git"
  tag=$(git ls-remote --tags --refs "$url" | sed 's|.*refs/tags/||' | grep '^v[0-9]' | sort -V | tail -1)
  git clone --quiet --depth 1 --branch "$tag" "$url" "$work/clone" 2>/dev/null
  name=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["name"])' "$work/clone/e8-package.json")
  commit=$(git -C "$work/clone" rev-parse HEAD)
  dir="$out/repos/$name"
  mkdir -p "$dir"
  # What loading needs, and the licence and credit that go with the code.
  git -C "$work/clone" ls-files | grep -E '^([^/]+\.ts|e8-package\.json|LICENSE.*|README.*)$' | while read -r file; do
    cp "$work/clone/$file" "$dir/$file"
  done
  echo "$commit" > "$dir/git-head"
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$source" "$url" "$commit" "$tag" >> "$lock"
  rm -rf "$work/clone"
  echo "$name $tag"
done

python3 - "$lock" "$out" <<'EOF'
import json, os, sys
lock_file, out = sys.argv[1], sys.argv[2]
packages = {}
for line in open(lock_file):
    name, source, url, commit, tag = line.rstrip("\n").split("\t")
    packages[name] = {"source": source, "url": url, "commit": commit, "tag": tag}
with open(os.path.join(out, "e8-lock.json"), "w") as f:
    json.dump({"version": 1, "packages": dict(sorted(packages.items()))}, f, indent=2)
    f.write("\n")
files = sorted(os.path.relpath(os.path.join(d, n), out) for d, _, ns in os.walk(out) for n in ns)
where = {f: f[: -len("git-head")] + ".git/HEAD" if f.endswith("/git-head") else f for f in files}
with open(os.path.join(out, "files.json"), "w") as f:
    json.dump(where, f, indent=1)
EOF
