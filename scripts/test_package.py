#!/usr/bin/env python3
import contextlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch
import zipfile

import package
from package_common import add_tree, validate_files, write_zip


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.tool = self.root / 'tools/example'
        (self.tool / 'web/dist/assets').mkdir(parents=True)
        self.manifest = '''manifest_version=1
id="example"
name="Example"
version="1.2.3"
author="18-LAB"
icon="icon.svg"
banner="banner.svg"
[ui]
root="web/dist"
[service]
command=["bin/vosu-example"]
[cli]
command=["bin/vosu-example", "cli"]
'''
        (self.tool / 'tool.toml').write_text(self.manifest)
        (self.tool / 'Cargo.toml').write_text('[package]\nname="vosu-example"\nversion="1.2.3"\n')
        (self.tool / 'icon.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>')
        (self.tool / 'banner.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 400"/>')
        (self.tool / 'web/dist/index.html').write_text('<h1>Example</h1>')
        (self.tool / 'web/dist/assets/app.js').write_text('console.log("example")')
        (self.tool / 'web/dist/assets/app.js.map').write_text(json.dumps({'sources': []}))
        (self.root / 'bun.lock').write_text('{"workspaces":{},"packages":{},}')
        for name in ['LICENSE-MIT', 'LICENSE-APACHE', 'THIRD_PARTY_NOTICES.md']:
            (self.root / name).write_text(name + '\n')
        self.metadata = {'target_directory': str(self.root / 'target'), 'packages': []}
        for target in package.TARGETS:
            folder = self.root / 'target' / target / 'release'
            folder.mkdir(parents=True)
            (folder / ('vosu-example.exe' if 'windows' in target else 'vosu-example')).write_bytes(b'test fixture binary')

    def assemble(self, target='x86_64-unknown-linux-gnu'):
        with patch.object(package, 'rust_licenses', return_value=({'licenses/rust/example/LICENSE': b'MIT'}, [])), contextlib.redirect_stdout(io.StringIO()):
            return package.assemble(self.root, self.root / 'dist', target, 'https://example.com/releases/v1', self.metadata, package.discover(self.root))

    def test_utf8_manifests_and_source_maps(self):
        (self.tool / 'tool.toml').write_text(self.manifest.replace('name="Example"', 'name="ā"'), encoding='utf-8')
        (self.tool / 'web/dist/assets/app.js.map').write_text(
            json.dumps({'sources': [], 'sourcesContent': ['ā']}, ensure_ascii=False), encoding='utf-8')
        self.assertEqual(self.assemble()['tools'][0]['name'], 'ā')

    def test_utf8_cargo_output(self):
        self.assertEqual(package.run([sys.executable, '-c', "import sys; sys.stdout.buffer.write(bytes([196, 129]))"], self.root), 'ā')

    def test_art_is_packaged_and_published(self):
        entry = self.assemble()['tools'][0]
        for role in ('icon', 'banner'):
            name = f'vosu-tool-example-{role}.svg'
            self.assertEqual(entry[role + '_url'], 'https://example.com/releases/v1/' + name)
            self.assertEqual((self.root / 'dist' / name).read_bytes(), (self.tool / (role + '.svg')).read_bytes())
        with zipfile.ZipFile(next((self.root / 'dist').glob('*.zip'))) as archive:
            self.assertEqual(archive.read('banner.svg'), (self.tool / 'banner.svg').read_bytes())

    def test_missing_art_rejected(self):
        (self.tool / 'tool.toml').write_text(self.manifest.replace('icon="icon.svg"\n', ''))
        with self.assertRaises(ValueError):
            package.discover(self.root)

    def test_deterministic_archive_integrity_and_modes(self):
        first = self.assemble()
        path = next((self.root / 'dist').glob('*.zip'))
        original = path.read_bytes()
        second = self.assemble()
        self.assertEqual(first, second)
        self.assertEqual(original, path.read_bytes())
        self.assertEqual(first['tools'][0]['packages'][package.TARGETS[0]]['size'], len(original))
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(archive.namelist(), sorted(archive.namelist()))
            self.assertNotIn('web/dist/assets/app.js.map', archive.namelist())
            for entry in archive.infolist():
                self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertTrue(stat.S_ISREG(entry.external_attr >> 16))
                self.assertEqual((entry.external_attr >> 16) & 0o777, 0o755 if entry.filename.startswith('bin/') else 0o644)

    def test_windows_executable_and_manifest(self):
        self.assemble('x86_64-pc-windows-msvc')
        path = next((self.root / 'dist').glob('*.zip'))
        with zipfile.ZipFile(path) as archive:
            manifest = tomllib.loads(archive.read('tool.toml').decode())
            self.assertEqual(manifest['service']['command'][0], 'bin/vosu-example.exe')
            self.assertEqual(manifest['cli']['command'][0], 'bin/vosu-example.exe')
            self.assertIn('bin/vosu-example.exe', archive.namelist())

    def test_background_service_is_default_interface(self):
        self.assertEqual(self.assemble()['tools'][0]['interfaces'], ['ui', 'service', 'cli'])

    def test_backend_interface_and_native_package(self):
        (self.tool / 'tool.toml').write_text(self.manifest.replace(
            '[service]\n', '[service]\nrole="backend"\nstartup="on-demand"\n'))
        entry = self.assemble()['tools'][0]
        self.assertEqual(entry['interfaces'], ['ui', 'cli'])
        self.assertEqual(list(entry['packages']), [package.TARGETS[0]])

    def test_invalid_service_roles_and_backend_startup(self):
        for fields in ('role="worker"', 'role="backend"\nstartup="always"'):
            with self.subTest(fields=fields):
                (self.tool / 'tool.toml').write_text(self.manifest.replace(
                    '[service]\n', '[service]\n' + fields + '\n'))
                with self.assertRaises(ValueError):
                    package.discover(self.root)

    def test_ui_only_uses_any_target(self):
        (self.tool / 'tool.toml').write_text(self.manifest.split('[service]')[0])
        (self.tool / 'Cargo.toml').unlink()
        result = self.assemble()
        self.assertEqual(list(result['tools'][0]['packages']), ['any'])
        self.assertTrue((self.root / 'dist/vosu-tool-example-1.2.3-any.zip').is_file())

    def test_hostile_entries_and_invalid_manifests(self):
        for name in ['../escape', '/absolute', 'a/../../b', 'a\\b', 'C:/file', 'a/./file']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_files({name: b'x', 'index.html': b'x'}, 'overlay')
        with self.assertRaises(ValueError):
            validate_files({'index.html': b'x', 'file': b'x', 'file/child': b'x'}, 'overlay')
        with self.assertRaises(ValueError):
            validate_files({'tool.toml': self.manifest.encode()}, 'tool', ('different', '1.2.3'))
        with self.assertRaises(ValueError):
            validate_files({'missing': b'x'}, 'overlay')
        with self.assertRaises(ValueError):
            validate_files({f'entry{i}': b'' for i in range(10001)}, 'overlay')
        if hasattr(os, 'symlink'):
            try:
                (self.tool / 'web/dist/link').symlink_to(self.root / 'LICENSE-MIT')
            except OSError:
                self.skipTest('symlinks unavailable to this Windows account')
            with self.assertRaises(ValueError):
                add_tree({}, self.tool / 'web/dist')

    def test_failed_validation_does_not_replace_archive(self):
        destination = self.root / 'existing.zip'
        destination.write_bytes(b'previous release')
        with self.assertRaises(ValueError):
            write_zip(destination, {'../bad': b'x'}, 'overlay')
        self.assertEqual(destination.read_bytes(), b'previous release')

    def test_vosu_120_fake_end_record(self):
        fake = bytearray(22)
        fake[:4] = b'PK\x05\x06'
        fake[10:12] = (31_185).to_bytes(2, 'little')
        path = self.root / 'fake.zip'
        with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_STORED) as archive:
            archive.writestr('index.html', fake)
        with self.assertRaisesRegex(ValueError, r'fake.zip.*offset 40:.*31185'):
            package.check_vosu_120_zip(path)
        # Re-encoding the same content removes the false signature.
        write_zip(path, {'index.html': bytes(fake)}, 'overlay')
        package.check_vosu_120_zip(path)
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(archive.read('index.html'), fake)

    def test_vosu_120_zip64_candidates(self):
        for count, length, offset, expected in [
                (31_185, 44, 0, '31185'), (1, 43, 0, 'ambiguous'),
                (1, 44, 1, 'invalid'), (1, 44, 0, None)]:
            with self.subTest(count=count, length=length, offset=offset):
                record = bytearray(56)
                record[:4] = b'PK\x06\x06'
                record[4:12] = length.to_bytes(8, 'little')
                record[32:40] = count.to_bytes(8, 'little')
                locator = bytearray(20)
                locator[:4] = b'PK\x06\x07'
                locator[8:16] = offset.to_bytes(8, 'little')
                end = bytearray(22)
                end[:4] = b'PK\x05\x06'
                path = self.root / 'zip64.zip'
                path.write_bytes(record + locator + end)
                if expected:
                    with self.assertRaisesRegex(ValueError, f'offset 76:.*{expected}'):
                        package.check_vosu_120_zip(path)
                else:
                    package.check_vosu_120_zip(path)

    def test_vosu_120_truncated_comment_is_not_candidate(self):
        path = self.root / 'comment.zip'
        write_zip(path, {'index.html': b'hello'}, 'overlay')
        fake = bytearray(22)
        fake[:4] = b'PK\x05\x06'
        fake[10:12] = (31_185).to_bytes(2, 'little')
        fake[20:22] = (100).to_bytes(2, 'little')
        path.write_bytes(path.read_bytes() + fake)
        package.check_vosu_120_zip(path)

    def test_vosu_120_encoding_retry_is_deterministic(self):
        from package_common import check_vosu_120_zip
        path = self.root / 'retry.zip'
        results = []
        for _ in range(2):
            calls = 0
            def check(candidate):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise ValueError(f'{candidate}: vosu 1.2.0 ZIP preflight at offset 42: entry limit exceeded')
                check_vosu_120_zip(candidate)
            with patch('package_common.check_vosu_120_zip', side_effect=check):
                write_zip(path, {'index.html': b'hello' * 1000}, 'overlay')
            self.assertEqual(calls, 2)
            results.append(path.read_bytes())
        self.assertEqual(*results)

    def test_spdx_selects_permissive_alternative_and_preserves_and(self):
        for expression in ['MIT/Apache-2.0', 'GPL-3.0-only OR MIT', 'Apache-2.0 WITH LLVM-exception OR MIT']:
            self.assertEqual(package.selected_license(expression), 'MIT')
        self.assertEqual(package.selected_license('(MIT OR Apache-2.0) AND Unicode-3.0'), 'MIT AND Unicode-3.0')
        self.assertEqual(package.selected_license('ISC AND (Apache-2.0 OR ISC)'), 'Apache-2.0 AND ISC')
        for expression in ['GPL-3.0-only', 'MIT AND GPL-3.0-only', '(MIT', '', 'MIT OR']:
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                package.selected_license(expression)

    def test_rust_licenses_follow_normal_target_tree(self):
        registry = self.root / 'registry/dependency'
        registry.mkdir(parents=True)
        (registry / 'LICENSE').write_text('copyright and MIT license text')
        metadata = {'packages': [
            {'id': 'dep', 'name': 'dependency', 'version': '1.0.0', 'manifest_path': str(registry / 'Cargo.toml'), 'license': 'MIT', 'source': 'registry+test'},
            {'id': 'unlinked-git', 'name': 'dependency', 'version': '1.0.0', 'manifest_path': '/not-linked', 'license': 'GPL-3.0-only', 'source': 'git+https://example.com/unused#1234'},
            {'id': 'build-only', 'name': 'build-only', 'version': '2.0.0', 'manifest_path': '/not-used', 'license': 'GPL-3.0-only', 'source': 'registry+test'}]}
        with patch.object(package, 'run', return_value='dependency v1.0.0 (proc-macro)\n') as command:
            files, inventory = package.rust_licenses(self.root, metadata, 'vosu-example', package.TARGETS[0])
        self.assertEqual(inventory[0]['name'], 'dependency')
        self.assertEqual(len(inventory), 1)
        self.assertTrue(any(path.endswith('/LICENSE') for path in files))
        self.assertIn('normal', command.call_args.args[0])
        self.assertIn(package.TARGETS[0], command.call_args.args[0])

    def test_javascript_license_provenance_uses_maps_and_lock(self):
        npm = self.root / 'node_modules/third-party'
        npm.mkdir(parents=True)
        (npm / 'package.json').write_text(json.dumps({'name': 'third-party', 'version': '1.0.0', 'license': 'MIT'}))
        (npm / 'LICENSE').write_text('MIT copyright')
        source_map = self.tool / 'web/dist/assets/app.js.map'
        source_map.write_text(json.dumps({'sources': [os.path.relpath(npm / 'index.js', source_map.parent)]}))
        (self.root / 'bun.lock').write_text('{"workspaces":{},"packages":{"third-party":["third-party@1.0.0","",{},"sha512-test"],},}')
        files, inventory = package.javascript_licenses(self.root, self.tool / 'web/dist')
        self.assertEqual(inventory[0]['name'], 'third-party')
        self.assertIn('licenses/npm/third-party-1.0.0/LICENSE', files)
        (self.root / 'bun.lock').write_text('{"workspaces":{},"packages":{}}')
        with self.assertRaises(ValueError):
            package.javascript_licenses(self.root, self.tool / 'web/dist')

    def test_catalog_merge_and_conflict(self):
        linux = self.assemble()
        windows = self.assemble('x86_64-pc-windows-msvc')
        paths = [self.root / 'linux.json', self.root / 'windows.json']
        for path, value in zip(paths, [linux, windows]):
            path.write_text(json.dumps(value))
        merged = package.merge_catalogs(paths)
        self.assertEqual(set(merged['tools'][0]['packages']), set(package.TARGETS))
        windows['tools'][0]['version'] = '9.0.0'
        paths[1].write_text(json.dumps(windows))
        with self.assertRaises(ValueError):
            package.merge_catalogs(paths)

    def test_dry_run_has_no_build_or_output_side_effects(self):
        with patch.object(package.subprocess, 'run') as command, patch.object(package.sys, 'argv', ['package.py', '--root', str(self.root), '--target', package.TARGETS[0], '--out', str(self.root / 'dry'), '--base-url', 'https://example.com/release', '--dry-run']), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(package.main(), 0)
        command.assert_not_called()
        self.assertFalse((self.root / 'dry').exists())


    def test_retained_monorepo_license_is_bound_to_version_revision_and_blob(self):
        directory = self.root / 'registry/dasp'
        directory.mkdir(parents=True)
        vcs = directory / '.cargo_vcs_info.json'
        vcs.write_text(json.dumps({'git': {'sha1': '221b81038c528bf3fc364a8ab5cc4b2e52f7dbfc'}}))
        retained = self.root / 'scripts/licenses/dasp-MIT.txt'
        retained.parent.mkdir(parents=True)
        retained.write_bytes((package.ROOT / 'scripts/licenses/dasp-MIT.txt').read_bytes())
        dependency = {'name': 'dasp', 'version': '0.11.0', 'source': 'registry+test', 'manifest_path': str(directory / 'Cargo.toml')}
        texts, source = package.retained_license(self.root, dependency)
        self.assertIn('dasp-MIT.txt', texts)
        self.assertIn('221b81038c528bf3fc364a8ab5cc4b2e52f7dbfc', source)
        retained.write_text('altered license')
        with self.assertRaises(ValueError):
            package.retained_license(self.root, dependency)
        vcs.write_text(json.dumps({'git': {'sha1': 'wrong'}}))
        with self.assertRaises(ValueError):
            package.retained_license(self.root, dependency)

    def test_retained_wasmi_and_wasmparser_licenses_are_pinned(self):
        cases = [('wasmi', '2.0.0', '2970aa871cc1001b57b267ccecdcd1e42306199e', 'wasmi-MIT.txt'),
                 ('wasmi_core', '2.0.0', '2970aa871cc1001b57b267ccecdcd1e42306199e', 'wasmi-MIT.txt'),
                 ('wasmi_ir', '2.0.0', '2970aa871cc1001b57b267ccecdcd1e42306199e', 'wasmi-MIT.txt'),
                 ('wasmi_collections', '2.0.0', '2970aa871cc1001b57b267ccecdcd1e42306199e', 'wasmi-MIT.txt'),
                 ('wasmparser', '0.228.0', 'e66235859a6ec0502bf6f9dcc358953eda4cafcc', 'wasm-tools-MIT.txt')]
        licenses = self.root / 'tools/server-pp/licenses'
        licenses.mkdir(parents=True)
        for name, version, revision, text in cases:
            retained = licenses / text
            retained.write_bytes((package.ROOT / 'tools/server-pp/licenses' / text).read_bytes())
            directory = self.root / 'registry' / name
            directory.mkdir(parents=True)
            vcs = directory / '.cargo_vcs_info.json'
            vcs.write_text(json.dumps({'git': {'sha1': revision}}))
            dependency = {'name': name, 'version': version, 'source': 'registry+test', 'manifest_path': str(directory / 'Cargo.toml')}
            texts, source = package.retained_license(self.root, dependency)
            self.assertIn(text, texts)
            self.assertIn(revision, source)
            self.assertEqual(package.retained_license(self.root, {**dependency, 'version': '9.9.9'}), ({}, None))
            vcs.write_text(json.dumps({'git': {'sha1': 'wrong'}}))
            with self.assertRaises(ValueError):
                package.retained_license(self.root, dependency)
            vcs.write_text(json.dumps({'git': {'sha1': revision}}))
            original = retained.read_bytes()
            retained.write_text('altered license')
            with self.assertRaises(ValueError):
                package.retained_license(self.root, dependency)
            retained.write_bytes(original)


if __name__ == '__main__':
    unittest.main()

