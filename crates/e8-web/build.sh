#!/bin/sh
# Builds E8 for the web into crates/e8-web/web/pkg; serve.py then serves it.
#
# Needs nightly Rust with rust-src and the wasm32-unknown-unknown target
# (std is rebuilt with atomics, so the editor's worker can share memory),
# wasm-bindgen-cli at Cargo.lock's version, and an LLVM clang that targets
# wasm for QuickJS and tree-sitter: Apple's does not, so it comes from Nix
# where there is Nix, else `clang` and `llvm-ar` on PATH (as on Linux, whose
# clang targets wasm), unless WASM_CC, WASM_AR and WASM_RESOURCE_DIR say
# otherwise.
#
# PROFILE=dev builds faster, unoptimised; the default is release.
# WASM_TOOLCHAIN names the nightly, `nightly` unless pinned, as the website's
# workflow pins it. STRIP=1 leaves out the names of functions, 4.5 MB,
# which panics' stacks then lack.
set -eu
cd "$(dirname "$0")/../.."
profile=${PROFILE:-release}
toolchain=${WASM_TOOLCHAIN:-nightly}

if [ -z "${WASM_CC:-}" ] && command -v nix >/dev/null; then
  llvm=nixpkgs#llvmPackages_20
  WASM_CC=$(nix build --no-link --print-out-paths $llvm.clang-unwrapped)/bin/clang
  WASM_AR=$(nix build --no-link --print-out-paths $llvm.bintools-unwrapped)/bin/llvm-ar
  WASM_RESOURCE_DIR=$(nix build --no-link --print-out-paths $llvm.clang-unwrapped.lib)/lib/clang/20
fi
WASM_CC=${WASM_CC:-clang}
WASM_AR=${WASM_AR:-llvm-ar}
# Nix's unwrapped clang cannot find its own headers, such as stdbool.h.
resource_dir=${WASM_RESOURCE_DIR:+-resource-dir $WASM_RESOURCE_DIR}
# The grammar crates' C wants a libc; tree-sitter-language ships the subset
# tree-sitter's own wasm build uses.
ts_language=$(cargo metadata --format-version 1 | python3 -c '
import json, os, sys
for p in json.load(sys.stdin)["packages"]:
    if p["name"] == "tree-sitter-language":
        print(os.path.dirname(p["manifest_path"]))')

export CC_wasm32_unknown_unknown="$WASM_CC"
export AR_wasm32_unknown_unknown="$WASM_AR"
export CFLAGS_wasm32_unknown_unknown="$resource_dir -idirafter $ts_language/wasm/include -matomics -mbulk-memory"
export RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--max-memory=4294967296"
# A target directory of its own, as make check keeps QuickJS's, so building
# for the web never rebuilds the native workspace.
export CARGO_TARGET_DIR="$PWD/target/wasm"

# QuickJS links the wasi-libc rquickjs vendors, and tree-sitter compiles in
# the libc subset of its own wasm build: the same functions twice, of which
# the linker takes the first. The memory is shared with the editor's
# worker, which needs thread-local storage of its own. rquickjs's wasi-libc
# is built without atomics, which shared memory otherwise refuses: only the
# editor's worker runs C (QuickJS and tree-sitter), so its malloc is never
# called from two threads at once.
cargo "+$toolchain" rustc -p e8-web --lib --crate-type cdylib --target wasm32-unknown-unknown --profile "$profile" -Z build-std=std,panic_abort -- -C link-arg=--allow-multiple-definition \
  -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--no-check-features \
  -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base
dir=$([ "$profile" = dev ] && echo debug || echo "$profile")
strip=${STRIP:+--remove-name-section --remove-producers-section}
# shellcheck disable=SC2086
wasm-bindgen --target web $strip --out-dir crates/e8-web/web/pkg "$CARGO_TARGET_DIR/wasm32-unknown-unknown/$dir/e8_web.wasm"
ls -l crates/e8-web/web/pkg/e8_web_bg.wasm
