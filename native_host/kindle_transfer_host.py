#!/usr/bin/env python3
"""
Chrome Native Messaging Host for WeebCentral Kindle Downloader
Handles SSH testing and SCP file transfer to Kindle devices.
Supports login without password (empty password / blank password on Kindle),
SSH key authentication, and custom password authentication.
"""

import sys
import json
import struct
import subprocess
import os
import shutil
import tempfile
import tarfile
import zipfile
import re
import xml.etree.ElementTree as ET
import html
import time
import base64

LOG_FILE = '/tmp/weeb_host.log'

def log_debug(msg):
    """Append debug entry to /tmp/weeb_host.log."""
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            t = time.strftime('%Y-%m-%d %H:%M:%S')
            f.write(f'[{t}] {msg}\n')
    except Exception:
        pass

def stage_file_to_tmp(file_path):
    """Safely stages a file to /tmp, using Finder osascript fallback for macOS TCC if direct copy fails."""
    exp = os.path.expanduser(file_path)
    if not os.path.exists(exp):
        return None
    if os.path.abspath(exp).startswith('/tmp/'):
        return exp
    base = os.path.basename(exp)
    tmp_dst = os.path.join('/tmp', f"weeb_{int(time.time())}_{base}")
    try:
        shutil.copyfile(exp, tmp_dst)
        if os.path.exists(tmp_dst):
            return tmp_dst
    except Exception:
        pass
    finder_script = f'''
tell application "Finder"
    set src to POSIX file "{exp}" as alias
    set dst to POSIX file "/tmp" as alias
    duplicate src to dst with replacing
end tell
'''
    try:
        res = subprocess.run(['osascript', '-e', finder_script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
        raw_tmp = os.path.join('/tmp', base)
        if res.returncode == 0 and os.path.exists(raw_tmp):
            return raw_tmp
    except Exception:
        pass
    return exp

def send_message(msg):
    """Send JSON message to Chrome with 4-byte length prefix."""
    encoded = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('@I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

def read_message():
    """Read JSON message from Chrome with 4-byte length prefix."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    length = struct.unpack('@I', raw_length)[0]
    raw_msg = sys.stdin.buffer.read(length).decode('utf-8')
    return json.loads(raw_msg)

def execute_with_auth(base_cmd, password=None, key_path=None, timeout=None):
    """
    Execute SSH or SCP command with stdin=subprocess.DEVNULL.
    When no password is provided, OpenSSH automatically sends an empty password,
    which authenticates successfully with Kindle "login without password".
    """
    env = os.environ.copy()
    askpass_path = None
    cmd = list(base_cmd)

    # Enable OpenSSH connection multiplexing (ControlMaster) for 3-5x speedup
    # Keeps master socket active in /tmp, eliminating redundant TCP handshakes and crypto negotiation
    if len(cmd) > 0 and (cmd[0].endswith('ssh') or cmd[0].endswith('scp')):
        bin_name = cmd[0]
        mux_flags = [
            '-o', 'ControlMaster=auto',
            '-o', 'ControlPath=/tmp/weeb_mux_%h_%p_%r',
            '-o', 'ControlPersist=60s'
        ]
        cmd = [bin_name] + mux_flags + cmd[1:]

    if key_path:
        expanded_key = os.path.expanduser(key_path)
        if os.path.exists(expanded_key):
            cmd.extend(['-i', expanded_key])

    if password:
        fd, askpass_path = tempfile.mkstemp(prefix='kindle_askpass_', suffix='.sh')
        with os.fdopen(fd, 'w') as f:
            f.write('#!/bin/sh\necho "$KINDLE_SSH_PASS"\n')
        os.chmod(askpass_path, 0o700)
        env['SSH_ASKPASS'] = askpass_path
        env['SSH_ASKPASS_REQUIRE'] = 'force'
        env['DISPLAY'] = 'dummy:0'
        env['KINDLE_SSH_PASS'] = password
        cmd.extend(['-o', 'PreferredAuthentications=password,keyboard-interactive,publickey'])

    try:
        # Crucial: stdin=subprocess.DEVNULL allows empty password without tty error
        res = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout
        )
        return res
    finally:
        if askpass_path and os.path.exists(askpass_path):
            try:
                os.remove(askpass_path)
            except Exception:
                pass

def parse_df_output(text):
    """Parse df output for /mnt/us to extract free space in MB and GB."""
    if not text:
        return None
    for line in text.splitlines():
        line = line.strip()
        if '/mnt/us' in line:
            parts = line.split()
            if len(parts) >= 4:
                try:
                    total_val = float(parts[1])
                    free_val = float(parts[3])
                    if total_val > 100_000:
                        free_mb = round(free_val / 1024)
                        total_mb = round(total_val / 1024)
                    else:
                        free_mb = round(free_val)
                        total_mb = round(total_val)
                    if free_mb >= 1024:
                        free_str = f"{free_mb / 1024:.1f} GB free"
                    else:
                        free_str = f"{free_mb} MB free"
                    return {
                        'free_mb': free_mb,
                        'total_mb': total_mb,
                        'free_str': free_str,
                        'low_space': free_mb < 300
                    }
                except Exception:
                    pass
    return None

def test_ssh(host, port, user, password=None, key_path=None):
    """Test SSH connectivity to Kindle and retrieve available storage space."""
    ssh_bin = shutil.which('ssh') or '/usr/bin/ssh'
    cmd = [
        ssh_bin,
        '-o', 'ConnectTimeout=6',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-p', str(port),
        f'{user}@{host}',
        'echo KINDLE_OK; echo __DF__; df -m /mnt/us 2>/dev/null || df /mnt/us 2>/dev/null'
    ]
    try:
        res = execute_with_auth(cmd, password=password, key_path=key_path, timeout=10)
        if res.returncode == 0 and 'KINDLE_OK' in res.stdout:
            storage = parse_df_output(res.stdout)
            msg = f'Connected to Kindle ({user}@{host}:{port})!'
            if storage and storage.get('free_str'):
                msg += f" [{storage['free_str']}]"
            return {
                'status': 'success',
                'message': msg,
                'storage': storage
            }

        # Fallback check for kindle.local if configured IP failed
        if host != 'kindle.local':
            alt_cmd = [
                ssh_bin,
                '-o', 'ConnectTimeout=3',
                '-o', 'StrictHostKeyChecking=accept-new',
                '-p', str(port),
                f'{user}@kindle.local',
                'echo KINDLE_OK; echo __DF__; df -m /mnt/us 2>/dev/null || df /mnt/us 2>/dev/null'
            ]
            alt_res = execute_with_auth(alt_cmd, password=password, key_path=key_path, timeout=5)
            if alt_res and alt_res.returncode == 0 and 'KINDLE_OK' in alt_res.stdout:
                storage = parse_df_output(alt_res.stdout)
                msg = f'Connected via kindle.local! (Configured {host} failed - you can change Host to kindle.local)'
                if storage and storage.get('free_str'):
                    msg += f" [{storage['free_str']}]"
                return {
                    'status': 'success',
                    'message': msg,
                    'storage': storage
                }

        err = res.stderr.strip() or res.stdout.strip() or f'Exit code {res.returncode}'
        if 'timed out' in err.lower() or 'no route to host' in err.lower() or 'connection refused' in err.lower():
            return {
                'status': 'error',
                'message': f'Kindle unreachable ({host}:{port}). Wake up your Kindle and ensure Wi-Fi is connected!'
            }
        return {
            'status': 'error',
            'message': f'SSH connection failed: {err}'
        }
    except subprocess.TimeoutExpired:
        if host != 'kindle.local':
            try:
                alt_cmd = [ssh_bin, '-o', 'ConnectTimeout=3', '-o', 'StrictHostKeyChecking=accept-new', '-p', str(port), f'{user}@kindle.local', 'echo KINDLE_OK; echo __DF__; df -m /mnt/us 2>/dev/null || df /mnt/us 2>/dev/null']
                alt_res = execute_with_auth(alt_cmd, password=password, key_path=key_path, timeout=5)
                if alt_res and alt_res.returncode == 0 and 'KINDLE_OK' in alt_res.stdout:
                    storage = parse_df_output(alt_res.stdout)
                    msg = f'Connected via kindle.local! (Configured {host} timed out)'
                    if storage and storage.get('free_str'):
                        msg += f" [{storage['free_str']}]"
                    return {'status': 'success', 'message': msg, 'storage': storage}
            except Exception:
                pass
        return {'status': 'error', 'message': f'Connection to {host}:{port} timed out (Kindle is likely asleep).'}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}

def set_kindle_keep_awake(host, port, user, enable=True, password=None, key_path=None):
    """
    Prevent or restore Kindle sleep/screensaver during downloads.
    When enable=True, tells Kindle powerd to prevent sleep and screensaver.
    When enable=False, restores normal power management so Kindle can sleep normally.
    """
    ssh_bin = shutil.which('ssh') or '/usr/bin/ssh'
    if enable:
        cmd_str = (
            "lipc-set-prop -i com.lab126.powerd preventScreenSaver 1 2>/dev/null; "
            "lipc-set-prop -i com.lab126.powerd deferScreenSaver 1 2>/dev/null || true"
        )
    else:
        cmd_str = (
            "lipc-set-prop -i com.lab126.powerd preventScreenSaver 0 2>/dev/null; "
            "lipc-set-prop -i com.lab126.powerd deferScreenSaver 1 2>/dev/null || true"
        )

    cmd = [
        ssh_bin,
        '-o', 'ConnectTimeout=4',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-p', str(port),
        f'{user}@{host}',
        cmd_str
    ]
    try:
        res = execute_with_auth(cmd, password=password, key_path=key_path, timeout=6)
        log_debug(f"set_kindle_keep_awake(enable={enable}): returncode={res.returncode if res else 'None'}")
        return {'status': 'success', 'enabled': enable}
    except Exception as e:
        log_debug(f"set_kindle_keep_awake error: {e}")
        return {'status': 'error', 'message': str(e)}

def get_remote_files(host, port, user, remote_folder, password=None, key_path=None):
    """Query list of files already present on Kindle in remote_folder without creating directories."""
    clean_folder = remote_folder.rstrip('/')
    ssh_bin = shutil.which('ssh') or '/usr/bin/ssh'
    cmd = [
        ssh_bin,
        '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-p', str(port),
        f'{user}@{host}',
        f"if [ -d '{clean_folder}' ]; then ls -1 '{clean_folder}' 2>/dev/null; else echo '__NO_DIR__'; fi"
    ]
    try:
        res = execute_with_auth(cmd, password=password, key_path=key_path, timeout=10)
        if res and res.returncode == 0:
            lines = [line.strip() for line in res.stdout.splitlines() if line.strip()]
            if lines and lines[0] == '__NO_DIR__':
                return None
            return set(lines)
    except Exception:
        pass
    return None

def extract_metadata_from_cbz(cbz_path):
    """
    Extracts ComicInfo.xml metadata and page count from a CBZ or ZIP archive.
    """
    meta = {
        'title': None,
        'series': None,
        'authors': None,
        'description': None,
        'keywords': None,
        'language': 'en',
        'pages': 0
    }
    if not os.path.exists(cbz_path) or not os.path.isfile(cbz_path):
        return meta

    try:
        with zipfile.ZipFile(cbz_path, 'r') as zf:
            page_count = 0
            comic_info_xml = None
            for name in zf.namelist():
                ext = os.path.splitext(name)[1].lower()
                if ext in ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'):
                    page_count += 1
                if name.lower() == 'comicinfo.xml' and not comic_info_xml:
                    try:
                        comic_info_xml = zf.read(name).decode('utf-8', errors='ignore')
                    except Exception:
                        pass
            meta['pages'] = page_count

            if comic_info_xml:
                try:
                    root = ET.fromstring(comic_info_xml)
                    title = root.findtext('Title') or root.findtext('Series')
                    series = root.findtext('Series') or root.findtext('Title')
                    writer = root.findtext('Writer') or root.findtext('Penciller')
                    summary = root.findtext('Summary')
                    genre = root.findtext('Genre')
                    if title: meta['title'] = html.unescape(title).strip()
                    if series: meta['series'] = html.unescape(series).strip()
                    if writer: meta['authors'] = html.unescape(writer).strip()
                    if summary: meta['description'] = html.unescape(summary).strip()
                    if genre: meta['keywords'] = html.unescape(genre).strip()
                except Exception as e:
                    log_debug(f"XML parse error in {cbz_path}: {e}")
    except Exception as e:
        log_debug(f"extract_metadata_from_cbz error: {e}")

    base_no_ext = os.path.splitext(os.path.basename(cbz_path))[0]
    if not meta['title']:
        meta['title'] = base_no_ext
    if not meta['series']:
        meta['series'] = meta['title']
    return meta

def serialize_lua_val_py(val, indent=0):
    ind = "    " * indent
    if isinstance(val, dict):
        parts = ["{\n"]
        for k, v in val.items():
            if isinstance(k, int):
                k_str = f"[{k}]"
            else:
                k_str = f"[{json.dumps(str(k))}]"
            parts.append(f"{ind}    {k_str} = {serialize_lua_val_py(v, indent + 1)},\n")
        parts.append(f"{ind}}}")
        return "".join(parts)
    elif isinstance(val, bool):
        return "true" if val else "false"
    elif isinstance(val, (int, float)):
        return str(val)
    elif isinstance(val, str):
        return json.dumps(val)
    return "nil"

def ensure_koreader_sidecar_local(cbz_path, metadata=None):
    """
    Creates/updates KOReader companion sidecar files on PC:
    <book_path_without_ext>.sdr/metadata.cbz.lua and metadata.zip.lua
    - Enforces inverse_reading_order = true (RTL manga mode)
    - Sets doc_props (title, display_title, series, authors, description, keywords, language, pages)
    - Preserves existing reading progress (last_page, percent_finished, bookmarks, etc.)
    """
    if not cbz_path or not os.path.exists(cbz_path) or not os.path.isfile(cbz_path):
        return None
    stem = os.path.splitext(cbz_path)[0]
    sdr_dir = f"{stem}.sdr"
    os.makedirs(sdr_dir, exist_ok=True)
    meta_cbz = os.path.join(sdr_dir, "metadata.cbz.lua")
    meta_zip = os.path.join(sdr_dir, "metadata.zip.lua")

    extracted = extract_metadata_from_cbz(cbz_path)
    if metadata and isinstance(metadata, dict):
        for k in ('title', 'series', 'authors', 'description', 'keywords', 'language'):
            v = metadata.get(k)
            if v:
                extracted[k] = str(v).strip()

    existing_text = ""
    target_meta_file = meta_cbz if os.path.exists(meta_cbz) else (meta_zip if os.path.exists(meta_zip) else None)
    if target_meta_file:
        try:
            with open(target_meta_file, 'r', encoding='utf-8', errors='ignore') as f:
                existing_text = f.read()
        except Exception:
            pass

    preserved_fields = {}
    if existing_text:
        for field in ('last_page', 'page', 'percent_finished', 'summary', 'highlight', 'bookmarks', 'stats'):
            m = re.search(rf'\["{field}"\]\s*=\s*([^,\n]+)', existing_text)
            if m:
                raw = m.group(1).strip()
                try:
                    if raw == 'true': preserved_fields[field] = True
                    elif raw == 'false': preserved_fields[field] = False
                    elif '.' in raw: preserved_fields[field] = float(raw)
                    else: preserved_fields[field] = int(raw)
                except Exception:
                    pass

    data = {
        "inverse_reading_order": True,
        "doc_props": {
            "title": extracted.get('title') or os.path.basename(stem),
            "display_title": extracted.get('title') or os.path.basename(stem),
            "series": extracted.get('series') or extracted.get('title') or os.path.basename(stem),
            "language": extracted.get('language') or "en"
        }
    }
    if extracted.get('authors'):
        data["doc_props"]["authors"] = extracted['authors']
    if extracted.get('description'):
        data["doc_props"]["description"] = extracted['description']
    if extracted.get('keywords'):
        data["doc_props"]["keywords"] = extracted['keywords']
    if extracted.get('pages', 0) > 0:
        data["doc_props"]["pages"] = extracted['pages']

    for k, v in preserved_fields.items():
        data[k] = v

    lua_content = "-- Generated by WeebCentral Kindle Downloader\nreturn " + serialize_lua_val_py(data, 0) + "\n"
    for p in (meta_cbz, meta_zip):
        try:
            with open(p, 'w', encoding='utf-8') as f:
                f.write(lua_content)
        except Exception as e:
            log_debug(f"ensure_koreader_sidecar_local write error to {p}: {e}")

    return sdr_dir

def scp_transfer(host, port, user, local_path, remote_path, password=None, key_path=None, force_overwrite=False, metadata=None):
    """
    Transfer folder or single file to Kindle via SCP with smart incremental sync.
    Supports:
    - Single file (e.g. streaming transfer right after chapter download)
    - Full directory (e.g. manual bulk transfer)
    """
    expanded_local = os.path.expanduser(local_path)
    clean_remote = remote_path if remote_path.endswith('/') else remote_path + '/'
    base_name = os.path.basename(expanded_local.rstrip('/'))

    # Fallback: if .cbz was requested but .zip exists on disk (or vice versa), use existing archive
    if not os.path.exists(expanded_local):
        if expanded_local.endswith('.cbz'):
            alt = expanded_local[:-4] + '.zip'
            if os.path.exists(alt):
                expanded_local = alt
                base_name = os.path.basename(expanded_local)
        elif expanded_local.endswith('.zip'):
            alt = expanded_local[:-4] + '.cbz'
            if os.path.exists(alt):
                expanded_local = alt
                base_name = os.path.basename(expanded_local)

    # Smart Cumulative Tome Detection:
    # If local path is a directory containing a cumulative tome ({base_name}.cbz or {base_name}.zip),
    # switch directly to single file mode so no redundant subfolders are created on Kindle!
    if os.path.exists(expanded_local) and os.path.isdir(expanded_local):
        candidate_tomes = [
            os.path.join(expanded_local, f"{base_name}.cbz"),
            os.path.join(expanded_local, f"{base_name}.zip")
        ]
        try:
            items = [f for f in os.listdir(expanded_local) if (f.lower().endswith('.cbz') or f.lower().endswith('.zip')) and not f.startswith('.')]
            if len(items) == 1:
                candidate_tomes.append(os.path.join(expanded_local, items[0]))
        except Exception:
            pass

        for ct in candidate_tomes:
            if os.path.isfile(ct):
                expanded_local = ct
                base_name = os.path.basename(expanded_local)
                break

    if not os.path.exists(expanded_local):
        return {
            'status': 'error',
            'message': f'Local path does not exist: {expanded_local}'
        }

    is_file = os.path.isfile(expanded_local)
    is_dir = os.path.isdir(expanded_local)

    if not is_file and not is_dir:
        return {
            'status': 'error',
            'message': f'Local path is neither a file nor a directory: {expanded_local}'
        }

    tmp_path = os.path.join('/tmp', base_name)
    in_tmp = (os.path.abspath(expanded_local) == os.path.abspath(tmp_path))
    source_to_use = expanded_local
    used_tmp = False

    if not in_tmp:
        # 1. Clean up stale tmp_path if left from previous runs
        if os.path.exists(tmp_path):
            if os.path.isdir(tmp_path):
                shutil.rmtree(tmp_path, ignore_errors=True)
            else:
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass

        # 2. Stage via Finder to /tmp (bypasses macOS TCC on ~/Downloads)
        finder_script = f'''
tell application "Finder"
    set src to POSIX file "{expanded_local}" as alias
    set dst to POSIX file "/tmp" as alias
    duplicate src to dst with replacing
end tell
'''
        try:
            finder_res = subprocess.run(
                ['osascript', '-e', finder_script],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=120
            )
            if finder_res.returncode == 0 and os.path.exists(tmp_path):
                source_to_use = tmp_path
                used_tmp = True
        except Exception:
            pass

    scp_bin = shutil.which('scp') or '/usr/bin/scp'
    ssh_bin = shutil.which('ssh') or '/usr/bin/ssh'
    auth_flags = [
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-P', str(port)
    ]
    if key_path:
        expanded_key = os.path.expanduser(key_path)
        if os.path.exists(expanded_key):
            auth_flags.extend(['-i', expanded_key])

    if is_file:
        # Single File Mode:
        # Check where this file already exists on Kindle to update it in place without extra subfolders
        existing_remote = find_remote_volume(
            host, port, user,
            volume_name=base_name,
            remote_folder=clean_remote,
            remote_base=os.path.dirname(clean_remote.rstrip('/')),
            password=password,
            key_path=key_path
        )

        if existing_remote:
            remote_folder = os.path.dirname(existing_remote)
            clean_remote = remote_folder + '/'
            remote_dest_item = existing_remote
        else:
            # If not yet on Kindle, check if clean_remote/manga or /mnt/us/koreader/manga exists
            remote_folder = clean_remote.rstrip('/')
            check_manga_dir_cmd = [
                ssh_bin,
                '-o', 'ConnectTimeout=4',
                '-o', 'StrictHostKeyChecking=accept-new',
                '-p', str(port),
                f'{user}@{host}',
                f"if [ -d '{remote_folder}/manga' ]; then echo '{remote_folder}/manga'; elif [ -d '/mnt/us/koreader/manga' ]; then echo '/mnt/us/koreader/manga'; else echo '{remote_folder}'; fi"
            ]
            check_res = execute_with_auth(check_manga_dir_cmd, password=password, key_path=key_path, timeout=5)
            if check_res and check_res.returncode == 0 and check_res.stdout.strip():
                remote_folder = check_res.stdout.strip()
                clean_remote = remote_folder + '/'
            remote_dest_item = f"{clean_remote}{base_name}"

        # Clean up any dummy empty directory or accidental duplicate subfolder on Kindle
        stem_name = os.path.splitext(base_name)[0]
        unwanted_subfolder = f"{clean_remote}{stem_name}"
        cleanup_cmd = [
            ssh_bin,
            '-o', 'ConnectTimeout=6',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-p', str(port),
            f'{user}@{host}',
            f"mkdir -p '{remote_folder}' && rmdir '{remote_dest_item}' 2>/dev/null || true; if [ -d '{unwanted_subfolder}' ]; then rm -rf '{unwanted_subfolder}' 2>/dev/null || true; fi; lipc-set-prop -i com.lab126.powerd preventScreenSaver 1 2>/dev/null || true; lipc-set-prop -i com.lab126.powerd deferScreenSaver 1 2>/dev/null || true;"
        ]
        execute_with_auth(cleanup_cmd, password=password, key_path=key_path, timeout=12)

        remote_files = get_remote_files(host, port, user, remote_folder, password=password, key_path=key_path)

        if not force_overwrite and remote_files is not None and base_name in remote_files:
            # File is up to date, but ensure KOReader metadata & RTL sidecars are set
            ensure_koreader_sidecar_local(expanded_local, metadata=metadata)
            try:
                ensure_remote_merge_script(host, port, user, password=password, key_path=key_path)
                fix_meta_cmd = [
                    ssh_bin,
                    '-o', 'ConnectTimeout=4',
                    '-o', 'StrictHostKeyChecking=accept-new',
                    '-p', str(port),
                    f'{user}@{host}',
                    f"export LD_LIBRARY_PATH=/mnt/us/koreader/libs; /mnt/us/koreader/luajit /mnt/us/koreader/merge_volume.lua --fix-meta '{remote_dest_item}' 2>/dev/null || true"
                ]
                execute_with_auth(fix_meta_cmd, password=password, key_path=key_path, timeout=8)
            except Exception:
                pass
            return {
                'status': 'success',
                'message': f'{base_name} is already up-to-date on Kindle!'
            }

        cmd = [scp_bin] + auth_flags + [source_to_use, f'{user}@{host}:{clean_remote}']

        try:
            res = execute_with_auth(cmd, password=password, key_path=key_path, timeout=300)
            if res.returncode == 0:
                # Invalidate KOReader page count cache
                touch_cmd = [
                    ssh_bin,
                    '-o', 'ConnectTimeout=4',
                    '-o', 'StrictHostKeyChecking=accept-new',
                    '-p', str(port),
                    f'{user}@{host}',
                    f"touch '{remote_dest_item}' 2>/dev/null || true"
                ]
                execute_with_auth(touch_cmd, password=password, key_path=key_path, timeout=5)

                # Ensure KOReader sidecar is synced and RTL metadata is applied
                try:
                    ensure_remote_merge_script(host, port, user, password=password, key_path=key_path)
                    stem_name = os.path.splitext(base_name)[0]
                    local_sdr = f"{os.path.splitext(expanded_local)[0]}.sdr"
                    if os.path.isdir(local_sdr):
                        remote_sdr = f"{clean_remote}{stem_name}.sdr"
                        sdr_mkdir_cmd = [
                            ssh_bin,
                            '-o', 'ConnectTimeout=4',
                            '-o', 'StrictHostKeyChecking=accept-new',
                            '-p', str(port),
                            f'{user}@{host}',
                            f"mkdir -p '{remote_sdr}' 2>/dev/null || true"
                        ]
                        execute_with_auth(sdr_mkdir_cmd, password=password, key_path=key_path, timeout=5)
                        for meta_name in ("metadata.cbz.lua", "metadata.zip.lua"):
                            local_meta = os.path.join(local_sdr, meta_name)
                            if os.path.exists(local_meta):
                                sdr_scp_cmd = [scp_bin] + auth_flags + [local_meta, f'{user}@{host}:{remote_sdr}/{meta_name}']
                                execute_with_auth(sdr_scp_cmd, password=password, key_path=key_path, timeout=10)

                    # Also run --fix-meta on Kindle to guarantee RTL and doc_props
                    fix_meta_cmd = [
                        ssh_bin,
                        '-o', 'ConnectTimeout=4',
                        '-o', 'StrictHostKeyChecking=accept-new',
                        '-p', str(port),
                        f'{user}@{host}',
                        f"export LD_LIBRARY_PATH=/mnt/us/koreader/libs; /mnt/us/koreader/luajit /mnt/us/koreader/merge_volume.lua --fix-meta '{remote_dest_item}' 2>/dev/null || true"
                    ]
                    execute_with_auth(fix_meta_cmd, password=password, key_path=key_path, timeout=8)
                except Exception as meta_err:
                    log_debug(f"Sidecar sync note: {meta_err}")

                return {
                    'status': 'success',
                    'message': f'Transferred {base_name} to Kindle ({user}@{host}:{clean_remote})!'
                }
            else:
                err = res.stderr.strip() or res.stdout.strip() or f'Exit code {res.returncode}'
                if 'timed out' in err.lower() or 'no route to host' in err.lower() or 'connection refused' in err.lower() or 'operation timed out' in err.lower():
                    return {
                        'status': 'error',
                        'message': f'Kindle unreachable ({host}:{port}). Wake up your Kindle and ensure Wi-Fi is connected!'
                    }
                return {'status': 'error', 'message': f'Transfer failed: {err}'}
        except subprocess.TimeoutExpired:
            return {'status': 'error', 'message': f'Transfer of {base_name} timed out after 120s.'}
        except Exception as e:
            return {'status': 'error', 'message': str(e)}
        finally:
            if used_tmp and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass

    elif is_dir:
        # Directory Mode:
        remote_target_folder = f'{clean_remote}{base_name}'

        # Clean up any leftover empty dummy directories (.cbz/ or .zip/) from previous failed transfers
        cleanup_cmd = [
            ssh_bin,
            '-o', 'ConnectTimeout=6',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-p', str(port),
            f'{user}@{host}',
            f"mkdir -p '{remote_target_folder}' && rmdir '{remote_target_folder}'/*.cbz '{remote_target_folder}'/*.zip 2>/dev/null || true; lipc-set-prop -i com.lab126.powerd preventScreenSaver 1 2>/dev/null || true; lipc-set-prop -i com.lab126.powerd deferScreenSaver 1 2>/dev/null || true;"
        ]
        execute_with_auth(cleanup_cmd, password=password, key_path=key_path, timeout=12)

        remote_files = get_remote_files(host, port, user, remote_target_folder, password=password, key_path=key_path)
        files_sent_count = 0

        if used_tmp and os.path.isdir(tmp_path) and remote_files is not None:
            local_items = os.listdir(tmp_path)
            for f in local_items:
                if f.startswith('.') or f.endswith('.sdr'):
                    try:
                        p = os.path.join(tmp_path, f)
                        if os.path.isdir(p):
                            shutil.rmtree(p, ignore_errors=True)
                        else:
                            os.remove(p)
                    except Exception:
                        pass
                elif f in remote_files:
                    try:
                        p = os.path.join(tmp_path, f)
                        if os.path.isdir(p):
                            shutil.rmtree(p, ignore_errors=True)
                        else:
                            os.remove(p)
                    except Exception:
                        pass

            remaining_items = [f for f in os.listdir(tmp_path) if not f.startswith('.')]
            if len(remaining_items) == 0:
                return {
                    'status': 'success',
                    'message': 'All files are already up-to-date on Kindle! Nothing to transfer.'
                }
            files_sent_count = len(remaining_items)

        cmd = [scp_bin, '-r'] + auth_flags + [source_to_use, f'{user}@{host}:{clean_remote}']

        try:
            res = execute_with_auth(cmd, password=password, key_path=key_path, timeout=180)
            if res.returncode == 0:
                count_msg = f' ({files_sent_count} new file{"s" if files_sent_count > 1 else ""})' if files_sent_count > 0 else ''
                return {
                    'status': 'success',
                    'message': f'Transferred successfully to Kindle{count_msg} ({user}@{host}:{clean_remote})!'
                }
            else:
                err = res.stderr.strip() or res.stdout.strip() or f'Exit code {res.returncode}'
                if 'timed out' in err.lower() or 'no route to host' in err.lower() or 'connection refused' in err.lower() or 'operation timed out' in err.lower():
                    return {
                        'status': 'error',
                        'message': f'Kindle unreachable ({host}:{port}). Make sure Kindle is awake with Wi-Fi ON!'
                    }
                if 'operation not permitted' in err.lower():
                    return {
                        'status': 'error',
                        'message': 'macOS blocked reading ~/Downloads. Grant Google Chrome access to Downloads in System Settings -> Privacy & Security -> Files and Folders -> Google Chrome, or use the "Copy Command" button.'
                    }
                return {
                    'status': 'error',
                    'message': f'Transfer failed: {err}'
                }
        except subprocess.TimeoutExpired:
            return {'status': 'error', 'message': 'Transfer timed out after 180s.'}
        except Exception as e:
            return {'status': 'error', 'message': str(e)}
        finally:
            if used_tmp and os.path.exists(tmp_path):
                try:
                    if os.path.isdir(tmp_path):
                        shutil.rmtree(tmp_path, ignore_errors=True)
                    else:
                        os.remove(tmp_path)
                except Exception:
                    pass

def get_folder_files(folder_path):
    """List filenames in folder using Finder (bypasses macOS TCC on ~/Downloads)."""
    expanded = os.path.expanduser(folder_path)
    script = f'''
tell application "Finder"
    try
        set f to POSIX file "{expanded}" as alias
        set file_names to name of every item of folder f
        return file_names
    on error
        return ""
    end try
end tell
'''
    try:
        res = subprocess.run(['osascript', '-e', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        if res.returncode == 0 and res.stdout.strip():
            return [f.strip() for f in res.stdout.strip().split(',') if f.strip()]
    except Exception:
        pass
    return []

def choose_folder_dialog(prompt="Select download folder for manga:"):
    """
    Open native macOS folder picker dialog using AppleScript.
    Returns absolute POSIX path or None if cancelled.
    """
    script = f'''
tell application "System Events"
    activate
end tell
try
    set chosen to choose folder with prompt "{prompt}"
    return POSIX path of chosen
on error
    return ""
end try
'''
    try:
        res = subprocess.run(
            ['osascript', '-e', script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip().rstrip('/')
    except Exception as e:
        sys.stderr.write(f"choose_folder_dialog error: {e}\n")
    return None

def relocate_file(source_path, dest_dir):
    """
    Move a file or directory from source_path to dest_dir.
    Creates dest_dir if it doesn't exist.
    Returns dict with status and new path.
    """
    try:
        exp_src = os.path.expanduser(source_path)
        exp_dest_dir = os.path.expanduser(dest_dir)

        if not os.path.exists(exp_src):
            return {'status': 'error', 'message': f'Source file does not exist: {exp_src}'}

        os.makedirs(exp_dest_dir, exist_ok=True)
        filename = os.path.basename(exp_src.rstrip('/'))
        target_path = os.path.join(exp_dest_dir, filename)

        # If source and destination are already the exact same path
        if os.path.abspath(exp_src) == os.path.abspath(target_path):
            return {'status': 'success', 'new_path': exp_src}

        # If target already exists, remove it first to overwrite
        if os.path.exists(target_path):
            if os.path.isdir(target_path):
                shutil.rmtree(target_path, ignore_errors=True)
            else:
                os.remove(target_path)

        src_parent = os.path.dirname(exp_src)

        shutil.move(exp_src, target_path)

        # Clean up empty staging or parent directory left behind in ~/Downloads
        downloads_dir = os.path.expanduser('~/Downloads')
        if os.path.isdir(src_parent) and os.path.abspath(src_parent) != os.path.abspath(downloads_dir):
            try:
                ds_store = os.path.join(src_parent, '.DS_Store')
                if os.path.exists(ds_store):
                    os.remove(ds_store)
                if len(os.listdir(src_parent)) == 0:
                    os.rmdir(src_parent)
            except Exception:
                pass

        return {'status': 'success', 'new_path': target_path}
    except Exception as e:
        return {'status': 'error', 'message': f'Failed to relocate file: {str(e)}'}

def cleanup_empty_dir(folder_path):
    """Remove directory if it is empty (ignoring .DS_Store). Will never delete ~/Downloads itself."""
    try:
        exp = os.path.expanduser(folder_path)
        downloads_dir = os.path.expanduser('~/Downloads')
        if os.path.isdir(exp) and os.path.abspath(exp) != os.path.abspath(downloads_dir):
            ds_store = os.path.join(exp, '.DS_Store')
            if os.path.exists(ds_store):
                os.remove(ds_store)
            if len(os.listdir(exp)) == 0:
                os.rmdir(exp)
                return True
    except Exception:
        pass
    return False

def get_chapter_key(path):
    if not path:
        return ''
    first = path.split('/')[0] if '/' in path else path
    first_lower = first.lower().strip()
    if 'cover' in first_lower or 'обложк' in first_lower:
        return 'cover'
    stripped = re.sub(r'^\d+(?:\.\d+)?[\._\-]\s*', '', first_lower).strip()
    m = (re.search(r'(?:chapter|ch\.?|глава|гл\.?)\s*([\d.]+)', stripped) or
         re.search(r'(\d+(?:\.\d+)?)', stripped) or
         re.search(r'(?:chapter|ch\.?|глава|гл\.?)\s*([\d.]+)', first_lower) or
         re.search(r'(\d+(?:\.\d+)?)', first_lower))
    if m:
        try:
            val = m.group(1).rstrip('.')
            return f"ch_{float(val):g}"
        except Exception:
            pass
    clean = re.sub(r'\s+', '_', stripped or first_lower)
    return clean

def inspect_volume(volume_path):
    """
    Inspect an existing CBZ/ZIP volume to determine existing chapters and page count.
    """
    exp_path = os.path.expanduser(volume_path)
    if not os.path.exists(exp_path):
        return {
            'status': 'success',
            'exists': False,
            'page_count': 0,
            'chapters': [],
            'chapter_keys': []
        }

    try:
        ensure_koreader_sidecar_local(exp_path)
    except Exception:
        pass

    try:
        with zipfile.ZipFile(exp_path, 'r') as zf:
            namelist = zf.namelist()
            folders = set()
            images = []
            for name in namelist:
                parts = name.split('/')
                if len(parts) > 1 and parts[0]:
                    folders.add(parts[0])
                ext = os.path.splitext(name)[1].lower()
                if ext in ('.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'):
                    images.append(name)

            sorted_folders = sorted(list(folders))
            chapter_keys = [get_chapter_key(f) for f in sorted_folders if get_chapter_key(f) != 'cover']
            comic_info = None
            if 'ComicInfo.xml' in namelist:
                try:
                    xml_data = zf.read('ComicInfo.xml')
                    root = ET.fromstring(xml_data)
                    comic_info = {
                        'title': root.findtext('Title'),
                        'series': root.findtext('Series'),
                        'number': root.findtext('Number'),
                        'page_count': root.findtext('PageCount')
                    }
                except Exception:
                    pass

            return {
                'status': 'success',
                'exists': True,
                'page_count': len(images),
                'chapters': sorted_folders,
                'chapter_keys': chapter_keys,
                'comic_info': comic_info
            }
    except Exception as e:
        return {'status': 'error', 'message': f'Failed to inspect volume: {str(e)}'}

def ensure_remote_merge_script(host, port, user, password=None, key_path=None):
    """
    Ensure /mnt/us/koreader/merge_volume.lua exists and is up to date on Kindle.
    Deploys it via SCP if missing or outdated.
    """
    ssh_bin = shutil.which('ssh') or '/usr/bin/ssh'
    scp_bin = shutil.which('scp') or '/usr/bin/scp'
    lua_local = os.path.join(os.path.dirname(__file__), 'merge_volume.lua')
    if not os.path.exists(lua_local):
        return False

    check_cmd = [
        ssh_bin,
        '-o', 'ConnectTimeout=4',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-p', str(port),
        f'{user}@{host}',
        "if grep -q -- 'version: 3.3.0' /mnt/us/koreader/merge_volume.lua 2>/dev/null; then echo 'OK'; else echo 'NEED_DEPLOY'; fi"
    ]
    check_res = execute_with_auth(check_cmd, password=password, key_path=key_path, timeout=5)
    if not check_res or check_res.returncode != 0:
        return False

    if 'OK' not in check_res.stdout:
        auth_flags = [
            '-o', 'ConnectTimeout=5',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-P', str(port)
        ]
        deploy_cmd = [scp_bin] + auth_flags + [lua_local, f'{user}@{host}:/mnt/us/koreader/merge_volume.lua']
        deploy_res = execute_with_auth(deploy_cmd, password=password, key_path=key_path, timeout=10)
        return bool(deploy_res and deploy_res.returncode == 0)

    return True

def find_remote_volume(host, port, user, volume_name, remote_folder=None, remote_base=None, password=None, key_path=None):
    """
    Search for a cumulative volume on Kindle across:
    1. clean_remote and clean_remote/manga
    2. clean_base and clean_base/manga
    3. /mnt/us/koreader/manga, /mnt/us/koreader, /mnt/us/manga, /mnt/us
    4. Fallback fast find command
    Returns the absolute path to the file on Kindle, or None if not found.
    """
    if not volume_name or not host:
        return None

    clean_remote = remote_folder.rstrip('/') if remote_folder else ''
    clean_base = remote_base.rstrip('/') if remote_base else (os.path.dirname(clean_remote) if '/' in clean_remote else clean_remote)
    base_name = os.path.splitext(volume_name)[0]

    bases = []
    if clean_remote:
        bases.append(clean_remote)
        bases.append(f"{clean_remote}/manga")
    if clean_base:
        bases.append(f"{clean_base}/manga")
        bases.append(clean_base)
    bases.extend([
        '/mnt/us/koreader/manga',
        '/mnt/us/koreader',
        '/mnt/us/manga',
        '/mnt/us'
    ])

    seen = set()
    unique_bases = []
    for b in bases:
        b_norm = b.rstrip('/')
        if b_norm and b_norm not in seen:
            seen.add(b_norm)
            unique_bases.append(b_norm)

    # Also search subfolders named after the manga in each base
    subfolder_bases = [f"{b}/{base_name}" for b in list(unique_bases)]
    for sb in subfolder_bases:
        sb_norm = sb.rstrip('/')
        if sb_norm and sb_norm not in seen:
            seen.add(sb_norm)
            unique_bases.append(sb_norm)

    candidate_names = [volume_name]
    if f"{base_name}.cbz" not in candidate_names:
        candidate_names.append(f"{base_name}.cbz")
    if f"{base_name}.zip" not in candidate_names:
        candidate_names.append(f"{base_name}.zip")

    candidate_paths = []
    for b in unique_bases:
        for name in candidate_names:
            p = f"{b}/{name}"
            if p not in candidate_paths:
                candidate_paths.append(p)

    def escape_single_quotes(val):
        return val.replace("'", "'\\''")

    ssh_bin = shutil.which('ssh') or '/usr/bin/ssh'
    check_steps = [f"if [ -f '{escape_single_quotes(p)}' ]; then echo '{escape_single_quotes(p)}'; exit 0; fi" for p in candidate_paths]
    find_patterns = " -o ".join([f"-name '{escape_single_quotes(name)}'" for name in candidate_names])
    fallback_find = f"find /mnt/us/koreader /mnt/us/manga /mnt/us -maxdepth 4 \\( {find_patterns} \\) -type f 2>/dev/null | head -n 1"

    full_script = "; ".join(check_steps) + "; " + fallback_find
    cmd = [
        ssh_bin,
        '-o', 'ConnectTimeout=4',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-p', str(port),
        f'{user}@{host}',
        full_script
    ]
    res = execute_with_auth(cmd, password=password, key_path=key_path, timeout=8)
    if res and res.returncode == 0:
        lines = [l.strip() for l in res.stdout.splitlines() if l.strip()]
        if lines:
            return lines[0]
    return None

def inspect_remote_volume(host, port, user, remote_cbz_path, password=None, key_path=None):
    """
    Inspects a remote CBZ/ZIP volume on Kindle over SSH.
    Tries /mnt/us/koreader/merge_volume.lua --inspect first, then falls back to unzip -l.
    """
    ssh_bin = shutil.which('ssh') or '/usr/bin/ssh'
    clean_path = remote_cbz_path.replace("'", "'\\''")

    # Fast connectivity & Lua helper verification
    ensure_remote_merge_script(host, port, user, password=password, key_path=key_path)

    cmd = (
        f"if [ -f '{clean_path}' ]; then "
        f"  export LD_LIBRARY_PATH=/mnt/us/koreader/libs; nice -n 19 /mnt/us/koreader/luajit /mnt/us/koreader/merge_volume.lua --inspect '{clean_path}' 2>/dev/null || unzip -l '{clean_path}' 2>/dev/null; "
        f"else "
        f"  echo '__NOT_FOUND__'; "
        f"fi; "
        f"echo '__DF__'; df -m /mnt/us 2>/dev/null || df /mnt/us 2>/dev/null;"
    )
    base_cmd = [
        ssh_bin,
        '-o', 'ConnectTimeout=4',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-p', str(port),
        f'{user}@{host}',
        cmd
    ]
    res = execute_with_auth(base_cmd, password=password, key_path=key_path, timeout=8)
    if not res or res.returncode != 0:
        return {'status': 'error', 'connected': False, 'message': 'Kindle unreachable or SSH failed'}

    out = res.stdout.strip()
    storage = parse_df_output(out)
    if '__NOT_FOUND__' in out:
        return {'status': 'success', 'connected': True, 'exists': False, 'chapters': [], 'chapter_keys': [], 'storage': storage}

    # Try JSON parse from merge_volume.lua
    for line in out.splitlines():
        line = line.strip()
        if line.startswith('{') and line.endswith('}'):
            try:
                data = json.loads(line)
                if data.get('status') == 'success':
                    data['connected'] = True
                    data['storage'] = storage
                    return data
            except Exception:
                pass

    # Fallback parse from unzip -l
    folders = set()
    for line in out.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) == 4 and parts[0].isdigit():
            entry_path = parts[3]
            if '/' in entry_path:
                folder = entry_path.split('/')[0]
                if folder:
                    folders.add(folder)
            else:
                k = get_chapter_key(entry_path)
                if k and k not in ('cover', 'comicinfo.xml', 'toc.ncx'):
                    folders.add(entry_path)

    sorted_folders = sorted(list(folders))
    chapter_keys = [get_chapter_key(f) for f in sorted_folders if get_chapter_key(f) != 'cover']
    return {
        'status': 'success',
        'connected': True,
        'exists': True,
        'chapters': sorted_folders,
        'chapter_keys': chapter_keys
    }

def scan_archives(local_folder, volume_name, remote_folder=None, remote_base=None, host='kindle.local', port=2222, user='root', password=None, key_path=None):
    """
    Scans both local PC and Kindle for cumulative archives and loose chapter files.
    Returns combined chapter keys and individual breakdown.
    """
    pc_keys = set()
    pc_volume_found = False
    pc_volume_path = None
    pc_chapters = []

    # 1. Inspect PC local folder and volume
    exp_local_dir = os.path.expanduser(local_folder)
    base_name = os.path.splitext(volume_name)[0]
    parent_local_dir = os.path.dirname(exp_local_dir)
    candidate_volumes = [
        os.path.join(exp_local_dir, volume_name),
        os.path.join(exp_local_dir, f"{base_name}.cbz"),
        os.path.join(exp_local_dir, f"{base_name}.zip"),
        f"{exp_local_dir.rstrip('/')}.cbz",
        f"{exp_local_dir.rstrip('/')}.zip",
        os.path.join(parent_local_dir, volume_name),
        os.path.join(parent_local_dir, f"{base_name}.cbz"),
        os.path.join(parent_local_dir, f"{base_name}.zip")
    ]

    for cand in candidate_volumes:
        if os.path.exists(cand) and not os.path.isdir(cand):
            pc_volume_found = True
            pc_volume_path = cand
            vol_res = inspect_volume(cand)
            if vol_res.get('status') == 'success':
                for k in vol_res.get('chapter_keys', []):
                    pc_keys.add(k)
                pc_chapters = vol_res.get('chapters', [])
            break

    # Also inspect loose files in PC directory
    if os.path.exists(exp_local_dir) and os.path.isdir(exp_local_dir):
        try:
            for f in os.listdir(exp_local_dir):
                full_f = os.path.join(exp_local_dir, f)
                if os.path.isfile(full_f) and (f.lower().endswith('.cbz') or f.lower().endswith('.zip')):
                    if pc_volume_path and os.path.abspath(full_f) == os.path.abspath(pc_volume_path):
                        continue
                    k = get_chapter_key(f)
                    if k and k not in ('cover', 'comicinfo.xml', 'toc.ncx'):
                        pc_keys.add(k)
        except Exception:
            pass

    # 2. Inspect Kindle remote folder and volume
    kindle_keys = set()
    kindle_connected = False
    kindle_volume_found = False
    kindle_volume_path = None
    kindle_error = None
    kindle_reading_progress = None
    kindle_storage = None

    if host:
        ssh_bin = shutil.which('ssh') or '/usr/bin/ssh'
        clean_remote = remote_folder.rstrip('/') if remote_folder else ''
        clean_base = remote_base.rstrip('/') if remote_base else (os.path.dirname(clean_remote) if '/' in clean_remote else clean_remote)

        def esc_sh(val):
            return "'" + val.replace("'", "'\\''") + "'"

        # Build candidate paths across common Kindle directories
        bases = []
        if clean_remote:
            bases.append(clean_remote)
            bases.append(f"{clean_remote}/manga")
        if clean_base:
            bases.append(f"{clean_base}/manga")
            bases.append(clean_base)
        bases.extend([
            '/mnt/us/koreader/manga',
            '/mnt/us/koreader',
            '/mnt/us/manga',
            '/mnt/us'
        ])

        seen = set()
        unique_bases = []
        for b in bases:
            b_norm = b.rstrip('/')
            if b_norm and b_norm not in seen:
                seen.add(b_norm)
                unique_bases.append(b_norm)

        candidate_names = [volume_name]
        if f"{base_name}.cbz" not in candidate_names:
            candidate_names.append(f"{base_name}.cbz")
        if f"{base_name}.zip" not in candidate_names:
            candidate_names.append(f"{base_name}.zip")

        candidate_paths = []
        for b in unique_bases:
            for name in candidate_names:
                p = f"{b}/{name}"
                if p not in candidate_paths:
                    candidate_paths.append(p)

        folders_to_clean = []
        if clean_remote and clean_remote not in ('/mnt/us', '/mnt/us/koreader', '/mnt/us/koreader/manga', '/mnt/us/manga'):
            folders_to_clean.append(clean_remote)
        if clean_base and f"{clean_base}/{base_name}" not in folders_to_clean and f"{clean_base}/{base_name}" not in ('/mnt/us', '/mnt/us/koreader', '/mnt/us/koreader/manga', '/mnt/us/manga'):
            folders_to_clean.append(f"{clean_base}/{base_name}")

        cand_sh_list = " ".join([esc_sh(p) for p in candidate_paths])
        find_sh_patterns = " -o ".join([f"-iname {esc_sh(name)}" for name in candidate_names])
        cleanup_sh_list = " ".join([esc_sh(d) for d in folders_to_clean])

        loose_sh = ""
        if clean_remote and clean_remote != clean_base:
            loose_sh = f"if [ -d {esc_sh(clean_remote)} ]; then echo '__LOOSE__'; ls -1 {esc_sh(clean_remote)} 2>/dev/null; fi; "

        cleanup_sh = ""
        if cleanup_sh_list:
            cleanup_sh = f"for d in {cleanup_sh_list}; do if [ -d \"$d\" ]; then rmdir \"$d\" 2>/dev/null || true; fi; done; "

        unified_script = (
            f"VOL=\"\"; "
            f"for p in {cand_sh_list}; do if [ -f \"$p\" ]; then VOL=\"$p\"; break; fi; done; "
            f"if [ -z \"$VOL\" ]; then VOL=$(find /mnt/us/koreader /mnt/us/manga /mnt/us -maxdepth 4 \\( {find_sh_patterns} \\) -type f 2>/dev/null | head -n 1); fi; "
            f"{loose_sh}"
            f"{cleanup_sh}"
            f"if [ -n \"$VOL\" ]; then "
            f"  echo \"__VOL__:$VOL\"; "
            f"  if grep -q -- 'merge_volume.lua' /mnt/us/koreader/merge_volume.lua 2>/dev/null; then "
            f"    echo '__INSPECT__'; "
            f"    export LD_LIBRARY_PATH=/mnt/us/koreader/libs; nice -n 19 /mnt/us/koreader/luajit /mnt/us/koreader/merge_volume.lua --inspect \"$VOL\" 2>/dev/null || unzip -l \"$VOL\" 2>/dev/null; "
            f"  else "
            f"    echo '__NEED_DEPLOY__'; "
            f"  fi; "
            f"else "
            f"  echo '__NOT_FOUND__'; "
            f"fi; "
            f"echo '__DF__'; df -m /mnt/us 2>/dev/null || df /mnt/us 2>/dev/null;"
        )

        cmd = [
            ssh_bin,
            '-o', 'ConnectTimeout=4',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-p', str(port),
            f'{user}@{host}',
            unified_script
        ]

        res = execute_with_auth(cmd, password=password, key_path=key_path, timeout=9)

        # Automatic mDNS fallback: if configured IP failed, try kindle.local
        if (not res or res.returncode != 0) and host != 'kindle.local':
            alt_cmd = [
                ssh_bin,
                '-o', 'ConnectTimeout=3',
                '-o', 'StrictHostKeyChecking=accept-new',
                '-p', str(port),
                f'{user}@kindle.local',
                unified_script
            ]
            alt_res = execute_with_auth(alt_cmd, password=password, key_path=key_path, timeout=6)
            if alt_res and alt_res.returncode == 0:
                res = alt_res
                host = 'kindle.local'

        if res and res.returncode == 0:
            kindle_connected = True
            kindle_storage = parse_df_output(res.stdout)
            mode = None
            inspect_lines = []
            for raw_line in res.stdout.splitlines():
                line = raw_line.strip()
                if line.startswith('__VOL__:'):
                    kindle_volume_found = True
                    kindle_volume_path = line[8:].strip()
                    mode = None
                elif line == '__NOT_FOUND__':
                    kindle_volume_found = False
                    mode = None
                elif line == '__NEED_DEPLOY__':
                    mode = 'NEED_DEPLOY'
                elif line == '__LOOSE__':
                    mode = 'LOOSE'
                elif line == '__INSPECT__':
                    mode = 'INSPECT'
                elif mode == 'LOOSE':
                    if line.lower().endswith('.cbz') or line.lower().endswith('.zip'):
                        k = get_chapter_key(line)
                        if k and k not in ('cover', 'comicinfo.xml', 'toc.ncx'):
                            kindle_keys.add(k)
                elif mode == 'INSPECT':
                    inspect_lines.append(line)

            if mode == 'NEED_DEPLOY' and kindle_volume_path:
                ensure_remote_merge_script(host, port, user, password=password, key_path=key_path)
                rem_res = inspect_remote_volume(host, port, user, kindle_volume_path, password=password, key_path=key_path)
                if rem_res.get('status') == 'success' and rem_res.get('exists'):
                    for k in rem_res.get('chapter_keys', []):
                        kindle_keys.add(k)
                    kindle_reading_progress = rem_res.get('reading_progress')
            elif inspect_lines:
                parsed_json = False
                for il in inspect_lines:
                    if il.startswith('{') and il.endswith('}'):
                        try:
                            data = json.loads(il)
                            if data.get('status') == 'success':
                                for k in data.get('chapter_keys', []):
                                    kindle_keys.add(k)
                                kindle_reading_progress = data.get('reading_progress')
                                parsed_json = True
                                break
                        except Exception:
                            pass
                if not parsed_json:
                    for il in inspect_lines:
                        parts = il.strip().split(None, 3)
                        if len(parts) == 4 and parts[0].isdigit():
                            entry_path = parts[3]
                            folder = entry_path.split('/')[0] if '/' in entry_path else entry_path
                            k = get_chapter_key(folder)
                            if k and k not in ('cover', 'comicinfo.xml', 'toc.ncx'):
                                kindle_keys.add(k)
        else:
            kindle_connected = False
            kindle_error = (res.stderr.strip() if res and res.stderr else 'Kindle unreachable or SSH failed')

    all_chapter_keys = sorted(list(pc_keys | kindle_keys))

    return {
        'status': 'success',
        'pc': {
            'exists': bool(pc_volume_found or pc_keys),
            'volume_exists': pc_volume_found,
            'volume_path': pc_volume_path,
            'chapter_keys': sorted(list(pc_keys)),
            'chapters': pc_chapters
        },
        'kindle': {
            'connected': kindle_connected,
            'exists': bool(kindle_volume_found or kindle_keys),
            'volume_exists': kindle_volume_found,
            'remote_path': kindle_volume_path,
            'chapter_keys': sorted(list(kindle_keys)),
            'reading_progress': kindle_reading_progress,
            'error': kindle_error,
            'storage': kindle_storage
        },
        'storage': kindle_storage,
        'all_chapter_keys': all_chapter_keys
    }

def parse_cd_entries_py(cd_data):
    entries = []
    pos = 0
    while pos < len(cd_data):
        if cd_data[pos:pos+4] != b'PK\x01\x02':
            break
        n_len = struct.unpack('<H', cd_data[pos+28:pos+30])[0]
        extra_len = struct.unpack('<H', cd_data[pos+30:pos+32])[0]
        comment_len = struct.unpack('<H', cd_data[pos+32:pos+34])[0]
        entry_len = 46 + n_len + extra_len + comment_len
        fname = cd_data[pos+46:pos+46+n_len].decode('utf-8', errors='ignore')
        entries.append((fname, cd_data[pos:pos+entry_len]))
        pos += entry_len
    return entries

def binary_zip_append_filter(target_path, delta_path):
    EOCD_FMT = '<4sHHHHIIH'
    with open(target_path, 'r+b') as f_target, open(delta_path, 'rb') as f_delta:
        f_target.seek(0, os.SEEK_END)
        t_len = f_target.tell()
        f_target.seek(max(0, t_len - 65536 - 22), os.SEEK_SET)
        t_tail = f_target.read()
        t_eocd_pos = t_tail.rfind(b'PK\x05\x06')
        if t_eocd_pos == -1:
            raise ValueError("Target is not a valid ZIP archive")
        t_eocd_offset = max(0, t_len - 65536 - 22) + t_eocd_pos

        f_target.seek(t_eocd_offset)
        sig, disk, disk_start, ent_disk, old_entries, old_cd_size, old_cd_offset, comm_len = struct.unpack(EOCD_FMT, f_target.read(22))

        f_target.seek(old_cd_offset, os.SEEK_SET)
        old_cd_data = f_target.read(old_cd_size)

        f_delta.seek(0, os.SEEK_END)
        d_len = f_delta.tell()
        f_delta.seek(max(0, d_len - 65536 - 22), os.SEEK_SET)
        d_tail = f_delta.read()
        d_eocd_pos = d_tail.rfind(b'PK\x05\x06')
        if d_eocd_pos == -1:
            raise ValueError("Delta is not a valid ZIP archive")
        d_eocd_offset = max(0, d_len - 65536 - 22) + d_eocd_pos

        f_delta.seek(d_eocd_offset)
        sig, d_disk, d_disk_start, d_ent_disk, d_entries, d_cd_size, d_cd_offset, d_comm_len = struct.unpack(EOCD_FMT, f_delta.read(22))

        f_delta.seek(0, os.SEEK_SET)
        delta_local_data = f_delta.read(d_cd_offset)

        f_delta.seek(d_cd_offset, os.SEEK_SET)
        delta_cd_raw = f_delta.read(d_cd_size)

        old_parsed = parse_cd_entries_py(old_cd_data)
        delta_parsed = parse_cd_entries_py(delta_cd_raw)

        delta_names = {fname.lower() for fname, _ in delta_parsed}
        delta_keys = set()
        for fname, _ in delta_parsed:
            fn_lower = fname.lower()
            if fn_lower not in ('comicinfo.xml', 'toc.ncx'):
                k = get_chapter_key(fname)
                if k:
                    delta_keys.add(k)

        filtered_old_cd = bytearray()
        kept_old_count = 0
        seen_old_folders = {}
        for fname, entry_bytes in old_parsed:
            fn_lower = fname.lower()
            if fn_lower in delta_names:
                continue
            if fn_lower not in ('comicinfo.xml', 'toc.ncx'):
                k = get_chapter_key(fname)
                if k and k in delta_keys:
                    continue
                if k and k != 'other':
                    folder = fname.split('/')[0] if '/' in fname else ''
                    if k not in seen_old_folders:
                        seen_old_folders[k] = folder
                    elif seen_old_folders[k] != folder:
                        continue
            filtered_old_cd.extend(entry_bytes)
            kept_old_count += 1

        adjusted_delta_cd = bytearray()
        for fname, entry_bytes in delta_parsed:
            entry = bytearray(entry_bytes)
            local_offset = struct.unpack('<I', entry[42:46])[0]
            entry[42:46] = struct.pack('<I', local_offset + old_cd_offset)
            adjusted_delta_cd.extend(entry)

        f_target.seek(old_cd_offset, os.SEEK_SET)
        f_target.write(delta_local_data)

        new_cd_offset = f_target.tell()
        f_target.write(filtered_old_cd)
        f_target.write(adjusted_delta_cd)
        new_cd_size = f_target.tell() - new_cd_offset

        new_total_entries = kept_old_count + len(delta_parsed)
        new_eocd = struct.pack(
            EOCD_FMT,
            b'PK\x05\x06',
            0, 0,
            new_total_entries,
            new_total_entries,
            new_cd_size,
            new_cd_offset,
            0
        )
        f_target.write(new_eocd)
        f_target.truncate()

def append_to_volume(local_target_cbz, delta_zip_path, remote_folder=None, save_to_pc=True, save_to_kindle=True, auto_transfer=None, host='kindle.local', port=2222, user='root', password=None, key_path=None, known_remote_path=None, metadata=None):
    """
    Appends delta_zip into local_target_cbz on PC via instant binary append (O(delta)) if save_to_pc is True.
    Smartly de-duplicates existing chapter copies and avoids duplicating content.
    If save_to_kindle is True:
      - If volume does NOT exist on Kindle, sends initial volume directly.
      - If volume DOES exist on Kindle, sends delta_zip to Kindle and runs merge_volume.lua.
    """
    if auto_transfer is not None:
        save_to_kindle = auto_transfer
    exp_target = os.path.expanduser(local_target_cbz)
    exp_delta = os.path.expanduser(delta_zip_path)
    log_debug(f"append_to_volume: target={exp_target}, delta={exp_delta}, save_pc={save_to_pc}, save_kindle={save_to_kindle}, known_remote={known_remote_path}")

    if not os.path.exists(exp_delta):
        return {'status': 'error', 'message': f'Delta zip not found: {exp_delta}'}

    target_existed = os.path.exists(exp_target)

    # 1. Update local CBZ on PC (only if save_to_pc is True)
    if save_to_pc:
        os.makedirs(os.path.dirname(exp_target), exist_ok=True)
        if not target_existed:
            # Initial creation: copy delta directly to target
            shutil.copyfile(exp_delta, exp_target)
        else:
            # True In-Place Binary Append (O(delta)) with safe fallback
            try:
                binary_zip_append_filter(exp_target, exp_delta)
            except Exception as fast_err:
                # Fallback to standard merge if binary append fails
                tmp_target = exp_target + '.tmp_merge.zip'
                try:
                    with zipfile.ZipFile(exp_target, 'r') as zf_old, \
                         zipfile.ZipFile(exp_delta, 'r') as zf_delta, \
                         zipfile.ZipFile(tmp_target, 'w', compression=zipfile.ZIP_STORED) as zf_new:

                        delta_keys = set()
                        for item in zf_delta.infolist():
                            k = get_chapter_key(item.filename)
                            if k and k not in ('comicinfo.xml', 'toc.ncx'):
                                delta_keys.add(k)

                        seen_old_folders = {}
                        for item in zf_old.infolist():
                            if item.filename in ('ComicInfo.xml', 'toc.ncx'):
                                continue
                            k = get_chapter_key(item.filename)
                            if k in delta_keys:
                                continue
                            folder_prefix = item.filename.split('/')[0] if '/' in item.filename else ''
                            if k not in seen_old_folders:
                                seen_old_folders[k] = folder_prefix
                            if seen_old_folders[k] != folder_prefix:
                                continue
                            zf_new.writestr(item, zf_old.read(item.filename))

                        for item in zf_delta.infolist():
                            zf_new.writestr(item, zf_delta.read(item.filename))

                    os.replace(tmp_target, exp_target)
                except Exception as e:
                    if os.path.exists(tmp_target):
                        os.remove(tmp_target)
                    return {'status': 'error', 'message': f'Failed to merge local volume: {str(e)}'}

        # Ensure local KOReader sidecar is generated with RTL manga order & metadata
        try:
            ensure_koreader_sidecar_local(exp_target, metadata=metadata)
        except Exception as sidecar_err:
            log_debug(f"Local sidecar error: {sidecar_err}")

    # 2. Sync to Kindle
    kindle_result = None
    if save_to_kindle:
        clean_remote = remote_folder.rstrip('/') if remote_folder else '/mnt/us/koreader'
        filename = os.path.basename(exp_target)

        # Locate existing volume anywhere on Kindle (using known_remote_path if already discovered)
        found_remote_path = known_remote_path
        if not found_remote_path:
            found_remote_path = find_remote_volume(
                host, port, user,
                volume_name=filename,
                remote_folder=clean_remote,
                remote_base=os.path.dirname(clean_remote) if '/' in clean_remote else clean_remote,
                password=password,
                key_path=key_path
            )

        ssh_bin = shutil.which('ssh') or '/usr/bin/ssh'
        scp_bin = shutil.which('scp') or '/usr/bin/scp'
        auth_flags = [
            '-o', 'ConnectTimeout=6',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-P', str(port)
        ]
        ssh_auth_flags = [
            '-o', 'ConnectTimeout=6',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-p', str(port)
        ]

        if not found_remote_path:
            # Volume does NOT exist anywhere on Kindle!
            # Determine best destination folder on Kindle
            check_manga_dir_cmd = [
                ssh_bin,
                '-o', 'ConnectTimeout=4',
                '-o', 'StrictHostKeyChecking=accept-new',
                '-p', str(port),
                f'{user}@{host}',
                f"if [ -d '{clean_remote}/manga' ]; then echo '{clean_remote}/manga'; elif [ -d '/mnt/us/koreader/manga' ]; then echo '/mnt/us/koreader/manga'; else echo '{clean_remote}'; fi"
            ]
            check_manga_res = execute_with_auth(check_manga_dir_cmd, password=password, key_path=key_path, timeout=5)
            dest_dir = clean_remote
            if check_manga_res and check_manga_res.returncode == 0 and check_manga_res.stdout.strip():
                dest_dir = check_manga_res.stdout.strip()

            if save_to_pc and os.path.exists(exp_target):
                file_to_send = exp_target
                temp_send_file = None
            else:
                # Ensure the file sent to Kindle has the proper volume name (not delta_*.zip)
                temp_send_file = os.path.join(os.path.dirname(exp_delta), filename)
                shutil.copyfile(exp_delta, temp_send_file)
                file_to_send = temp_send_file

            try:
                kindle_result = scp_transfer(host, port, user, file_to_send, dest_dir, password=password, key_path=key_path, force_overwrite=True, metadata=metadata)
                if kindle_result and kindle_result.get('status') == 'success':
                    remote_dest = f"{dest_dir.rstrip('/')}/{filename}"
                    kindle_result['remote_target_path'] = remote_dest
            finally:
                if temp_send_file and os.path.exists(temp_send_file):
                    try:
                        os.remove(temp_send_file)
                    except Exception:
                        pass
        else:
            # Remote volume found! Incremental fast append:
            remote_target_path = found_remote_path
            ensure_remote_merge_script(host, port, user, password=password, key_path=key_path)

            # Stage delta safely to /tmp to bypass macOS TCC Sandbox on ~/Downloads
            staged_delta = stage_file_to_tmp(exp_delta) or exp_delta
            remote_delta = f'/mnt/us/koreader/cache/delta_{int(time.time())}.zip'
            delta_transfer_cmd = [scp_bin] + auth_flags + [staged_delta, f'{user}@{host}:{remote_delta}']
            transfer_res = execute_with_auth(delta_transfer_cmd, password=password, key_path=key_path, timeout=180)
            if staged_delta and staged_delta != exp_delta and os.path.exists(staged_delta):
                try:
                    os.remove(staged_delta)
                except Exception:
                    pass
            if transfer_res.returncode != 0:
                kindle_result = {'status': 'error', 'message': f'Failed to send delta to Kindle: {transfer_res.stderr}'}
            else:
                # Execute merge on Kindle with generous timeout
                merge_cmd = [ssh_bin] + ssh_auth_flags + [
                    f'{user}@{host}',
                    f"export LD_LIBRARY_PATH=/mnt/us/koreader/libs; nice -n 19 /mnt/us/koreader/luajit /mnt/us/koreader/merge_volume.lua '{remote_target_path}' '{remote_delta}'"
                ]
                try:
                    merge_res = execute_with_auth(merge_cmd, password=password, key_path=key_path, timeout=180)
                    out_lines = [l.strip() for l in merge_res.stdout.splitlines() if l.strip().startswith('{')]
                    if out_lines:
                        res_json = json.loads(out_lines[-1])
                        if res_json.get('status') == 'success':
                            # Sync local sidecar if present
                            try:
                                stem_name = os.path.splitext(os.path.basename(remote_target_path))[0]
                                remote_folder_path = os.path.dirname(remote_target_path)
                                local_sdr = f"{os.path.splitext(exp_target)[0]}.sdr"
                                if os.path.isdir(local_sdr):
                                    remote_sdr = f"{remote_folder_path}/{stem_name}.sdr"
                                    sdr_mkdir_cmd = [
                                        ssh_bin,
                                        '-o', 'ConnectTimeout=4',
                                        '-o', 'StrictHostKeyChecking=accept-new',
                                        '-p', str(port),
                                        f'{user}@{host}',
                                        f"mkdir -p '{remote_sdr}' 2>/dev/null || true"
                                    ]
                                    execute_with_auth(sdr_mkdir_cmd, password=password, key_path=key_path, timeout=5)
                                    for meta_name in ("metadata.cbz.lua", "metadata.zip.lua"):
                                        loc_meta = os.path.join(local_sdr, meta_name)
                                        if os.path.exists(loc_meta):
                                            sdr_scp_cmd = [scp_bin] + auth_flags + [loc_meta, f'{user}@{host}:{remote_sdr}/{meta_name}']
                                            execute_with_auth(sdr_scp_cmd, password=password, key_path=key_path, timeout=10)
                            except Exception as sidecar_err:
                                log_debug(f"Sidecar sync note on merge: {sidecar_err}")

                            kindle_result = {
                                'status': 'success',
                                'message': f'Appended new chapter(s) to {os.path.basename(remote_target_path)} on Kindle!',
                                'remote_target_path': remote_target_path
                            }
                        else:
                            kindle_result = {'status': 'error', 'message': res_json.get('message', 'Kindle merge failed')}
                    else:
                        kindle_result = {'status': 'error', 'message': f'Kindle merge error: {merge_res.stderr or merge_res.stdout}'}
                except subprocess.TimeoutExpired:
                    kindle_result = {'status': 'error', 'message': 'Kindle volume merge timed out after 180s.'}
                except Exception as e:
                    kindle_result = {'status': 'error', 'message': f'Merge parsing error: {str(e)}'}

    # Clean up local delta if it still exists
    if os.path.exists(exp_delta):
        try:
            os.remove(exp_delta)
        except Exception:
            pass

    return {
        'status': 'success',
        'local_path': exp_target,
        'action': 'merged' if (save_to_pc and target_existed) else ('created' if save_to_pc else 'synced_kindle_only'),
        'kindle_result': kindle_result
    }

def delete_chapters_from_volume_py(volume_path, chapter_keys_to_delete):
    """
    Deletes specific chapters from a CBZ/ZIP volume on PC.
    If all chapters are deleted, removes the volume file entirely.
    Otherwise, rewrites the ZIP without the specified chapters.
    """
    exp_path = os.path.expanduser(volume_path)
    if not os.path.exists(exp_path):
        return {'status': 'not_found', 'deleted': 0}

    keys_set = set(k.strip().lower() for k in chapter_keys_to_delete if k and k.strip())
    tmp_path = exp_path + '.tmp_del.zip'

    try:
        deleted_count = 0
        with zipfile.ZipFile(exp_path, 'r') as zf_in:
            all_infolist = zf_in.infolist()

            all_keys = set()
            for item in all_infolist:
                if item.filename.lower() not in ('comicinfo.xml', 'toc.ncx'):
                    k = get_chapter_key(item.filename)
                    if k and k != 'cover':
                        all_keys.add(k.lower())

            remaining_keys = all_keys - keys_set
            if not remaining_keys:
                zf_in.close()
                os.remove(exp_path)
                return {'status': 'success', 'action': 'volume_deleted', 'deleted': len(all_keys)}

            with zipfile.ZipFile(tmp_path, 'w', compression=zipfile.ZIP_STORED) as zf_out:
                for item in all_infolist:
                    fn_lower = item.filename.lower()
                    if fn_lower in ('comicinfo.xml', 'toc.ncx'):
                        continue
                    k = get_chapter_key(item.filename)
                    if k and k.lower() in keys_set:
                        deleted_count += 1
                        continue
                    zf_out.writestr(item, zf_in.read(item.filename))

        os.replace(tmp_path, exp_path)
        return {'status': 'success', 'action': 'chapters_deleted', 'deleted': deleted_count, 'remaining': len(remaining_keys)}
    except Exception as e:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        return {'status': 'error', 'message': str(e)}

def delete_loose_chapters_local(folder_path, chapter_keys_to_delete, volume_path=None):
    """
    Deletes loose chapter archives/folders from folder_path that match chapter_keys_to_delete.
    """
    exp_folder = os.path.expanduser(folder_path)
    if not os.path.isdir(exp_folder):
        return 0

    keys_set = set(k.strip().lower() for k in chapter_keys_to_delete if k and k.strip())
    deleted = 0
    exp_vol = os.path.abspath(os.path.expanduser(volume_path)) if volume_path else None

    try:
        for entry in os.listdir(exp_folder):
            full_p = os.path.join(exp_folder, entry)
            if exp_vol and os.path.abspath(full_p) == exp_vol:
                continue
            k = get_chapter_key(entry)
            if k and k.lower() in keys_set:
                if os.path.isfile(full_p):
                    os.remove(full_p)
                    deleted += 1
                elif os.path.isdir(full_p):
                    shutil.rmtree(full_p, ignore_errors=True)
                    deleted += 1
        cleanup_empty_dir(exp_folder)
    except Exception:
        pass
    return deleted

def delete_chapters(target='pc', local_folder='', volume_name='', remote_folder=None, remote_base=None, chapter_keys=None, host='kindle.local', port=2222, user='root', password=None, key_path=None):
    """
    Deletes specific chapters from PC and/or Kindle.
    Supports both cumulative volume archives and individual chapter files.
    """
    if not chapter_keys:
        return {'status': 'error', 'message': 'No chapter keys provided for deletion'}

    keys_list = [k.strip().lower() for k in chapter_keys if k and k.strip()]
    if not keys_list:
        return {'status': 'error', 'message': 'Empty chapter keys'}

    pc_res = None
    kindle_res = None

    # 1. Delete on PC
    if target in ('pc', 'both'):
        pc_deleted_from_volume = 0
        pc_volume_action = None
        pc_loose_deleted = 0

        exp_local_dir = os.path.expanduser(local_folder) if local_folder else ''
        base_name = os.path.splitext(volume_name)[0] if volume_name else ''
        parent_local_dir = os.path.dirname(exp_local_dir) if exp_local_dir else ''

        candidate_volumes = []
        if exp_local_dir and volume_name:
            candidate_volumes.extend([
                os.path.join(exp_local_dir, volume_name),
                os.path.join(exp_local_dir, f"{base_name}.cbz"),
                os.path.join(exp_local_dir, f"{base_name}.zip"),
                f"{exp_local_dir.rstrip('/')}.cbz",
                f"{exp_local_dir.rstrip('/')}.zip",
            ])
        if parent_local_dir and volume_name:
            candidate_volumes.extend([
                os.path.join(parent_local_dir, volume_name),
                os.path.join(parent_local_dir, f"{base_name}.cbz"),
                os.path.join(parent_local_dir, f"{base_name}.zip")
            ])

        vol_path_found = None
        for cand in candidate_volumes:
            if os.path.exists(cand) and not os.path.isdir(cand):
                vol_path_found = cand
                break

        if vol_path_found:
            v_res = delete_chapters_from_volume_py(vol_path_found, keys_list)
            pc_volume_action = v_res.get('action')
            pc_deleted_from_volume = v_res.get('deleted', 0)

        if exp_local_dir and os.path.isdir(exp_local_dir):
            pc_loose_deleted = delete_loose_chapters_local(exp_local_dir, keys_list, volume_path=vol_path_found)

        pc_res = {
            'status': 'success',
            'volume_action': pc_volume_action,
            'deleted_from_volume': pc_deleted_from_volume,
            'deleted_loose': pc_loose_deleted,
            'total_deleted': pc_deleted_from_volume + pc_loose_deleted
        }

    # 2. Delete on Kindle
    if target in ('kindle', 'both'):
        if not host:
            kindle_res = {'status': 'error', 'message': 'No Kindle host configured'}
        else:
            clean_remote = remote_folder.rstrip('/') if remote_folder else ''
            clean_base = remote_base.rstrip('/') if remote_base else (os.path.dirname(clean_remote) if '/' in clean_remote else clean_remote)

            # Ensure merge_volume.lua v3.1.0 on Kindle
            ensure_remote_merge_script(host, port, user, password=password, key_path=key_path)

            found_remote_path = find_remote_volume(
                host, port, user,
                volume_name=volume_name,
                remote_folder=clean_remote,
                remote_base=clean_base,
                password=password,
                key_path=key_path
            )

            ssh_bin = shutil.which('ssh') or '/usr/bin/ssh'
            ssh_auth_flags = [
                '-o', 'ConnectTimeout=6',
                '-o', 'StrictHostKeyChecking=accept-new',
                '-p', str(port)
            ]

            kindle_vol_res = None
            if found_remote_path:
                def esc_sh(val):
                    return "'" + val.replace("'", "'\\''") + "'"

                keys_sh = " ".join([esc_sh(k) for k in keys_list])
                lua_del_cmd = [
                    ssh_bin
                ] + ssh_auth_flags + [
                    f'{user}@{host}',
                    f"export LD_LIBRARY_PATH=/mnt/us/koreader/libs; nice -n 19 /mnt/us/koreader/luajit /mnt/us/koreader/merge_volume.lua --delete {esc_sh(found_remote_path)} {keys_sh}"
                ]
                res = execute_with_auth(lua_del_cmd, password=password, key_path=key_path, timeout=30)
                if res and res.returncode == 0:
                    out_lines = [l.strip() for l in res.stdout.splitlines() if l.strip().startswith('{')]
                    if out_lines:
                        try:
                            kindle_vol_res = json.loads(out_lines[-1])
                        except Exception:
                            pass

            # Also clean loose files on Kindle
            if clean_remote:
                loose_del_script = (
                    f"if [ -d '{clean_remote}' ]; then "
                    f"  for f in '{clean_remote}'/*; do "
                    f"    if [ -f \"$f\" ]; then "
                    f"      bf=$(basename \"$f\" | tr '[:upper:]' '[:lower:]'); "
                    + "".join([f"      if echo \"$bf\" | grep -E -q -i '(^|[^0-9.]){re.escape(k)}([^0-9.]|$)'; then rm -f \"$f\"; fi; " for k in keys_list[:30]]) +
                    f"    fi; "
                    f"  done; "
                    f"  rmdir '{clean_remote}' 2>/dev/null || true; "
                    f"fi"
                )
                loose_cmd = [ssh_bin] + ssh_auth_flags + [f'{user}@{host}', loose_del_script]
                execute_with_auth(loose_cmd, password=password, key_path=key_path, timeout=10)

            kindle_res = {
                'status': 'success',
                'volume_found': bool(found_remote_path),
                'volume_result': kindle_vol_res
            }

    return {
        'status': 'success',
        'target': target,
        'pc': pc_res,
        'kindle': kindle_res
    }

def main():
    while True:
        try:
            req = read_message()
            if req is None:
                break

            action = req.get('action')
            log_debug(f"Action: {action}")
            host = req.get('host', 'kindle.local')
            port = req.get('port', 2222)
            user = req.get('user', 'root')
            password = req.get('password') or None
            key_path = req.get('key_path') or None

            if action == 'ping':
                send_message({'status': 'ok', 'version': '1.0.0'})
            elif action == 'set_kindle_keep_awake':
                enable = req.get('enable', True)
                result = set_kindle_keep_awake(host, port, user, enable=enable, password=password, key_path=key_path)
                send_message(result)
            elif action == 'test_connection':
                result = test_ssh(host, port, user, password=password, key_path=key_path)
                send_message(result)
            elif action == 'scp_transfer':
                local_path = req.get('local_path', '')
                remote_path = req.get('remote_path', '/mnt/us/koreader/')
                force_overwrite = req.get('force_overwrite', False)
                metadata = req.get('metadata')
                result = scp_transfer(host, port, user, local_path, remote_path, password=password, key_path=key_path, force_overwrite=force_overwrite, metadata=metadata)
                send_message(result)
            elif action == 'list_files':
                path = req.get('path', '')
                files = get_folder_files(path)
                send_message({'status': 'success', 'files': files})
            elif action == 'choose_folder':
                prompt = req.get('prompt', 'Select download folder for manga:')
                chosen = choose_folder_dialog(prompt=prompt)
                if chosen:
                    send_message({'status': 'success', 'path': chosen})
                else:
                    send_message({'status': 'cancelled', 'path': None})
            elif action == 'relocate_file':
                source_path = req.get('source_path', '')
                dest_dir = req.get('dest_dir', '')
                result = relocate_file(source_path, dest_dir)
                send_message(result)
            elif action == 'cleanup_empty_dir':
                path = req.get('path', '')
                cleaned = cleanup_empty_dir(path)
                send_message({'status': 'success', 'cleaned': cleaned})
            elif action == 'delete_local_file':
                file_path = req.get('path', '')
                deleted = False
                try:
                    exp = os.path.expanduser(file_path)
                    downloads_dir = os.path.expanduser('~/Downloads')
                    if exp != downloads_dir:
                        if os.path.isfile(exp):
                            os.remove(exp)
                            deleted = True
                        elif os.path.isdir(exp):
                            shutil.rmtree(exp, ignore_errors=True)
                            deleted = True
                except Exception:
                    pass
                send_message({'status': 'success', 'deleted': deleted})
            elif action == 'write_file_chunk':
                file_path = req.get('file_path')
                chunk_b64 = req.get('chunk_b64', '')
                append = req.get('append', False)
                exp = os.path.expanduser(file_path)
                os.makedirs(os.path.dirname(exp), exist_ok=True)
                mode = 'ab' if append else 'wb'
                data = base64.b64decode(chunk_b64)
                with open(exp, mode) as f:
                    f.write(data)
                send_message({'status': 'success', 'path': exp})
            elif action == 'inspect_volume':
                volume_path = req.get('volume_path', '')
                result = inspect_volume(volume_path)
                send_message(result)
            elif action == 'inspect_remote_volume':
                remote_path = req.get('remote_path', '')
                result = inspect_remote_volume(host, port, user, remote_path, password=password, key_path=key_path)
                send_message(result)
            elif action == 'scan_archives':
                local_folder = req.get('local_folder', '')
                volume_name = req.get('volume_name', '')
                remote_folder = req.get('remote_folder', '')
                remote_base = req.get('remote_base', '')
                result = scan_archives(
                    local_folder,
                    volume_name,
                    remote_folder=remote_folder,
                    remote_base=remote_base,
                    host=host,
                    port=port,
                    user=user,
                    password=password,
                    key_path=key_path
                )
                send_message(result)
            elif action == 'append_to_volume':
                local_target_cbz = req.get('local_target_cbz', '')
                delta_zip_path = req.get('delta_zip_path', '')
                remote_folder = req.get('remote_folder', '')
                save_to_pc = req.get('save_to_pc', True)
                save_to_kindle = req.get('save_to_kindle', req.get('auto_transfer', True))
                known_remote_path = req.get('known_remote_path') or None
                metadata = req.get('metadata')
                result = append_to_volume(
                    local_target_cbz,
                    delta_zip_path,
                    remote_folder=remote_folder,
                    save_to_pc=save_to_pc,
                    save_to_kindle=save_to_kindle,
                    host=host,
                    port=port,
                    user=user,
                    password=password,
                    key_path=key_path,
                    known_remote_path=known_remote_path,
                    metadata=metadata
                )
                send_message(result)
            elif action == 'fix_koreader_metadata':
                local_path = req.get('local_path')
                remote_path = req.get('remote_path')
                metadata = req.get('metadata')
                if local_path:
                    ensure_koreader_sidecar_local(local_path, metadata=metadata)
                if remote_path:
                    try:
                        ensure_remote_merge_script(host, port, user, password=password, key_path=key_path)
                        fix_cmd = [
                            shutil.which('ssh') or '/usr/bin/ssh',
                            '-o', 'ConnectTimeout=4',
                            '-o', 'StrictHostKeyChecking=accept-new',
                            '-p', str(port),
                            f'{user}@{host}',
                            f"export LD_LIBRARY_PATH=/mnt/us/koreader/libs; /mnt/us/koreader/luajit /mnt/us/koreader/merge_volume.lua --fix-meta '{remote_path}' 2>/dev/null || true"
                        ]
                        execute_with_auth(fix_cmd, password=password, key_path=key_path, timeout=8)
                    except Exception:
                        pass
                send_message({'status': 'success'})
            elif action == 'delete_chapters':
                target = req.get('target', 'pc')
                local_folder = req.get('local_folder', '')
                volume_name = req.get('volume_name', '')
                remote_folder = req.get('remote_folder', '')
                remote_base = req.get('remote_base', '')
                chapter_keys = req.get('chapter_keys', [])
                result = delete_chapters(
                    target=target,
                    local_folder=local_folder,
                    volume_name=volume_name,
                    remote_folder=remote_folder,
                    remote_base=remote_base,
                    chapter_keys=chapter_keys,
                    host=host,
                    port=port,
                    user=user,
                    password=password,
                    key_path=key_path
                )
                send_message(result)
            else:
                send_message({'status': 'error', 'message': f'Unknown action: {action}'})
        except Exception as e:
            log_debug(f"Host error in {action if 'action' in locals() else 'unknown'}: {str(e)}")
            send_message({'status': 'error', 'message': f'Host error: {str(e)}'})

if __name__ == '__main__':
    main()

