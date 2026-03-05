#!/usr/bin/env bash
# Wrapper to run Cypress on NixOS.
#
# Fixes two issues:
# 1. ELECTRON_RUN_AS_NODE=1 (set by VS Code / Claude Code) forces Cypress's
#    Electron binary into plain-Node mode, breaking Chromium flags.
# 2. libgtk-3 is not in the default nix-ld library set, so we add it via
#    LD_LIBRARY_PATH.

unset ELECTRON_RUN_AS_NODE
unset ELECTRON_NO_ATTACH_CONSOLE

GTK3=$(nix-build '<nixpkgs>' -A gtk3 --no-out-link 2>/dev/null)/lib
export LD_LIBRARY_PATH="${GTK3}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

exec npx cypress "$@"
