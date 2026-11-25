"""Build a Tauri static manifest from the exact CI artifacts, failing closed."""
import json
import os
from pathlib import Path
import sys
from urllib.parse import quote

root = Path(sys.argv[1])
version = os.environ['VERSION']
repository = os.environ['REPOSITORY']
platforms = {}
for platform, suffix in (('linux-x86_64', '.AppImage'), ('windows-x86_64', '-setup.exe')):
    matches = [p for p in root.iterdir() if p.name.endswith(suffix)]
    if len(matches) != 1:
        raise SystemExit(f'Expected exactly one {suffix} artifact, found {len(matches)}')
    artifact = matches[0]
    signature = Path(str(artifact) + '.sig')
    if artifact.stat().st_size == 0 or not signature.is_file():
        raise SystemExit(f'Missing artifact or signature: {artifact}')
    signed = signature.read_text(encoding='utf-8').strip()
    if not signed:
        raise SystemExit(f'Empty signature: {signature}')
    url = f'https://github.com/{repository}/releases/download/v{version}/{quote(artifact.name)}'
    platforms[platform] = {'signature': signed, 'url': url}
manifest = {'version': version, 'notes': f'SS14 Studio {version}', 'platforms': platforms}
path = root / 'tauri-latest.json'
path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
assert json.loads(path.read_text(encoding='utf-8')) == manifest
