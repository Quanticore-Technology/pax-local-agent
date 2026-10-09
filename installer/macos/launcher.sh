#!/bin/sh
# Keep pkg payload offsets intact by choosing a standalone binary.
prefix=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$(uname -m)" in
  arm64) binary=pax-agent-arm64 ;;
  x86_64) binary=pax-agent-x64 ;;
  *) echo "Unsupported Mac architecture" >&2; exit 1 ;;
esac
exec "$prefix/libexec/pax-agent/$binary" "$@"
