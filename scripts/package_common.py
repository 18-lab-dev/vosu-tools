"""Standard-library release archive validation and deterministic serialization."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
from urllib.parse import urlsplit
import zipfile

MAX_ENTRIES = 10_000
MAX_EXPANDED = 512 * 1024 * 1024
TARGETS = ('x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc')


def valid_id(value):
    return bool(re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,31}', value))


def https_url(value):
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError(f'expected an HTTPS release URL without credentials/fragment: {value}')
    return value


def add_tree(files, source, destination=''):
    source = Path(source)
    if source.is_symlink() or not source.is_dir():
        raise ValueError(f'package input must be a real directory: {source}')
    for path in sorted(source.rglob('*')):
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise ValueError(f'non-regular package input: {path}')
        if path.is_file():
            name = PurePosixPath(destination, path.relative_to(source).as_posix()).as_posix()
            if name in files:
                raise ValueError(f'duplicate package member: {name}')
            files[name] = path.read_bytes()


def validate_files(files, kind, identity=None):
    if not files or len(files) > MAX_ENTRIES or sum(map(len, files.values())) > MAX_EXPANDED:
        raise ValueError('archive entry/expanded-size limit exceeded')
    paths = set()
    for name in files:
        path = PurePosixPath(name)
        if not name or '\\' in name or ':' in name or '\0' in name or path.is_absolute() or any(p in ('', '.', '..') for p in name.split('/')):
            raise ValueError(f'unsafe archive path: {name}')
        for parent in path.parents:
            if parent.as_posix() != '.':
                if parent.as_posix() in files:
                    raise ValueError(f'file/directory collision: {name}')
                paths.add(parent.as_posix())
        paths.add(name)
    if len(paths) + 1 > MAX_ENTRIES:
        raise ValueError('archive implicit-directory entry limit exceeded')
    if kind == 'tool':
        import tomllib
        manifest = tomllib.loads(files['tool.toml'].decode('utf-8'))
        if manifest.get('manifest_version') != 1 or (manifest.get('id'), manifest.get('version')) != identity:
            raise ValueError('tool manifest id/version differs from catalog')
        if 'ui' in manifest:
            if manifest['ui']['root'] != 'web/dist' or 'web/dist/index.html' not in files:
                raise ValueError('tool UI must contain web/dist/index.html')
        for section in ('cli', 'service'):
            if section in manifest:
                command = manifest[section]['command']
                if not command or command[0] not in files:
                    raise ValueError(f'{section} executable is missing from package')
    elif kind == 'overlay':
        if 'index.html' not in files:
            raise ValueError('overlay index.html is missing from archive root')
    else:
        raise ValueError(f'unknown package kind: {kind}')


def write_zip(path, files, kind, identity=None):
    validate_files(files, kind, identity)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name, delete=False)
    temporary.close()
    try:
        with zipfile.ZipFile(temporary.name, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | (0o755 if name.startswith('bin/') else 0o644)) << 16
                archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        with zipfile.ZipFile(temporary.name) as archive:
            if archive.testzip() is not None:
                raise ValueError('generated ZIP failed CRC validation')
        os.replace(temporary.name, path)
    finally:
        Path(temporary.name).unlink(missing_ok=True)
    return {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'size': path.stat().st_size}


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, mode='w', encoding='utf-8', newline='\n', delete=False) as output:
        temporary = Path(output.name)
        json.dump(value, output, indent=2, sort_keys=True)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def published(value=None):
    if value:
        datetime.fromisoformat(value.replace('Z', '+00:00'))
        return value
    epoch = os.environ.get('SOURCE_DATE_EPOCH')
    date = datetime.fromtimestamp(int(epoch), timezone.utc) if epoch else datetime.now(timezone.utc)
    return date.replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def release_url(base, filename):
    return https_url(base.rstrip('/') + '/' + filename)
