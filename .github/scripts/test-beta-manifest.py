import json
import os
from pathlib import Path
import runpy
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

with TemporaryDirectory() as directory:
    root = Path(directory)
    for name in ('studio.AppImage', 'studio-setup.exe'):
        (root / name).write_text('package')
        (root / (name + '.sig')).write_text('signature')
    env = {'VERSION': '0.1.5-beta.1', 'REPOSITORY': 'owner/repo'}
    with patch.dict(os.environ, env), patch.object(sys, 'argv', ['beta-manifest.py', directory]):
        runpy.run_path('.github/scripts/beta-manifest.py')
    manifest = json.loads((root / 'tauri-latest.json').read_text())
    assert manifest['version'] == env['VERSION']
    assert set(manifest['platforms']) == {'linux-x86_64', 'windows-x86_64'}
    assert manifest['platforms']['windows-x86_64']['url'].endswith('/v0.1.5-beta.1/studio-setup.exe')
    (root / 'studio-setup.exe.sig').unlink()
    with patch.dict(os.environ, env), patch.object(sys, 'argv', ['beta-manifest.py', directory]):
        try:
            runpy.run_path('.github/scripts/beta-manifest.py')
        except SystemExit:
            pass
        else:
            raise AssertionError('Missing signature must fail')
