#!/usr/bin/env python3
"""Launch the Linux Tauri app on WSLg and reap only this launch's helpers."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import tempfile
import time


def owned_helpers(marker):
    """Open stable process handles and verify the private launch marker."""
    helpers = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            handle = os.pidfd_open(int(entry.name))
        except (ProcessLookupError, PermissionError):
            continue
        try:
            environment = (entry / "environ").read_bytes()
            if marker in environment.split(b"\0"):
                helpers.append(handle)
                continue
        except OSError:
            pass
        os.close(handle)
    return helpers


def stop_helpers(marker):
    # WebKit and the accessibility bus can spawn helpers in their own sessions.
    # The launch marker scopes cleanup without matching by process name or PID.
    for stop_signal in (signal.SIGTERM, signal.SIGKILL):
        helpers = owned_helpers(marker)
        if not helpers:
            return
        for handle in helpers:
            try:
                signal.pidfd_send_signal(handle, stop_signal)
            except ProcessLookupError:
                pass
            finally:
                os.close(handle)
        time.sleep(0.15)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--profile", type=Path)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    settings = json.loads((root / "runtime.json").read_text(encoding="utf-8"))
    profile = args.profile or root / "profile"
    profile.mkdir(mode=0o700, parents=True, exist_ok=True)
    model_home = root / "home"
    model_home.mkdir(mode=0o700, exist_ok=True)

    with (profile / ".desktop-launch.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0

        tag = secrets.token_hex(24)
        marker = f"MYMIND_WSL_LAUNCH={tag}".encode()
        with tempfile.TemporaryDirectory(prefix="mymind-wslg-") as runtime:
            env = os.environ.copy()
            for name in ("DBUS_SESSION_BUS_ADDRESS", "MYMIND_SKIP_OLLAMA", "MYMIND_TEST_MODE"):
                env.pop(name, None)
            env.update(
                HOME=str(model_home),
                MYMIND_DATA_DIR=str(profile.resolve()),
                MYMIND_WSL_LAUNCH=tag,
                MYMIND_MODEL="qwen3.5:4b",
                MYMIND_OLLAMA_PATH=settings["ollama"],
                OLLAMA_MODELS=settings["models"],
                XDG_RUNTIME_DIR=runtime,
                GDK_BACKEND="x11",
                WEBKIT_DISABLE_DMABUF_RENDERER="1",
            )
            with (profile / "wsl-launch.log").open("w", encoding="utf-8") as log:
                try:
                    app = subprocess.Popen(
                        ["dbus-run-session", "--", str(root / "bin" / "MYMIND")],
                        cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT,
                    )
                    return app.wait()
                finally:
                    stop_helpers(marker)


if __name__ == "__main__":
    raise SystemExit(main())
