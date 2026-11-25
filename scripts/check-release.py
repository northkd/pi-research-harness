#!/usr/bin/env python3
"""Bounded local publication audit; reports paths/rule names, never secret values."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {'.git', '.runtime', 'node_modules', '__pycache__', '.ruff_cache'}
PATTERNS = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'credential-token': re.compile(r'\b(?:ghp_|github_pat_|sk-proj-|sk-ant-)[A-Za-z0-9_-]{16,}'),
    'hardcoded-key': re.compile(r'(?:api[_-]?key|token|password|secret)\s*[:=]\s*[\"\'][A-Za-z0-9_-]{24,}[\"\']', re.I),
    'private-host-path': re.compile(r'/home/ubuntu/|jxnu-hpc'),
    'private-session-id': re.compile(r'\b01a12[a-f0-9]{3}-[a-f0-9-]{20,}\b'),
}
FORBIDDEN_NAMES = {'auth.json', 'providers.json', 'models.json', 'settings.json', '.env', 'id_rsa', 'id_ed25519'}
ALLOWED_TOP = {'.github', '.gitignore', 'LICENSE', 'NOTICE', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'package.json', 'bin', 'scripts', 'config', 'agents', 'extensions', 'skills', 'integration', 'docs', 'patches', 'vendor', 'tests'}
findings = []
count = 0
size = 0
for path in sorted(ROOT.rglob('*')):
    rel = path.relative_to(ROOT)
    if any(part in EXCLUDED for part in rel.parts):
        continue
    if path.is_symlink():
        findings.append({'path': str(rel), 'rule': 'publication-symlink'})
        continue
    if not path.is_file():
        continue
    count += 1
    size += path.stat().st_size
    if rel.parts[0] not in ALLOWED_TOP:
        findings.append({'path': str(rel), 'rule': 'outside-publication-whitelist'})
    if path.name in FORBIDDEN_NAMES or path.suffix in {'.log', '.jsonl', '.bak'}:
        findings.append({'path': str(rel), 'rule': 'runtime-private-file'})
    if path.stat().st_size > 5 * 1024 * 1024:
        findings.append({'path': str(rel), 'rule': 'oversized-asset'})
    if path.suffix.lower() in {'.png', '.jpg', '.webp'}:
        continue
    try:
        text = path.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        findings.append({'path': str(rel), 'rule': 'unexpected-binary'})
        continue
    # This checker includes its own negative patterns; don't report literal rules.
    if rel == Path('scripts/check-release.py'):
        continue
    for rule, pattern in PATTERNS.items():
        if pattern.search(text):
            findings.append({'path': str(rel), 'rule': rule})
    if path.suffix == '.json':
        try:
            json.loads(text)
        except ValueError:
            findings.append({'path': str(rel), 'rule': 'invalid-json'})
print(json.dumps({'files': count, 'bytes': size, 'findings': findings,
                  'scope': 'publication allow-list and bounded credential patterns; images separately visually reviewed'}, indent=2))
sys.exit(1 if findings else 0)
