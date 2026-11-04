# Linux client

The Linux client now uses the shared [`desktop/`](../desktop/README.md) app and
its [`platform/`](../desktop/platform/) adapters. Windows uses the same player,
authentication flow, window lifecycle, and preload. Linux integration files live
in [`desktop/platform/linux/`](../desktop/platform/linux/).

Build an Arch package with `bash scripts/build-linux-package.sh`, or install the
development recipe with `yay -Bi pkg/aur/vibez-desktop-git`. Hardware testing is
deferred; the shared desktop guide includes the later test procedure.
