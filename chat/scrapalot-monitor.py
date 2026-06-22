#!/usr/bin/env python3
"""
Scrapalot Monitor - Terminal Dashboard for Scrapalot Infrastructure

A htop-like terminal application for monitoring Scrapalot Docker containers.
Shows real-time stats, health status, logs, and alerts.

Usage:
    ./scrapalot-monitor.py          # Run with default refresh (2s)
    ./scrapalot-monitor.py -r 1     # Refresh every 1 second
    ./scrapalot-monitor.py -c 5     # Show last 5 log lines per container
    ./scrapalot-monitor.py --compact # Force compact mode for narrow terminals
"""

import argparse
from datetime import datetime
import json
import os
import select
import subprocess
import sys
import termios
import threading
import time
import tty
from typing import Any

try:
    from rich.console import Console
    from rich.layout import Layout
    from rich.live import Live
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text
except ImportError:
    Console = None
    Layout = None
    Live = None
    Panel = None
    Table = None
    Text = None
    print("Error: 'rich' library not found. Install with: sudo apt install python3-rich")
    sys.exit(1)


# Scrapalot containers to monitor
SCRAPALOT_CONTAINERS = [
    "scrapalot-chat",
    "scrapalot-ui",
    "scrapalot-backend",
    "scrapalot-gw",
    "pgvector",
    "neo4j",
    "redis",
    "nginx-proxy-manager",
    "portainer",
]

# Short names for compact mode
CONTAINER_SHORT_NAMES = {
    "scrapalot-chat": "chat",
    "scrapalot-ui": "ui",
    "scrapalot-backend": "be",
    "scrapalot-gw": "gw",
    "pgvector": "pgvec",
    "neo4j": "neo4j",
    "redis": "redis",
    "nginx-proxy-manager": "nginx",
    "portainer": "port",
}

# Resource thresholds for alerts
THRESHOLDS = {
    "cpu_warning": 70.0,
    "cpu_critical": 90.0,
    "memory_warning": 80.0,
    "memory_critical": 95.0,
    "dockerd_cpu_warning": 50.0,
    "dockerd_cpu_critical": 100.0,
    "load_warning": 4.0,  # per CPU core
    "load_critical": 8.0,
}

console = Console()

# Global cache for expensive operations
_cache = {
    "disk_breakdown": {"data": None, "timestamp": 0, "loading": False},
    "disk_partitions": {"data": None, "timestamp": 0, "loading": False},
}
_cache_lock = threading.Lock()

# Global render stage tracker (for progressive loading)
_render_stage = {"current": 0, "max": 6}
_render_lock = threading.Lock()

# Global tab state
_current_tab = {"index": 0, "names": ["Overview", "Environment", "Logs", "Network"]}
_tab_lock = threading.Lock()


def get_cached_data(key: str, fetch_func, cache_ttl: int = 30) -> Any | None:
    """
    Get data from cache or fetch in background thread.

    Args:
        key: Cache key
        fetch_func: Function to fetch data if cache expired
        cache_ttl: Cache time-to-live in seconds

    Returns:
        Cached data or None if still loading
    """
    with _cache_lock:
        cache_entry = _cache.get(key)
        if not cache_entry:
            return None

        current_time = time.time()

        # Return cached data if still valid
        # noinspection PyTypeChecker
        if cache_entry["data"] is not None and (current_time - cache_entry["timestamp"]) < cache_ttl:
            return cache_entry["data"]

        # Start background fetch if not already loading
        if not cache_entry["loading"]:
            cache_entry["loading"] = True

            def fetch_and_cache():
                # noinspection PyBroadException
                try:
                    data = fetch_func()
                    with _cache_lock:
                        _cache[key]["data"] = data
                        # noinspection PyTypeChecker
                        _cache[key]["timestamp"] = time.time()
                        _cache[key]["loading"] = False
                except Exception:
                    with _cache_lock:
                        _cache[key]["loading"] = False

            thread = threading.Thread(target=fetch_and_cache, daemon=True)
            thread.start()

        # Return cached data (even if expired) or None if never fetched
        return cache_entry["data"]


def get_keypress(timeout: float = 0.0) -> str | None:
    """
    Non-blocking keyboard input reader.

    Args:
        timeout: How long to wait for input (0.0 = don't wait)

    Returns:
        Key pressed or None if no input
    """
    # Check if input is available
    if select.select([sys.stdin], [], [], timeout)[0]:
        return sys.stdin.read(1)
    return None


def create_loading_panel(title: str, border_style: str = "dim", height: int = 8) -> Panel:
    """Create a loading placeholder panel."""
    loading_text = Text()
    loading_text.append("⏳ ", style="yellow dim")
    loading_text.append("Loading", style="cyan dim")
    loading_text.append("...", style="dim")
    return Panel(loading_text, title=f"[bold dim]{title}[/bold dim]", border_style=border_style, height=height)


def get_terminal_width() -> int:
    """Get terminal width, with fallback."""
    try:
        return os.get_terminal_size().columns
    except OSError:
        return 80


def is_compact_mode(force_compact: bool = False) -> bool:
    """Determine if we should use compact mode based on terminal width."""
    if force_compact:
        return True
    return get_terminal_width() < 100


def run_command(cmd: list[str], timeout: int = 5) -> tuple[str, int]:
    """Run a shell command and return output and return code."""
    # noinspection PyBroadException
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.stdout.strip(), result.returncode
    except subprocess.TimeoutExpired:
        return "", 1
    except Exception as e:
        return str(e), 1


def get_container_stats() -> dict[str, dict]:
    """Get Docker container statistics."""
    stats = {}

    cmd = [
        "docker",
        "stats",
        "--no-stream",
        "--format",
        '{"name":"{{.Name}}","cpu":"{{.CPUPerc}}","memory":"{{.MemPerc}}","mem_usage":"{{.MemUsage}}","net_io":"{{.NetIO}}","block_io":"{{.BlockIO}}","pids":"{{.PIDs}}"}',
    ]

    output, rc = run_command(cmd, timeout=10)
    if rc != 0:
        return stats

    for line in output.split("\n"):
        if not line.strip():
            continue
        try:
            data = json.loads(line)
            name = data["name"]
            if name in SCRAPALOT_CONTAINERS:
                cpu_str = data["cpu"].replace("%", "")
                mem_str = data["memory"].replace("%", "")

                stats[name] = {
                    "cpu": float(cpu_str) if cpu_str else 0.0,
                    "memory": float(mem_str) if mem_str else 0.0,
                    "mem_usage": data["mem_usage"],
                    "net_io": data["net_io"],
                    "block_io": data["block_io"],
                    "pids": data["pids"],
                }
        except (json.JSONDecodeError, ValueError, KeyError):
            continue

    return stats


def get_container_health() -> dict[str, dict]:
    """Get container health and status information."""
    health = {}

    cmd = ["docker", "ps", "-a", "--format", '{"name":"{{.Names}}","status":"{{.Status}}","state":"{{.State}}","ports":"{{.Ports}}"}']

    output, rc = run_command(cmd)
    if rc != 0:
        return health

    for line in output.split("\n"):
        if not line.strip():
            continue
        try:
            data = json.loads(line)
            name = data["name"]
            if name in SCRAPALOT_CONTAINERS:
                status = data["status"]
                state = data["state"]

                if "healthy" in status.lower():
                    health_status = "healthy"
                elif "unhealthy" in status.lower():
                    health_status = "unhealthy"
                elif state == "running":
                    health_status = "running"
                else:
                    health_status = "stopped"

                health[name] = {
                    "status": status,
                    "state": state,
                    "health": health_status,
                    "ports": data["ports"][:50] if data["ports"] else "-",
                }
        except (json.JSONDecodeError, KeyError):
            continue

    return health


def get_container_env(container: str) -> dict:
    """Get environment variables from a container."""
    env_vars = {}

    # noinspection PyBroadException
    try:
        result = subprocess.run(
            ["docker", "inspect", container, "--format", "{{json .Config.Env}}"],
            capture_output=True,
            text=True,
            timeout=3,
        )

        if result.returncode == 0 and result.stdout.strip():
            env_list = json.loads(result.stdout.strip())

            # Parse KEY=VALUE format and filter relevant variables
            relevant_prefixes = [
                "PYTHON",
                "NODE",
                "JAVA",
                "KOTLIN",
                "DATABASE",
                "REDIS",
                "NEO4J",
                "OPENAI",
                "ANTHROPIC",
                "GOOGLE",
                "OLLAMA",
                "ENVIRONMENT",
                "DEBUG",
                "PORT",
                "HOST",
                "API_",
                "APP_",
                "SERVICE_",
            ]

            for env_item in env_list:
                if "=" in env_item:
                    key, value = env_item.split("=", 1)

                    # Only include relevant variables
                    if any(key.startswith(prefix) for prefix in relevant_prefixes):
                        # Mask sensitive data (API keys, tokens, passwords)
                        if any(sensitive in key.upper() for sensitive in ["KEY", "TOKEN", "PASSWORD", "SECRET"]):
                            if value:
                                env_vars[key] = value[:4] + "..." + value[-4:] if len(value) > 8 else "***"
                            else:
                                env_vars[key] = "(empty)"
                        else:
                            env_vars[key] = value[:50] if len(value) > 50 else value

    except Exception:
        pass

    return env_vars


def get_container_logs(container: str, lines: int = 3) -> list[str]:
    """Get recent log lines from a container."""
    try:
        # scrapalot-chat logs to file, not stdout - read from app log file
        if container == "scrapalot-chat":
            result = subprocess.run(
                ["docker", "exec", container, "tail", "-n", str(lines), "/app/data/logs/scrapalot.log"],
                capture_output=True,
                text=True,
                timeout=3,
            )
        else:
            # For other containers, try docker logs
            result = subprocess.run(
                ["docker", "logs", "--tail", str(lines), container],
                capture_output=True,
                text=True,
                timeout=3,
            )
        output = result.stdout + result.stderr
        if result.returncode != 0 and not output.strip():
            return []
    except (subprocess.TimeoutExpired, Exception):
        return []

    logs = []
    for line in output.split("\n")[-lines:]:
        clean_line = line
        for code in [
            "\x1b[0m",
            "\x1b[1m",
            "\x1b[31m",
            "\x1b[32m",
            "\x1b[33m",
            "\x1b[34m",
            "\x1b[35m",
            "\x1b[36m",
            "\x1b[37m",
            "\x1b[90m",
            "\x1b[91m",
            "\x1b[92m",
            "\x1b[93m",
            "\x1b[94m",
            "\x1b[95m",
            "\x1b[96m",
            "\x1b[97m",
            "\x1b[38;5;208m",
        ]:
            clean_line = clean_line.replace(code, "")

        if clean_line.strip():
            max_len = 80 if is_compact_mode() else 180
            logs.append(clean_line[:max_len] + "..." if len(clean_line) > max_len else clean_line)

    return logs


def get_system_stats() -> dict:
    """Get overall system statistics."""
    stats = {}

    # noinspection PyBroadException
    try:
        with open("/proc/stat") as f:
            line = f.readline()
            parts = line.split()
            idle = int(parts[4])
            total = sum(int(x) for x in parts[1:])
            stats["cpu_idle"] = idle
            stats["cpu_total"] = total
    except Exception:
        pass

    # noinspection PyBroadException
    try:
        with open("/proc/meminfo") as f:
            meminfo = {}
            for line in f:
                parts = line.split()
                key = parts[0].rstrip(":")
                value = int(parts[1])
                meminfo[key] = value

            total = meminfo.get("MemTotal", 1)
            available = meminfo.get("MemAvailable", 0)
            used = total - available
            stats["mem_total_gb"] = total / 1024 / 1024
            stats["mem_used_gb"] = used / 1024 / 1024
            stats["mem_percent"] = (used / total) * 100
    except Exception:
        pass

    # noinspection PyBroadException
    try:
        result = subprocess.run(
            ["df", "-h", "/"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode == 0:
            lines = result.stdout.strip().split("\n")
            if len(lines) > 1:
                parts = lines[1].split()
                stats["disk_total"] = parts[1]
                stats["disk_used"] = parts[2]
                stats["disk_percent"] = float(parts[4].replace("%", ""))
    except Exception:
        pass

    return stats


def get_dockerd_stats() -> dict:
    """Get Docker daemon CPU and memory usage."""
    stats = {"cpu": 0.0, "memory": 0.0, "threads": 0, "uptime": "unknown"}

    try:
        # Find dockerd PID and get stats
        cmd = ["ps", "-C", "dockerd", "-o", "pid,%cpu,%mem,nlwp,etime", "--no-headers"]
        output, rc = run_command(cmd, timeout=3)

        if rc == 0 and output.strip():
            parts = output.split()
            if len(parts) >= 5:
                stats["pid"] = int(parts[0])
                stats["cpu"] = float(parts[1])
                stats["memory"] = float(parts[2])
                stats["threads"] = int(parts[3])
                stats["uptime"] = parts[4]
    except (ValueError, IndexError):
        pass

    return stats


def parse_docker_size(size_str: str) -> int:
    """Parse Docker size string (e.g., '4.565GB') to bytes."""
    if not size_str or size_str == "-":
        return 0

    size_str = size_str.strip().upper()
    if size_str == "0B" or size_str == "0":
        return 0

    multipliers = {
        "B": 1,
        "KB": 1024,
        "MB": 1024**2,
        "GB": 1024**3,
        "TB": 1024**4,
    }

    for unit, mult in multipliers.items():
        if size_str.endswith(unit):
            try:
                value = float(size_str[: -len(unit)])
                return int(value * mult)
            except ValueError:
                return 0

    return 0


def get_load_average() -> tuple[float, float, float, int]:
    """Get system load average and CPU count."""
    # noinspection PyBroadException
    try:
        with open("/proc/loadavg") as f:
            parts = f.readline().split()
            load1 = float(parts[0])
            load5 = float(parts[1])
            load15 = float(parts[2])

        # Get CPU count
        cpu_count = 1
        with open("/proc/cpuinfo") as f:
            cpu_count = sum(1 for line in f if line.startswith("processor"))

        return load1, load5, load15, cpu_count
    except Exception:
        return 0.0, 0.0, 0.0, 1


def get_network_connections() -> list[dict]:
    """Get detailed network connections."""
    connections = []

    # noinspection PyBroadException
    try:
        cmd = ["ss", "-tuanp"]
        output, rc = run_command(cmd, timeout=3)
        if rc == 0:
            lines = output.split("\n")[1:]  # Skip header
            for line in lines[:30]:  # Limit to 30 connections
                if not line.strip():
                    continue
                parts = line.split()
                if len(parts) >= 5:
                    connections.append(
                        {
                            "proto": parts[0],
                            "state": parts[1] if len(parts) > 1 else "-",
                            "local": parts[4] if len(parts) > 4 else "-",
                            "peer": parts[5] if len(parts) > 5 else "-",
                        }
                    )
    except Exception:
        pass

    return connections


def create_network_detail_view(net_stats: dict = None) -> Panel:
    """Create detailed network view (Tab 4)."""
    if not net_stats:
        return create_loading_panel("Network Connections", "green", height=30)

    connections = get_network_connections()

    table = Table(show_header=True, header_style="bold cyan", box=None, expand=True)
    table.add_column("Protocol", style="cyan", width=8)
    table.add_column("State", style="white", width=12)
    table.add_column("Local Address", style="white", width=30)
    table.add_column("Peer Address", style="dim", width=30)

    for conn in connections[:25]:  # Show top 25
        state_style = "green" if conn["state"] == "ESTAB" else "yellow" if conn["state"] == "LISTEN" else "dim"
        table.add_row(conn["proto"], f"[{state_style}]{conn['state']}[/{state_style}]", conn["local"][:30], conn["peer"][:30])

    # Summary at bottom
    summary_text = Text()
    summary_text.append(f"\nTotal Connections: {len(connections)}", style="cyan")
    if net_stats:
        rx = format_bytes(net_stats.get("rx_bytes", 0))
        tx = format_bytes(net_stats.get("tx_bytes", 0))
        summary_text.append(f" | RX: {rx} | TX: {tx}", style="dim")

    return Panel(table, title="[bold]Network Connections[/bold]", subtitle=summary_text, border_style="green")


def get_network_stats() -> dict:
    """Get network interface statistics and connection info."""
    stats = {"rx_bytes": 0, "tx_bytes": 0, "connections": 0, "blocked": 0}

    # noinspection PyBroadException
    try:
        # Get eth0 stats
        with open("/proc/net/dev") as f:
            for line in f:
                if "eth0:" in line:
                    parts = line.split()
                    stats["rx_bytes"] = int(parts[1])
                    stats["tx_bytes"] = int(parts[9])
                    break
    except Exception:
        pass

    # Get active connections count
    # noinspection PyBroadException
    try:
        cmd = ["ss", "-tuanp", "--no-header"]
        output, rc = run_command(cmd, timeout=3)
        if rc == 0:
            stats["connections"] = len([line for line in output.split("\n") if line.strip()])
    except Exception:
        pass

    # Get blocked packets count from iptables (port scanning detection)
    # noinspection PyBroadException
    try:
        cmd = ["iptables", "-L", "INPUT", "-v", "-n", "--line-numbers"]
        output, rc = run_command(cmd, timeout=3)
        if rc == 0:
            for line in output.split("\n"):
                if "DROP" in line and "policy" not in line:
                    parts = line.split()
                    for i, part in enumerate(parts):
                        if part.isdigit() and i > 0:
                            stats["blocked"] += int(parts[i])
                            break
    except Exception:
        pass

    return stats


def get_disk_partitions() -> list[dict]:
    """Get all mounted disk partitions."""
    partitions = []

    # noinspection PyBroadException
    try:
        result = subprocess.run(
            ["df", "-h"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if result.returncode == 0:
            lines = result.stdout.strip().split("\n")[1:]  # Skip header
            for line in lines:
                parts = line.split()
                if len(parts) >= 6 and parts[0].startswith("/dev/"):
                    # Filter out small boot partitions and focus on main storage
                    filesystem = parts[0]
                    size = parts[1]
                    used = parts[2]
                    avail = parts[3]
                    percent = float(parts[4].replace("%", ""))
                    mount = parts[5]

                    partitions.append(
                        {
                            "filesystem": filesystem,
                            "size": size,
                            "used": used,
                            "available": avail,
                            "percent": percent,
                            "mount": mount,
                        }
                    )
    except Exception:
        pass  # Silently ignore errors, return empty list

    return partitions


def get_disk_breakdown() -> dict:
    """Get detailed disk space breakdown for Docker and Hetzner volume."""
    breakdown = {
        "overlay2_size": 0,
        "build_cache_size": 0,
        "volumes": {},
        "hetzner_mount": "/mnt/volume-nbg1-1",
    }

    # Docker overlay2 size (image layers)
    # noinspection PyBroadException
    try:
        # Try without sudo first, then with sudo
        cmd = ["du", "-sb", "/var/lib/docker/overlay2"]
        output, rc = run_command(cmd, timeout=15)
        if rc != 0:
            # Try with sudo
            cmd = ["sudo", "du", "-sb", "/var/lib/docker/overlay2"]
            output, rc = run_command(cmd, timeout=15)

        if rc == 0 and output:
            parts = output.split()
            if parts:
                breakdown["overlay2_size"] = int(parts[0])
    except Exception:
        pass

    # Docker build cache size
    # noinspection PyBroadException
    try:
        cmd = ["docker", "system", "df", "--format", "json"]
        output, rc = run_command(cmd, timeout=5)
        if rc == 0 and output:
            try:
                # Parse JSON array
                lines = output.strip().split("\n")
                for line in lines:
                    if not line.strip():
                        continue
                    data = json.loads(line)
                    if data.get("Type") == "Build Cache":
                        size_str = data.get("Size", "0B")
                        breakdown["build_cache_size"] = parse_docker_size(size_str)
                        break
            except json.JSONDecodeError:
                pass
    except Exception:
        pass

    # Hetzner volume breakdown (Docker volumes)
    # Try to get volume sizes from the mounted Hetzner volume
    # noinspection PyTypeChecker
    if os.path.exists(breakdown["hetzner_mount"]):
        # noinspection PyBroadException
        try:
            # List all directories in the Hetzner mount that match Docker volumes
            # noinspection PyTypeChecker
            cmd = ["sudo", "ls", "-1", breakdown["hetzner_mount"]]
            # noinspection PyTypeChecker
            output, rc = run_command(cmd, timeout=5)
            if rc == 0:
                for item in output.split("\n"):
                    if not item.strip() or not item.startswith("docker-"):
                        continue

                    # Get size of this volume
                    # noinspection PyTypeChecker
                    volume_path = os.path.join(breakdown["hetzner_mount"], item)
                    # noinspection PyTypeChecker
                    cmd = ["sudo", "du", "-sb", volume_path]
                    # noinspection PyTypeChecker
                    size_output, size_rc = run_command(cmd, timeout=10)
                    if size_rc == 0 and size_output:
                        parts = size_output.split()
                        if parts:
                            # Extract volume name (remove "docker-" prefix)
                            volume_name = item.replace("docker-", "").replace("scrapalot_", "")
                            breakdown["volumes"][volume_name] = int(parts[0])
        except Exception:
            pass

    return breakdown


def format_bytes(bytes_val: int) -> str:
    """Format bytes to a human-readable string."""
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if bytes_val < 1024:
            return f"{bytes_val:.1f}{unit}"
        # noinspection PyTypeChecker
        bytes_val /= 1024
    return f"{bytes_val:.1f}PB"


def create_header_compact() -> Panel:
    """Create compact header for narrow terminals."""
    now = datetime.now().strftime("%H:%M:%S")
    header_text = Text()
    header_text.append("SCRAPALOT", style="bold cyan")
    header_text.append(f" {now}", style="yellow")
    return Panel(header_text, style="blue", height=3)


def create_header() -> Panel:
    """Create the header panel with tab indicators."""
    if is_compact_mode():
        return create_header_compact()

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    header_text = Text()
    header_text.append("SCRAPALOT MONITOR", style="bold cyan")
    header_text.append(" | ", style="dim")

    # Tab indicators
    with _tab_lock:
        current_idx = _current_tab["index"]
        tab_names = _current_tab["names"]

    # noinspection PyTypeChecker
    for i, tab_name in enumerate(tab_names):
        if i == current_idx:
            header_text.append(f" [{i + 1}]{tab_name} ", style="bold green")
        else:
            header_text.append(f" [{i + 1}]{tab_name} ", style="dim")

    header_text.append("| ", style="dim")
    header_text.append(f"{now}", style="yellow")
    header_text.append(" | ", style="dim")
    header_text.append("1-4: Tabs | q: Quit", style="dim italic")

    return Panel(header_text, style="blue", height=3)


def create_system_panel_compact(sys_stats: dict) -> Panel:
    """Create compact system panel."""
    mem_pct = sys_stats.get("mem_percent", 0)
    mem_style = "green" if mem_pct < 70 else "yellow" if mem_pct < 90 else "red"

    disk_pct = sys_stats.get("disk_percent", 0)
    disk_style = "green" if disk_pct < 70 else "yellow" if disk_pct < 90 else "red"

    content = Text()
    content.append(f"MEM [{mem_style}]{mem_pct:.0f}%[/{mem_style}] ", style="white")
    content.append(f"DISK [{disk_style}]{disk_pct:.0f}%[/{disk_style}]", style="white")

    return Panel(content, title="[bold]Sys[/bold]", border_style="blue", height=3)


def create_system_panel(sys_stats: dict, dockerd_stats: dict = None, load_avg: tuple = None, net_stats: dict = None) -> Panel:
    """Create system overview panel with infrastructure metrics."""
    if is_compact_mode():
        return create_system_panel_compact(sys_stats)

    table = Table(show_header=False, box=None, padding=(0, 1))
    table.add_column("Metric", style="cyan", width=8)
    table.add_column("Value", style="white")

    # Memory
    mem_pct = sys_stats.get("mem_percent", 0)
    mem_style = "green" if mem_pct < 70 else "yellow" if mem_pct < 90 else "red"
    table.add_row("Mem", f"[{mem_style}]{sys_stats.get('mem_used_gb', 0):.1f}/{sys_stats.get('mem_total_gb', 0):.1f}G ({mem_pct:.0f}%)[/{mem_style}]")

    # Disk
    disk_pct = sys_stats.get("disk_percent", 0)
    disk_style = "green" if disk_pct < 70 else "yellow" if disk_pct < 90 else "red"
    table.add_row("Disk", f"[{disk_style}]{sys_stats.get('disk_used', '?')}/{sys_stats.get('disk_total', '?')} ({disk_pct:.0f}%)[/{disk_style}]")

    # Load average
    if load_avg:
        load1, load5, load15, cpu_count = load_avg
        load_per_cpu = load1 / cpu_count if cpu_count > 0 else load1
        load_style = "green" if load_per_cpu < 0.7 else "yellow" if load_per_cpu < 1.0 else "red"
        table.add_row("Load", f"[{load_style}]{load1:.2f} {load5:.2f} {load15:.2f}[/{load_style}] ({cpu_count} CPUs)")

    # Docker daemon
    if dockerd_stats:
        dockerd_cpu = dockerd_stats.get("cpu", 0)
        dockerd_style = "green"
        if dockerd_cpu >= THRESHOLDS["dockerd_cpu_critical"]:
            dockerd_style = "red bold"
        elif dockerd_cpu >= THRESHOLDS["dockerd_cpu_warning"]:
            dockerd_style = "yellow"
        table.add_row("Dockerd", f"[{dockerd_style}]CPU:{dockerd_cpu:.0f}%[/{dockerd_style}] Threads:{dockerd_stats.get('threads', 0)}")

    # Network
    if net_stats:
        rx = format_bytes(net_stats.get("rx_bytes", 0))
        tx = format_bytes(net_stats.get("tx_bytes", 0))
        conns = net_stats.get("connections", 0)
        table.add_row("Net", f"RX:{rx} TX:{tx} Conns:{conns}")

    return Panel(table, title="[bold]System[/bold]", border_style="blue", height=8)


def create_disk_panel(disk_breakdown: dict | None = None, partitions: list[dict] | None = None) -> Panel:
    """Create disk space breakdown panel."""
    table = Table(show_header=True, header_style="bold cyan", box=None, padding=(0, 1))
    table.add_column("Component", style="white", width=14)
    table.add_column("Size", justify="right", style="white", width=10)

    # Show loading message if no data yet
    if not partitions and not disk_breakdown:
        loading_text = Text()
        loading_text.append("⏳ ", style="yellow")
        loading_text.append("Analyzing disk usage", style="cyan")
        loading_text.append("...\n\n", style="dim")
        loading_text.append("• Scanning partitions\n", style="dim")
        loading_text.append("• Reading Docker volumes\n", style="dim")
        loading_text.append("• Calculating sizes", style="dim")
        return Panel(loading_text, title="[bold]Disk Breakdown[/bold]", border_style="magenta", height=12)

    # Disk Partitions (if provided)
    if partitions:
        for part in partitions:
            mount = part["mount"]
            used = part["used"]
            size = part["size"]
            percent = part["percent"]

            # Color code by percentage
            if percent < 70:
                style = "green"
            elif percent < 85:
                style = "yellow"
            else:
                style = "red"

            # Shorten mount point for display
            display_mount = mount if len(mount) <= 14 else "..." + mount[-11:]
            table.add_row(display_mount, f"[{style}]{used}/{size} ({percent:.0f}%)[/{style}]")

    # Root Disk Components
    overlay2_size = disk_breakdown.get("overlay2_size", 0)
    if overlay2_size > 0:
        table.add_row("Docker Layers", format_bytes(overlay2_size))

    build_cache = disk_breakdown.get("build_cache_size", 0)
    if build_cache > 0:
        table.add_row("Build Cache", format_bytes(build_cache))

    # Hetzner Volume Components (show top volumes by size)
    volumes = disk_breakdown.get("volumes", {})
    if volumes:
        # Sort by size descending and take top 6
        sorted_volumes = sorted(volumes.items(), key=lambda x: x[1], reverse=True)[:6]

        for vol_name, vol_size in sorted_volumes:
            # Shorten volume name for display
            display_name = vol_name.replace("_data", "").replace("_", " ")[:14]
            size_str = format_bytes(vol_size)

            # Color code by size (green < 1GB, yellow < 5GB, red >= 5GB)
            if vol_size < 1024**3:  # < 1GB
                style = "green"
            elif vol_size < 5 * 1024**3:  # < 5GB
                style = "yellow"
            else:
                style = "red"

            table.add_row(display_name, f"[{style}]{size_str}[/{style}]")

    if not overlay2_size and not build_cache and not volumes:
        table.add_row("No data", "-")

    return Panel(table, title="[bold]Disk Breakdown[/bold]", border_style="magenta", height=12)


def create_containers_table_compact(stats: dict[str, dict], health: dict[str, dict]) -> Panel:
    """Create compact containers table for narrow terminals."""
    # Show loading indicator if no data yet
    if not stats or not health:
        loading_text = Text()
        loading_text.append("⏳ ", style="yellow")
        loading_text.append("Loading...", style="cyan dim")
        return Panel(loading_text, title="[bold]Containers[/bold]", border_style="green", height=8)

    table = Table(show_header=True, header_style="bold cyan", expand=True, box=None)

    table.add_column("Name", style="white", no_wrap=True)
    table.add_column("St", justify="center", width=2)
    table.add_column("CPU", justify="right", width=5)
    table.add_column("MEM", justify="right", width=5)

    for container in SCRAPALOT_CONTAINERS:
        container_stats = stats.get(container, {})
        container_health = health.get(container, {})

        # Short name
        short_name = CONTAINER_SHORT_NAMES.get(container, container[:5])

        # Health status icon
        health_status = container_health.get("health", "unknown")
        if health_status == "healthy":
            status_icon = Text("✓", style="green")
        elif health_status == "running":
            status_icon = Text("●", style="cyan")
        elif health_status == "unhealthy":
            status_icon = Text("✗", style="red bold")
        else:
            status_icon = Text("○", style="red dim")

        # CPU
        cpu = container_stats.get("cpu", 0)
        if cpu >= THRESHOLDS["cpu_critical"]:
            cpu_text = Text(f"{cpu:.0f}%", style="red bold")
        elif cpu >= THRESHOLDS["cpu_warning"]:
            cpu_text = Text(f"{cpu:.0f}%", style="yellow")
        else:
            cpu_text = Text(f"{cpu:.0f}%", style="green")

        # Memory
        mem = container_stats.get("memory", 0)
        if mem >= THRESHOLDS["memory_critical"]:
            mem_text = Text(f"{mem:.0f}%", style="red bold")
        elif mem >= THRESHOLDS["memory_warning"]:
            mem_text = Text(f"{mem:.0f}%", style="yellow")
        else:
            mem_text = Text(f"{mem:.0f}%", style="green")

        table.add_row(short_name, status_icon, cpu_text, mem_text)

    return Panel(table, title="[bold]Containers[/bold]", border_style="green")


def create_containers_table(stats: dict[str, dict], health: dict[str, dict]) -> Panel:
    """Create the main containers statistics table."""
    if is_compact_mode():
        return create_containers_table_compact(stats, health)

    # Show loading indicator if no data yet
    if not stats or not health:
        loading_text = Text()
        loading_text.append("⏳ ", style="yellow")
        loading_text.append("Loading container metrics", style="cyan")
        loading_text.append("...", style="dim")
        return Panel(loading_text, title="[bold]Containers[/bold]", border_style="green", height=10)

    table = Table(show_header=True, header_style="bold cyan", expand=True)

    table.add_column("Container", style="white", width=18)
    table.add_column("Status", justify="center", width=8)
    table.add_column("CPU", justify="right", width=6)
    table.add_column("MEM", justify="right", width=6)
    table.add_column("Usage", justify="right", width=14)
    table.add_column("Net", justify="right", width=14)

    for container in SCRAPALOT_CONTAINERS:
        container_stats = stats.get(container, {})
        container_health = health.get(container, {})

        # Shorten container name if needed
        display_name = container[:18]

        health_status = container_health.get("health", "unknown")
        if health_status == "healthy":
            status_text = Text("OK", style="green")
        elif health_status == "running":
            status_text = Text("run", style="cyan")
        elif health_status == "unhealthy":
            status_text = Text("BAD", style="red bold")
        else:
            status_text = Text("stop", style="red dim")

        cpu = container_stats.get("cpu", 0)
        if cpu >= THRESHOLDS["cpu_critical"]:
            cpu_text = Text(f"{cpu:.0f}%", style="red bold")
        elif cpu >= THRESHOLDS["cpu_warning"]:
            cpu_text = Text(f"{cpu:.0f}%", style="yellow")
        else:
            cpu_text = Text(f"{cpu:.0f}%", style="green")

        mem = container_stats.get("memory", 0)
        if mem >= THRESHOLDS["memory_critical"]:
            mem_text = Text(f"{mem:.0f}%", style="red bold")
        elif mem >= THRESHOLDS["memory_warning"]:
            mem_text = Text(f"{mem:.0f}%", style="yellow")
        else:
            mem_text = Text(f"{mem:.0f}%", style="green")

        # Shorten mem_usage
        mem_usage = container_stats.get("mem_usage", "-")
        if "/" in mem_usage:
            parts = mem_usage.split("/")
            mem_usage = parts[0].strip()

        # Shorten net_io
        net_io = container_stats.get("net_io", "-")
        if "/" in net_io:
            parts = net_io.split("/")
            net_io = f"{parts[0].strip()}"

        table.add_row(display_name, status_text, cpu_text, mem_text, mem_usage, net_io)

    return Panel(table, title="[bold]Containers[/bold]", border_style="green")


def create_alerts_panel_compact(stats: dict[str, dict], health: dict[str, dict]) -> Panel:
    """Create compact alerts panel."""
    alerts = []

    for container in SCRAPALOT_CONTAINERS:
        container_stats = stats.get(container, {})
        container_health = health.get(container, {})
        short = CONTAINER_SHORT_NAMES.get(container, container[:5])

        if container_health.get("health") == "unhealthy":
            alerts.append(f"[red]!{short}[/red]")
        elif container_health.get("health") == "stopped":
            alerts.append(f"[red dim]X{short}[/red dim]")

        cpu = container_stats.get("cpu", 0)
        if cpu >= THRESHOLDS["cpu_critical"]:
            alerts.append(f"[red]C:{short}[/red]")

        mem = container_stats.get("memory", 0)
        if mem >= THRESHOLDS["memory_critical"]:
            alerts.append(f"[red]M:{short}[/red]")

    if not alerts:
        content = Text("All OK", style="green bold")
    else:
        content = Text(" ".join(alerts[:4]))

    return Panel(content, title="[bold]Alert[/bold]", border_style="yellow", height=3)


def create_alerts_panel(stats: dict[str, dict], health: dict[str, dict], dockerd_stats: dict = None, load_avg: tuple = None) -> Panel:
    """Create alerts panel for containers and infrastructure issues."""
    if is_compact_mode():
        return create_alerts_panel_compact(stats, health)

    alerts = []

    # Docker daemon alerts (critical infrastructure)
    if dockerd_stats:
        dockerd_cpu = dockerd_stats.get("cpu", 0)
        if dockerd_cpu >= THRESHOLDS["dockerd_cpu_critical"]:
            alerts.append(f"[red bold]DOCKERD CPU[/red bold] {dockerd_cpu:.0f}% - restart recommended!")
        elif dockerd_cpu >= THRESHOLDS["dockerd_cpu_warning"]:
            alerts.append(f"[yellow]DOCKERD CPU[/yellow] {dockerd_cpu:.0f}% - monitor closely")

    # Load average alerts
    if load_avg:
        load1, load5, load15, cpu_count = load_avg
        load_per_cpu = load1 / cpu_count if cpu_count > 0 else load1
        if load_per_cpu >= 1.5:
            alerts.append(f"[red bold]HIGH LOAD[/red bold] {load1:.1f} ({load_per_cpu:.1f}/CPU)")
        elif load_per_cpu >= 1.0:
            alerts.append(f"[yellow]LOAD WARN[/yellow] {load1:.1f} ({load_per_cpu:.1f}/CPU)")

    # Container alerts
    for container in SCRAPALOT_CONTAINERS:
        container_stats = stats.get(container, {})
        container_health = health.get(container, {})

        if container_health.get("health") == "unhealthy":
            alerts.append(f"[red bold]UNHEALTHY[/red bold] {container}")
        elif container_health.get("health") == "stopped":
            alerts.append(f"[red]STOPPED[/red] {container}")

        cpu = container_stats.get("cpu", 0)
        if cpu >= THRESHOLDS["cpu_critical"]:
            alerts.append(f"[red bold]HIGH CPU[/red bold] {container}: {cpu:.0f}%")
        elif cpu >= THRESHOLDS["cpu_warning"]:
            alerts.append(f"[yellow]CPU WARN[/yellow] {container}: {cpu:.0f}%")

        mem = container_stats.get("memory", 0)
        if mem >= THRESHOLDS["memory_critical"]:
            alerts.append(f"[red bold]HIGH MEM[/red bold] {container}: {mem:.0f}%")
        elif mem >= THRESHOLDS["memory_warning"]:
            alerts.append(f"[yellow]MEM WARN[/yellow] {container}: {mem:.0f}%")

    if not alerts:
        content = Text("All systems operational", style="green bold")
    else:
        content = Text()
        for i, alert in enumerate(alerts[:6]):
            if i > 0:
                content.append("\n")
            content.append_text(Text.from_markup(alert))

    return Panel(content, title="[bold]Alerts[/bold]", border_style="yellow", height=9)


def create_logs_panel_compact(log_lines: int = 2) -> Panel:
    """Create compact logs panel for scrapalot-chat."""
    content = Text()
    # Show more lines in compact mode too
    actual_lines = log_lines * 2
    logs = get_container_logs("scrapalot-chat", actual_lines)

    if logs:
        for log in logs:
            content.append(f"{log[:80]}...\n" if len(log) > 80 else f"{log}\n", style="dim")
    else:
        content.append("(no logs)\n", style="dim italic")

    return Panel(content, title="[bold]Logs[/bold]", border_style="magenta", height=7)


def create_env_detail_view(chat_env: dict = None, backend_env: dict = None) -> Panel:
    """Create detailed environment variables view (Tab 2)."""
    if not chat_env and not backend_env:
        return create_loading_panel("Environment Variables", "cyan", height=30)

    table = Table(show_header=True, header_style="bold cyan", box=None, expand=True)
    table.add_column("Container", style="white", width=15)
    table.add_column("Variable", style="cyan", width=25)
    table.add_column("Value", style="white")

    # scrapalot-chat env (all variables)
    if chat_env:
        for i, (key, value) in enumerate(sorted(chat_env.items())):
            table.add_row("scrapalot-chat" if i == 0 else "", key, f"[dim]{value}[/dim]")

    # Empty row separator
    if chat_env and backend_env:
        table.add_row("", "", "")

    # scrapalot-backend env (all variables)
    if backend_env:
        for i, (key, value) in enumerate(sorted(backend_env.items())):
            table.add_row("scrapalot-backend" if i == 0 else "", key, f"[dim]{value}[/dim]")

    return Panel(table, title="[bold]Environment Variables (All)[/bold]", border_style="cyan")


def create_env_panel(chat_env: dict = None, backend_env: dict = None) -> Panel:
    """Create environment variables panel."""
    if not chat_env and not backend_env:
        return create_loading_panel("Environment", "cyan", height=10)

    table = Table(show_header=True, header_style="bold cyan", box=None, padding=(0, 1))
    table.add_column("Container", style="white", width=8)
    table.add_column("Variable", style="cyan", width=15)
    table.add_column("Value", style="white", width=20)

    # scrapalot-chat env
    if chat_env:
        for i, (key, value) in enumerate(sorted(chat_env.items())[:5]):  # Top 5
            table.add_row("chat" if i == 0 else "", key, f"[dim]{value}[/dim]")

    # scrapalot-backend env
    if backend_env:
        for i, (key, value) in enumerate(sorted(backend_env.items())[:5]):  # Top 5
            table.add_row("backend" if i == 0 else "", key, f"[dim]{value}[/dim]")

    return Panel(table, title="[bold]Environment[/bold]", border_style="cyan", height=10)


def create_logs_detail_view(log_lines: int = 15) -> Panel:
    """Create detailed logs view for all containers (Tab 3)."""
    table = Table(show_header=True, header_style="bold cyan", box=None, expand=True)
    table.add_column("Container", style="white", width=18)
    table.add_column("Log Entry", style="dim")

    for container in SCRAPALOT_CONTAINERS:
        logs = get_container_logs(container, log_lines)
        if logs:
            for i, log in enumerate(logs):
                table.add_row(container if i == 0 else "", log)
        else:
            table.add_row(container, "[dim italic](no logs)[/dim italic]")

        # Add separator between containers
        table.add_row("", "")

    return Panel(table, title="[bold]Container Logs (All)[/bold]", border_style="magenta")


def create_logs_panel(log_lines: int = 3) -> Panel:
    """Create recent logs panel for scrapalot-chat."""
    if is_compact_mode():
        return create_logs_panel_compact(log_lines)

    content = Text()
    # Show more lines for scrapalot-chat (triple the requested amount)
    actual_lines = log_lines * 3
    logs = get_container_logs("scrapalot-chat", actual_lines)

    content.append("scrapalot-chat:\n", style="bold cyan")
    if logs:
        for log in logs:
            content.append(f"  {log}\n", style="dim")
    else:
        content.append("  (no logs)\n", style="dim italic")

    return Panel(content, title="[bold]Recent Logs[/bold]", border_style="magenta")


def create_layout_compact() -> Layout:
    """Create compact layout for narrow terminals (vertical stacking)."""
    layout = Layout()

    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="info", size=3),
        Layout(name="containers"),
        Layout(name="logs", size=7),
    )

    return layout


def get_current_tab_layout() -> Layout:
    """Get layout for current active tab."""
    with _tab_lock:
        tab_index = _current_tab["index"]

    if tab_index == 0:
        # Tab 1: Overview
        return create_layout()
    elif tab_index == 1:
        # Tab 2: Environment detail
        return create_env_tab_layout()
    elif tab_index == 2:
        # Tab 3: Logs detail
        return create_logs_tab_layout()
    elif tab_index == 3:
        # Tab 4: Network detail
        return create_network_tab_layout()
    else:
        return create_layout()


def create_env_tab_layout() -> Layout:
    """Create layout for Environment tab (Tab 2)."""
    layout = Layout()
    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="env_detail"),
    )
    return layout


def create_logs_tab_layout() -> Layout:
    """Create layout for Logs tab (Tab 3)."""
    layout = Layout()
    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="logs_detail"),
    )
    return layout


def create_network_tab_layout() -> Layout:
    """Create layout for Network tab (Tab 4)."""
    layout = Layout()
    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="network_detail"),
    )
    return layout


def create_layout() -> Layout:
    """Create the dashboard layout."""
    if is_compact_mode():
        return create_layout_compact()

    layout = Layout()

    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="body"),
    )

    layout["body"].split_row(
        Layout(name="main", ratio=3),
        Layout(name="sidebar", ratio=1),
    )

    layout["main"].split_column(
        Layout(name="containers", size=12),  # 10 containers + header + padding
        Layout(name="logs"),  # Takes remaining space for more logs
    )

    layout["sidebar"].split_column(
        Layout(name="system", size=8),
        Layout(name="disk", size=12),
        Layout(name="env", size=10),
        Layout(name="alerts"),
    )

    return layout


def update_layout_compact(layout: Layout, log_lines: int = 2) -> None:
    """Update compact layout."""
    stats = get_container_stats()
    health = get_container_health()
    sys_stats = get_system_stats()

    # Combine system and alerts in one row
    info_table = Table(show_header=False, box=None, expand=True)
    info_table.add_column("sys", ratio=1)
    info_table.add_column("alert", ratio=1)

    mem_pct = sys_stats.get("mem_percent", 0)
    mem_style = "green" if mem_pct < 70 else "yellow" if mem_pct < 90 else "red"
    disk_pct = sys_stats.get("disk_percent", 0)
    disk_style = "green" if disk_pct < 70 else "yellow" if disk_pct < 90 else "red"

    sys_text = Text()
    sys_text.append(f"M:[{mem_style}]{mem_pct:.0f}%[/{mem_style}] ", style="cyan")
    sys_text.append(f"D:[{disk_style}]{disk_pct:.0f}%[/{disk_style}]", style="cyan")

    # Check for alerts
    alert_count = 0
    for container in SCRAPALOT_CONTAINERS:
        cs = stats.get(container, {})
        ch = health.get(container, {})
        if ch.get("health") in ["unhealthy", "stopped"]:
            alert_count += 1
        if cs.get("cpu", 0) >= THRESHOLDS["cpu_critical"]:
            alert_count += 1
        if cs.get("memory", 0) >= THRESHOLDS["memory_critical"]:
            alert_count += 1

    if alert_count == 0:
        alert_text = Text("✓ OK", style="green bold")
    else:
        alert_text = Text(f"⚠ {alert_count} alerts", style="red bold")

    info_table.add_row(sys_text, alert_text)

    layout["header"].update(create_header())
    layout["info"].update(Panel(info_table, border_style="blue", height=3))
    layout["containers"].update(create_containers_table(stats, health))
    layout["logs"].update(create_logs_panel(log_lines))


def update_tab_view(layout: Layout, log_lines: int = 3, force_compact: bool = False) -> None:
    """Update current tab view based on active tab."""
    with _tab_lock:
        tab_index = _current_tab["index"]

    # Always update header
    layout["header"].update(create_header())

    if tab_index == 0:
        # Tab 1: Overview
        update_layout(layout, log_lines, force_compact)
    elif tab_index == 1:
        # Tab 2: Environment detail
        chat_env = get_container_env("scrapalot-chat")
        backend_env = get_container_env("scrapalot-backend")
        layout["env_detail"].update(create_env_detail_view(chat_env, backend_env))
    elif tab_index == 2:
        # Tab 3: Logs detail
        layout["logs_detail"].update(create_logs_detail_view(log_lines))
    elif tab_index == 3:
        # Tab 4: Network detail
        net_stats = get_network_stats()
        layout["network_detail"].update(create_network_detail_view(net_stats))


def update_layout(layout: Layout, log_lines: int = 3, force_compact: bool = False) -> None:
    """Update all panels in the layout with progressive rendering."""
    if is_compact_mode(force_compact):
        update_layout_compact(layout, log_lines)
        return

    # Increment render stage on each call (up to max)
    with _render_lock:
        if _render_stage["current"] < _render_stage["max"]:
            _render_stage["current"] += 1
        current_stage = _render_stage["current"]

    # Stage 0: Header only
    layout["header"].update(create_header())

    if current_stage < 1:
        layout["system"].update(create_loading_panel("System", "blue", height=8))
        layout["disk"].update(create_loading_panel("Disk Breakdown", "magenta", height=12))
        layout["env"].update(create_loading_panel("Environment", "cyan", height=10))
        layout["containers"].update(create_loading_panel("Containers", "green"))
        layout["alerts"].update(create_loading_panel("Alerts", "yellow", height=9))
        layout["logs"].update(create_loading_panel("Recent Logs", "magenta"))
        return

    # Stage 1+: Fetch fast metrics
    sys_stats = get_system_stats()
    dockerd_stats = get_dockerd_stats()
    load_avg = get_load_average()
    net_stats = get_network_stats()

    # Stage 1: System panel
    layout["system"].update(create_system_panel(sys_stats, dockerd_stats, load_avg, net_stats))

    if current_stage < 2:
        layout["disk"].update(create_loading_panel("Disk Breakdown", "magenta", height=12))
        layout["env"].update(create_loading_panel("Environment", "cyan", height=10))
        layout["containers"].update(create_loading_panel("Containers", "green"))
        layout["alerts"].update(create_loading_panel("Alerts", "yellow", height=9))
        layout["logs"].update(create_loading_panel("Recent Logs", "magenta"))
        return

    # Stage 2+: Fetch container metrics
    stats = get_container_stats()
    health = get_container_health()

    # Stage 2: Containers panel
    layout["containers"].update(create_containers_table(stats, health))

    if current_stage < 3:
        layout["disk"].update(create_loading_panel("Disk Breakdown", "magenta", height=12))
        layout["env"].update(create_loading_panel("Environment", "cyan", height=10))
        layout["alerts"].update(create_loading_panel("Alerts", "yellow", height=9))
        layout["logs"].update(create_loading_panel("Recent Logs", "magenta"))
        return

    # Stage 3: Alerts panel
    layout["alerts"].update(create_alerts_panel(stats, health, dockerd_stats, load_avg))

    if current_stage < 4:
        layout["disk"].update(create_loading_panel("Disk Breakdown", "magenta", height=12))
        layout["env"].update(create_loading_panel("Environment", "cyan", height=10))
        layout["logs"].update(create_loading_panel("Recent Logs", "magenta"))
        return

    # Stage 4: Logs panel
    layout["logs"].update(create_logs_panel(log_lines))

    if current_stage < 5:
        layout["disk"].update(create_loading_panel("Disk Breakdown", "magenta", height=12))
        layout["env"].update(create_loading_panel("Environment", "cyan", height=10))
        return

    # Stage 5+: Slow metrics (disk breakdown, env vars) - async cached
    disk_breakdown = get_cached_data("disk_breakdown", get_disk_breakdown, cache_ttl=30)
    partitions = get_cached_data("disk_partitions", get_disk_partitions, cache_ttl=30)

    # Fetch environment variables (only if containers exist)
    chat_env = get_container_env("scrapalot-chat") if health.get("scrapalot-chat") else None
    backend_env = get_container_env("scrapalot-backend") if health.get("scrapalot-backend") else None

    # Stage 5: Disk and Environment panels
    layout["disk"].update(create_disk_panel(disk_breakdown, partitions))
    layout["env"].update(create_env_panel(chat_env, backend_env))


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Scrapalot Monitor - Terminal Dashboard for Scrapalot Infrastructure")
    parser.add_argument("-r", "--refresh", type=float, default=2.0, help="Refresh interval in seconds (default: 2)")
    parser.add_argument("-c", "--log-lines", type=int, default=3, help="Number of log lines to show per container (default: 3)")
    parser.add_argument("--compact", action="store_true", help="Force compact mode for narrow terminals")
    args = parser.parse_args()

    # Set global compact mode if forced
    global _force_compact
    _force_compact = args.compact

    # Reset render stage for progressive loading
    with _render_lock:
        _render_stage["current"] = 0

    # Set stdin to non-blocking raw mode
    old_settings = termios.tcgetattr(sys.stdin)
    try:
        tty.setcbreak(sys.stdin.fileno())

        layout = get_current_tab_layout()
        console.clear()

        with Live(layout, console=console, refresh_per_second=2, screen=True) as live:
            iteration = 0
            quit_flag = False

            while not quit_flag:
                # Check for keyboard input (non-blocking)
                key = get_keypress(timeout=0.0)

                if key:
                    # Handle tab switching (1-4 keys)
                    if key in ["1", "2", "3", "4"]:
                        new_tab = int(key) - 1
                        with _tab_lock:
                            _current_tab["index"] = new_tab

                        # Reset render stage for new tab
                        with _render_lock:
                            _render_stage["current"] = 0

                        # Recreate layout for new tab
                        layout = get_current_tab_layout()
                        live.update(layout, refresh=True)
                        iteration = 0
                        continue

                    # Handle quit (q key)
                    elif key == "q":
                        quit_flag = True
                        continue

                # Recreate layout if terminal size changed or tab changed
                current_compact = is_compact_mode(args.compact)
                if hasattr(update_tab_view, "_last_compact") and update_tab_view._last_compact != current_compact:
                    layout = get_current_tab_layout()
                    live.update(layout, refresh=True)
                update_tab_view._last_compact = current_compact

                # Update current tab view
                update_tab_view(layout, args.log_lines, args.compact)

                # Fast refresh for progressive loading (first 6 iterations)
                # Then switch to user-defined refresh rate
                iteration += 1
                if iteration <= 6:
                    time.sleep(0.15)  # 150ms for smooth progressive loading
                else:
                    time.sleep(args.refresh)

    except KeyboardInterrupt:
        pass
    finally:
        # Restore terminal settings
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old_settings)
        console.clear()
        console.print("[bold green]Scrapalot Monitor stopped.[/bold green]")


_force_compact = False

if __name__ == "__main__":
    main()
