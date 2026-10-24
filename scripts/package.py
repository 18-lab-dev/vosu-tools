#!/usr/bin/env python3
"""Build verified, deterministic tool packages and merge target catalogs (Python 3.11+)."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tomllib

from package_common import TARGETS, add_tree, atomic_json, published, release_url, valid_id, write_zip
from package_art import artwork, art_urls, publish_art

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Zlib',
           'OFL-1.1', 'Unicode-3.0', 'Unicode-DFS-2016', 'CC0-1.0', 'MPL-2.0', '0BSD', 'CDLA-Permissive-2.0'}


def run(command, cwd):
    return subprocess.run(command, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE).stdout


def selected_license(expression):
    """Evaluate SPDX AND/OR groups, selecting only an approved permissive branch."""
    tokens = re.findall(r'\(|\)|[A-Za-z0-9.+-]+', expression.replace('/', ' OR '))
    position = 0
    def atom():
        nonlocal position
        if position >= len(tokens):
            raise ValueError(f'incomplete license expression: {expression}')
        token = tokens[position]
        position += 1
        if token == '(':
            result = either()
            if position >= len(tokens) or tokens[position] != ')':
                raise ValueError(f'unbalanced license expression: {expression}')
            position += 1
            return result
        if token in ('AND', 'OR', 'WITH', ')'):
            raise ValueError(f'invalid license expression: {expression}')
        result = {token} if token in ALLOWED else None
        if position < len(tokens) and tokens[position] == 'WITH':
            position += 2
            if position > len(tokens):
                raise ValueError(f'missing license exception: {expression}')
            # Do not select an exception-bearing branch when another approved
            # alternative exists; new exceptions require an explicit policy decision.
            result = None
        return result
    def both():
        nonlocal position
        result = atom()
        while position < len(tokens) and tokens[position] == 'AND':
            position += 1
            other = atom()
            result = result | other if result is not None and other is not None else None
        return result
    def either():
        nonlocal position
        choices = [both()]
        while position < len(tokens) and tokens[position] == 'OR':
            position += 1
            choices.append(both())
        permitted = [choice for choice in choices if choice is not None]
        return min(permitted, key=lambda c: (len(c), 'MIT' not in c, sorted(c))) if permitted else None
    result = either()
    if position != len(tokens) or not result:
        raise ValueError(f'no approved license alternative: {expression}')
    return ' AND '.join(sorted(result))


def license_texts(directory, explicit=None):
    directory = Path(directory)
    paths = set()
    if explicit:
        path = directory / explicit
        if not path.is_file():
            raise ValueError(f'declared license file is missing: {path}')
        paths.add(path)
    for path in directory.iterdir():
        if path.is_file() and re.match(r'^(license|licence|copying|notice|copyright)([._-]|$)', path.name, re.I):
            paths.add(path)
        elif path.is_dir() and path.name.lower() in ('licenses', 'licences'):
            paths.update(item for item in path.rglob('*') if item.is_file())
    if not paths:
        for path in directory.rglob('*'):
            if len(path.relative_to(directory).parts) <= 3 and path.is_file() and re.match(r'^(license|licence|copying|notice)([._-]|$)', path.name, re.I):
                paths.add(path)
    result = {}
    for path in sorted(paths):
        if path.is_symlink():
            raise ValueError(f'license file must not be a symlink: {path}')
        name = path.relative_to(directory).as_posix() if path.is_relative_to(directory) else path.name
        result[name] = path.read_bytes()
    return result


def retained_license(root, dependency):
    # These published crate tarballs omit the monorepo's root license.
    # Bind each exception to the crate version AND its published VCS revision.
    dasp = {'dasp', 'dasp_envelope', 'dasp_frame', 'dasp_interpolate', 'dasp_peak',
            'dasp_ring_buffer', 'dasp_rms', 'dasp_sample', 'dasp_signal', 'dasp_slice', 'dasp_window'}
    name, version = dependency['name'], dependency['version']
    if name in dasp and version == ('0.11.1' if name == 'dasp_window' else '0.11.0'):
        revision = ('e4d535324f8b6c83d16c4f006a9ba3f07f3f147d' if name == 'dasp_window'
                    else '97c3bb9b2363c0b46ac1633858bf1054fd02a980' if name in ('dasp_sample', 'dasp_ring_buffer')
                    else '221b81038c528bf3fc364a8ab5cc4b2e52f7dbfc')
        path = root / 'scripts/licenses/dasp-MIT.txt'
        source = f'https://github.com/RustAudio/dasp/blob/{revision}/LICENSE-MIT'
    elif (name, version) == ('vorbis_rs', '0.5.6'):
        revision = '6934784e7188e98dd053370c79604c72b201e97a'
        path = root / 'tools/practice/licenses/audio.txt'
        source = f'https://github.com/ComunidadAylas/vorbis-rs/blob/{revision}/LICENSE'
    elif (name, version) in {('wasmi', '2.0.0'), ('wasmi_core', '2.0.0'), ('wasmi_ir', '2.0.0'), ('wasmi_collections', '2.0.0')}:
        revision = '2970aa871cc1001b57b267ccecdcd1e42306199e'
        path = root / 'tools/server-pp/licenses/wasmi-MIT.txt'
        source = f'https://github.com/wasmi-labs/wasmi/blob/{revision}/LICENSE-MIT'
    elif (name, version) == ('wasmparser', '0.228.0'):
        revision = 'e66235859a6ec0502bf6f9dcc358953eda4cafcc'
        path = root / 'tools/server-pp/licenses/wasm-tools-MIT.txt'
        source = f'https://github.com/bytecodealliance/wasm-tools/blob/{revision}/LICENSE-MIT'
    else:
        return {}, None
    vcs = Path(dependency['manifest_path']).parent / '.cargo_vcs_info.json'
    if not dependency.get('source', '').startswith('registry+') or json.loads(vcs.read_text())['git']['sha1'] != revision:
        raise ValueError(f'retained license exception revision mismatch: {name}@{version}')
    data = path.read_bytes().replace(b'\r\n', b'\n')
    # Git blob ids of the pinned upstream texts.
    blobs = {'dasp-MIT.txt': 'b35b54912ac435a64227b09c9347475caefa1cbd',
             'wasmi-MIT.txt': '1399b075915d94e530b1aa7de1938139d713ab31',
             'wasm-tools-MIT.txt': '31aa79387f27e730e33d871925e152e35e428031'}
    if path.name in blobs and hashlib.sha1(f'blob {len(data)}'.encode() + bytes([0]) + data).hexdigest() != blobs[path.name]:
        raise ValueError(f'retained {path.name} differs from its pinned upstream blob')
    return {path.name: data}, source


def rust_licenses(root, metadata, package, target):
    tree = run(['cargo', 'tree', '--locked', '-e', 'normal', '--target', target, '-p', package,
                '--prefix', 'none', '--format', '{p}'], root)
    identities = set()
    for line in tree.splitlines():
        match = re.fullmatch(r'(\S+) v(\S+)(?: \((.*)\))?', line.removesuffix(' (*)').removesuffix(' (proc-macro)'))
        if not match:
            raise ValueError(f'unrecognized cargo tree package identity: {line}')
        name, version, location = match.groups()
        candidates = []
        for dependency in metadata['packages']:
            if (dependency['name'], dependency['version']) != (name, version):
                continue
            source = dependency.get('source')
            if source is None:
                matches = location == str(Path(dependency['manifest_path']).parent)
            elif source.startswith('registry+'):
                matches = location is None
            elif source.startswith('git+') and location:
                origin, _, revision = source[4:].partition('#')
                displayed_origin, _, displayed_revision = location.partition('#')
                matches = origin == displayed_origin and revision.startswith(displayed_revision)
            else:
                matches = False
            if matches:
                candidates.append(dependency['id'])
        if len(candidates) != 1:
            raise ValueError(f'cargo tree identity is missing/ambiguous in metadata: {line}')
        identities.add(candidates[0])
    files, inventory = {}, []
    for dependency in sorted(metadata['packages'], key=lambda p: p['id']):
        if dependency['id'] not in identities:
            continue
        expression = dependency.get('license')
        if not expression:
            raise ValueError(f"missing license metadata: {dependency['id']}")
        selected = selected_license(expression)
        directory = Path(dependency['manifest_path']).parent
        texts = license_texts(directory, dependency.get('license_file'))
        if not texts and dependency.get('source') is None and directory.is_relative_to(root):
            # Workspace-owned crates inherit the repository's license texts.
            texts = license_texts(root)
        license_source = None
        if not texts:
            texts, license_source = retained_license(root, dependency)
        if not texts:
            raise ValueError(f"no retained license text for {dependency['id']} in {directory}")
        source = dependency.get('source') or 'workspace'
        suffix = hashlib.sha256(source.encode()).hexdigest()[:8]
        prefix = f"licenses/rust/{dependency['name']}-{dependency['version']}-{suffix}/"
        files.update({prefix + name: data for name, data in texts.items()})
        inventory.append({'ecosystem': 'cargo', 'name': dependency['name'], 'version': dependency['version'],
                          'source': source, 'license': expression, 'selected_license': selected,
                          'license_source': license_source})
    if not identities:
        raise ValueError(f'cargo tree returned no linked packages for {package}')
    return files, inventory


def jsonc(text):
    """Bun's text lock is JSON with trailing commas; preserve quoted strings."""
    output, quoted, escaped = [], False, False
    for index, character in enumerate(text):
        if quoted:
            output.append(character)
            if escaped:
                escaped = False
            elif character == '\\':
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
            output.append(character)
        elif character != ',' or text[index + 1:].lstrip()[:1] not in ('}', ']'):
            output.append(character)
    return json.loads(''.join(output))


def javascript_licenses(root, dist):
    lock = jsonc((root / 'bun.lock').read_text())
    workspace_names = {workspace['name'] for workspace in lock.get('workspaces', {}).values()}
    locked = {entry[0] for entry in lock.get('packages', {}).values()}
    packages = {}
    maps = list(dist.rglob('*.map'))
    if not maps:
        raise ValueError(f'UI build must emit hidden source maps for license provenance: {dist}')
    for source_map in maps:
        mapping = json.loads(source_map.read_text())
        for source in mapping.get('sources', []):
            candidate = (source_map.parent / source).resolve()
            for parent in candidate.parents:
                manifest = parent / 'package.json'
                if not manifest.is_file():
                    continue
                data = json.loads(manifest.read_text())
                name, version = data.get('name'), data.get('version')
                if name in workspace_names:
                    break
                if 'node_modules' not in parent.parts:
                    continue
                if f'{name}@{version}' not in locked:
                    raise ValueError(f'bundled JavaScript package is not in bun.lock: {name}@{version}')
                packages[(name, version)] = (parent, data)
                break
    files, inventory = {}, []
    for (name, version), (directory, data) in sorted(packages.items()):
        expression = data.get('license')
        if not isinstance(expression, str):
            raise ValueError(f'missing SPDX license metadata for JavaScript package {name}@{version}')
        selected = selected_license(expression)
        texts = license_texts(directory)
        if not texts:
            raise ValueError(f'missing JavaScript license text: {name}@{version}')
        prefix = f"licenses/npm/{name.replace('/', '_')}-{version}/"
        files.update({prefix + path: body for path, body in texts.items()})
        inventory.append({'ecosystem': 'bun', 'name': name, 'version': version,
                          'license': expression, 'selected_license': selected})
    return files, inventory


def discover(root):
    result = []
    for directory in sorted((root / 'tools').iterdir()):
        if not directory.is_dir():
            continue
        manifest_path = directory / 'tool.toml'
        if not manifest_path.is_file() or manifest_path.is_symlink():
            raise ValueError(f'tool.toml is missing or unsafe: {directory}')
        manifest = tomllib.loads(manifest_path.read_text())
        identity, version = manifest.get('id', ''), manifest.get('version', '')
        if not valid_id(identity) or directory.name != identity or not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?', version):
            raise ValueError(f'invalid tool identity/version in {manifest_path}')
        if manifest.get('manifest_version') != 1:
            raise ValueError(f'unsupported manifest version: {manifest_path}')
        artwork(directory, manifest, required=True)
        service = manifest.get('service')
        if service is not None:
            role = service.get('role', 'background')
            if role not in ('background', 'backend'):
                raise ValueError(f'invalid service role: {manifest_path}')
            if role == 'backend' and service.get('startup', 'on-demand') != 'on-demand':
                raise ValueError(f'backend service must start on-demand: {manifest_path}')
        native = 'service' in manifest or 'cli' in manifest
        cargo = directory / 'Cargo.toml'
        package = tomllib.loads(cargo.read_text())['package']['name'] if native else None
        if 'ui' in manifest and manifest['ui']['root'] != 'web/dist':
            raise ValueError(f'UI manifest root must be web/dist: {manifest_path}')
        for section in ('cli', 'service'):
            if section in manifest and manifest[section]['command'][0] != f'bin/vosu-{identity}':
                raise ValueError(f'expected bin/vosu-{identity} in [{section}]')
        result.append((directory, manifest, package))
    if not result:
        raise ValueError('workspace contains no tools')
    return result


def build(root, target, tools):
    for directory, manifest, package in tools:
        if package:
            subprocess.run(['cargo', 'build', '--release', '--locked', '--target', target, '-p', package], cwd=root, check=True)
        if 'ui' in manifest:
            subprocess.run(['bun', 'run', 'build', '--sourcemap', 'hidden'], cwd=directory / 'web', check=True)


def assemble(root, out, target, base_url, metadata, tools):
    catalog = {'catalog_version': 1, 'tools': []}
    target_directory = Path(metadata['target_directory'])
    for directory, manifest, package in tools:
        identity, version = manifest['id'], manifest['version']
        files = {'tool.toml': (directory / 'tool.toml').read_bytes()}
        art = artwork(directory, manifest, required=True)
        files.update({path: data for path, data in art.values()})
        for name in ('LICENSE-MIT', 'LICENSE-APACHE', 'THIRD_PARTY_NOTICES.md'):
            if not (root / name).is_file():
                raise ValueError(f'missing repository notice: {name}')
            files[f'licenses/{name}'] = (root / name).read_bytes()
        if (directory / 'licenses').exists():
            add_tree(files, directory / 'licenses', 'licenses/tool')
        if (directory / 'settings.json').exists():
            files['settings.json'] = (directory / 'settings.json').read_bytes()
        inventory = []
        if package:
            suffix = '.exe' if target == 'x86_64-pc-windows-msvc' else ''
            executable = f'vosu-{identity}{suffix}'
            files[f'bin/{executable}'] = (target_directory / target / 'release' / executable).read_bytes()
            if suffix:
                text = files['tool.toml'].decode()
                text = re.sub(r"([\"'])" + re.escape(f'bin/vosu-{identity}') + r"\1", lambda m: m[1] + f'bin/{executable}' + m[1], text)
                files['tool.toml'] = text.encode()
            notices, packages = rust_licenses(root, metadata, package, target)
            files.update(notices)
            inventory.extend(packages)
        if 'ui' in manifest:
            dist = directory / 'web/dist'
            notices, packages = javascript_licenses(root, dist)
            files.update(notices)
            inventory.extend(packages)
            ui = {}
            add_tree(ui, dist)
            files.update({'web/dist/' + name: data for name, data in ui.items() if not name.endswith('.map')})
        files['licenses/dependencies.json'] = (json.dumps(inventory, indent=2, sort_keys=True) + '\n').encode()
        package_target = target if package else 'any'
        filename = f'vosu-tool-{identity}-{version}-{package_target}.zip'
        integrity = write_zip(out / filename, files, 'tool', (identity, version))
        entry = {key: manifest.get(key, '') for key in ('id', 'name', 'version', 'description', 'author')}
        entry.update({'homepage': manifest.get('homepage'), 'protocol': 1,
                      'interfaces': [section for section in ('ui', 'service', 'cli')
                                     if section in manifest and (section != 'service'
                                     or manifest['service'].get('role', 'background') == 'background')],
                      'requires': manifest.get('requires', []),
                      'packages': {package_target: {'url': release_url(base_url, filename), **integrity}}})
        publish_art(art, identity, 'tool', out)
        entry.update(art_urls(art, identity, 'tool', base_url))
        catalog['tools'].append(entry)
        print(f'{identity}\t{package_target}\t{integrity["size"]}\t{integrity["sha256"]}')
    return catalog


def merge_catalogs(paths):
    result = {'catalog_version': 1, 'tools': []}
    tools = {}
    for path in paths:
        catalog = json.loads(Path(path).read_text())
        if catalog.get('catalog_version') != 1:
            raise ValueError(f'unsupported catalog: {path}')
        for entry in catalog.get('tools', []):
            if entry['id'] not in tools:
                tools[entry['id']] = entry
                continue
            prior = tools[entry['id']]
            if {k: v for k, v in prior.items() if k != 'packages'} != {k: v for k, v in entry.items() if k != 'packages'}:
                raise ValueError(f'conflicting tool metadata for {entry["id"]}')
            for target, package in entry['packages'].items():
                if target in prior['packages'] and prior['packages'][target] != package:
                    raise ValueError(f'conflicting target package for {entry["id"]}/{target}')
                prior['packages'][target] = package
    result['tools'] = [tools[key] for key in sorted(tools)]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--out', type=Path, default=Path('dist'))
    parser.add_argument('--target', choices=TARGETS)
    parser.add_argument('--base-url', required=True, help='release asset directory, e.g. https://github.com/18-lab-dev/vosu-tools/releases/download/v0.1.0')
    parser.add_argument('--name', default='18-LAB official tools')
    parser.add_argument('--published')
    parser.add_argument('--skip-build', action='store_true', help='package already-built binaries and hidden-sourcemap UI outputs')
    parser.add_argument('--native-only', action='store_true', help='omit universal UI-only packages (release builds publish those once from Linux)')
    parser.add_argument('--dry-run', action='store_true', help='validate manifests and print the exact release build plan without building/writing')
    parser.add_argument('--merge-catalogs', type=Path, nargs='+')
    args = parser.parse_args()
    try:
        root, out = args.root.resolve(), args.out.resolve()
        release_url(args.base_url, 'catalog.json')
        if args.merge_catalogs:
            if args.dry_run or args.target or args.skip_build:
                raise ValueError('catalog merging cannot be combined with build options')
            catalog = merge_catalogs(args.merge_catalogs)
        else:
            if not args.target:
                raise ValueError('--target is required when building packages')
            tools = discover(root)
            if args.native_only:
                tools = [tool for tool in tools if tool[2]]
            if args.dry_run:
                for directory, manifest, package in tools:
                    print(json.dumps({'id': manifest['id'], 'target': args.target if package else 'any',
                                      'cargo': ['cargo', 'build', '--release', '--locked', '--target', args.target, '-p', package] if package else None,
                                      'ui': str(directory / 'web') if 'ui' in manifest else None,
                                      **art_urls(artwork(directory, manifest, required=True), manifest['id'], 'tool', args.base_url)}, sort_keys=True))
                return 0
            if not args.skip_build:
                build(root, args.target, tools)
            metadata = json.loads(run(['cargo', 'metadata', '--locked', '--format-version', '1', '--filter-platform', args.target], root))
            catalog = assemble(root, out, args.target, args.base_url, metadata, tools)
        catalog.update({'name': args.name, 'published': published(args.published)})
        atomic_json(out / 'catalog.json', catalog)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
