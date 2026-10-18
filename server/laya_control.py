"""Native messaging helper: lets bloomScroll's Settings page start, stop and check the local Laya
model, and turn its start-at-login on or off.

Chrome starts this program when the extension calls chrome.runtime.sendNativeMessage, and only
for the extension IDs listed in the host manifest that setup.sh installs. It understands four
commands and nothing else:

    {"action": "status"}
    {"action": "start"}
    {"action": "stop"}
    {"action": "set-autostart", "enabled": true | false}

Protocol: each message is a 4-byte little-endian length followed by that many bytes of JSON.
Standard library only. Settings (label, port, paths) come from control.json, written by setup.sh.
"""
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "autostart", "control.json")
IS_MAC = sys.platform == "darwin"
SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


def load_config():
    with open(CONFIG) as f:
        cfg = json.load(f)
    cfg.setdefault("port", 8765)
    return cfg


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(length) or b"{}")


def send_message(obj):
    data = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def run(*args):
    return subprocess.run(args, capture_output=True, text=True, env={"PATH": SAFE_PATH})


def healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def listening_pids(port):
    out = run("/usr/sbin/lsof" if IS_MAC else "lsof", "-t", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN").stdout
    return [int(p) for p in out.split() if p.isdigit()]


# ------------------------------------------------------------------ login item (macOS / systemd)

def gui_domain():
    return f"gui/{os.getuid()}"


def mac_installed_plist(cfg):
    return os.path.expanduser(f"~/Library/LaunchAgents/{cfg['label']}.plist")


def mac_loaded(cfg):
    return run("/bin/launchctl", "print", f"{gui_domain()}/{cfg['label']}").returncode == 0


def unit_name(cfg):
    return cfg["label"].replace(".", "-") + ".service"


def unit_path(cfg):
    return os.path.expanduser(f"~/.config/systemd/user/{unit_name(cfg)}")


def systemctl(*args):
    return run("systemctl", "--user", *args)


def autostart_enabled(cfg):
    if IS_MAC:
        return os.path.exists(mac_installed_plist(cfg))
    return systemctl("is-enabled", unit_name(cfg)).stdout.strip() == "enabled"


def set_autostart(cfg, enabled):
    if IS_MAC:
        installed, template = mac_installed_plist(cfg), cfg["plist_template"]
        if enabled:
            os.makedirs(os.path.dirname(installed), exist_ok=True)
            shutil.copyfile(template, installed)
        elif os.path.exists(installed):
            # Leaves a running Laya alone: only the next login is affected.
            os.remove(installed)
    else:
        if enabled:
            os.makedirs(os.path.dirname(unit_path(cfg)), exist_ok=True)
            shutil.copyfile(cfg["unit_template"], unit_path(cfg))
            systemctl("daemon-reload")
            systemctl("enable", unit_name(cfg))
        else:
            systemctl("disable", unit_name(cfg))


# ------------------------------------------------------------------ start / stop

def start(cfg):
    port = cfg["port"]
    if healthy(port):
        return
    if IS_MAC and os.path.exists(cfg.get("plist_template", "")):
        # Load the login item for this session (it runs start.sh). bootstrap fails if it's already
        # loaded, in which case kickstart runs it again.
        if run("/bin/launchctl", "bootstrap", gui_domain(), cfg["plist_template"]).returncode != 0:
            run("/bin/launchctl", "kickstart", f"{gui_domain()}/{cfg['label']}")
        return
    if not IS_MAC and os.path.exists(cfg.get("unit_template", "")):
        if not os.path.exists(unit_path(cfg)):
            os.makedirs(os.path.dirname(unit_path(cfg)), exist_ok=True)
            shutil.copyfile(cfg["unit_template"], unit_path(cfg))
            systemctl("daemon-reload")
        systemctl("start", unit_name(cfg))
        return
    # No login item set up: run start.sh in the background, detached from this helper.
    log = open(os.path.join(HERE, "laya.log"), "ab")
    subprocess.Popen(["/bin/bash", cfg["start_sh"]], stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                     start_new_session=True, env={"PATH": SAFE_PATH, "LAYA_PORT": str(port), "HOME": os.path.expanduser("~")})


def stop(cfg):
    port = cfg["port"]
    if IS_MAC and mac_loaded(cfg):
        # Unloading stops it without the "restart if it crashed" rule kicking in. It comes back at
        # the next login if start-at-login is on, or when Start is pressed.
        run("/bin/launchctl", "bootout", f"{gui_domain()}/{cfg['label']}")
    elif not IS_MAC and systemctl("is-active", unit_name(cfg)).stdout.strip() == "active":
        systemctl("stop", unit_name(cfg))
    for pid in listening_pids(port):  # started by hand, or still shutting down
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for _ in range(40):
        if not healthy(port) and not listening_pids(port):
            return
        time.sleep(0.25)


def status(cfg):
    port = cfg["port"]
    running = healthy(port)
    return {
        "running": running,
        # Process up but model still loading (the first start takes up to a minute).
        "starting": not running and (bool(listening_pids(port)) or (IS_MAC and mac_loaded(cfg))),
        "autostart": autostart_enabled(cfg),
        "port": port,
    }


def handle(msg, cfg):
    action = (msg or {}).get("action")
    if action == "status":
        return status(cfg)
    if action == "start":
        start(cfg)
        return status(cfg)
    if action == "stop":
        stop(cfg)
        return status(cfg)
    if action == "set-autostart":
        set_autostart(cfg, bool(msg.get("enabled")))
        return status(cfg)
    return {"error": f"unknown action: {action!r}"}


def main():
    msg = read_message()
    try:
        reply = handle(msg, load_config())
    except FileNotFoundError:
        reply = {"error": "not-configured", "detail": "Run bash setup.sh to set up the local AI."}
    except Exception as e:  # never leave the extension waiting
        reply = {"error": "failed", "detail": str(e)}
    send_message(reply)


if __name__ == "__main__":
    main()
