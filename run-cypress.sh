#!/usr/bin/env bash
# Wrapper to run Cypress, with NixOS-specific fixes when needed.
#
# On NixOS:
# 1. ELECTRON_RUN_AS_NODE=1 (set by VS Code / Claude Code) forces Cypress's
#    Electron binary into plain-Node mode, breaking Chromium flags.
# 2. Various shared libraries (GTK3, NSS, ALSA, X11) are not in the default
#    nix-ld library set, so we add them via LD_LIBRARY_PATH.

unset ELECTRON_RUN_AS_NODE
unset ELECTRON_NO_ATTACH_CONSOLE

if grep -qi nixos /etc/os-release 2>/dev/null; then
  LIBS=""
  for pkg in gtk3 nss alsa-lib xorg.libXtst xorg.libXScrnSaver; do
    path=$(nix-build '<nixpkgs>' -A "$pkg" --no-out-link 2>/dev/null)
    if [ -n "$path" ] && [ -d "$path/lib" ]; then
      LIBS="${LIBS:+$LIBS:}$path/lib"
    fi
  done
  if [ -n "$LIBS" ]; then
    export LD_LIBRARY_PATH="${LIBS}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi
fi

exec npx cypress "$@"
