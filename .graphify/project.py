"""Build and verify MYMIND's portable Graphify map, without a separate model/API.

AST extraction is Graphify's cached parser. Semantic input is produced by the
installed skill and saved with content hashes; stale content is never certified.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import shutil
from contextlib import contextmanager
from collections import Counter
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HUB = ROOT / '.graphify'
OUT = HUB / 'output'
VAULT = HUB / 'obsidian'
PIN = '0.9.89'
SCOPE_FILES = ('.graphifyignore', '.gitignore', '.graphify/project.py', '.graphify/output/semantic.json')
os.environ['GRAPHIFY_OUT'] = str(OUT)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def relative(value):
    path = Path(value)
    return path.relative_to(ROOT).as_posix() if path.is_absolute() else path.as_posix()


def write(path, value):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    os.replace(temporary, path)


def corpus():
    from graphify.detect import detect, ignored_predicate
    detection = detect(ROOT)
    ignored = ignored_predicate(ROOT)
    # CSS is real app source but upstream does not classify/parse it. Include
    # stylesheets with honest file-level coverage so edits still trigger refresh.
    for path in (ROOT / 'src').rglob('*.css'):
        if not ignored(path) and str(path) not in detection['files']['code']:
            detection['files']['code'].append(str(path))
            detection['total_files'] += 1
    return detection


def hashes(detection):
    return {relative(f): digest(Path(f)) for files in detection['files'].values() for f in files}


def semantic(detection, allow_pending=False):
    saved = json.loads((OUT / 'semantic.json').read_text(encoding='utf-8'))
    expected = {relative(f) for kind, files in detection['files'].items() if kind != 'code' for f in files}
    current = hashes(detection)
    stale = sorted(f for f in expected if saved['source_hashes'].get(f) != current[f])
    if stale and not allow_pending:
        raise RuntimeError('Semantic extraction required for changed/new files: ' + ', '.join(stale)
                           + '. Use the installed graphify skill, refresh semantic.json and its source_hashes, then rebuild.')
    # Deleted or newly excluded documents never survive a rebuild.
    nodes = [n for n in saved['nodes'] if relative(n['source_file']) in expected - set(stale)]
    ids = {n['id'] for n in nodes}
    edges = [e for e in saved['edges'] if e['source'] in ids and e['target'] in ids]
    hyperedges = [e for e in saved.get('hyperedges', []) if all(n in ids for n in e['nodes'])]
    for item in nodes + edges + hyperedges:
        item['_origin'] = 'semantic'
        if item.get('source_file'):
            item['source_file'] = str(ROOT / relative(item['source_file']))
    # Unattended code refresh must not leave old document claims in the map.
    # Pending documents get current headings/file nodes, not invented semantics.
    for rel in stale:
        source = ROOT / rel
        nid = 'pending_' + re.sub('[^a-z0-9]', '_', rel.lower())
        kind = 'image' if str(source) in detection['files'].get('image', []) else 'document'
        nodes.append({'id': nid, 'label': rel, 'file_type': kind, 'source_file': str(source),
                      'source_location': None, '_origin': 'semantic', 'coverage': 'pending-semantic'})
        if source.suffix.lower() in ('.md', '.txt', '.rst'):
            for line, text in enumerate(source.read_text(encoding='utf-8', errors='replace').splitlines(), 1):
                if text.startswith('#') and text.lstrip('#').strip():
                    heading = f'{nid}_heading_{line}'
                    nodes.append({'id': heading, 'label': text.lstrip('#').strip(), 'file_type': 'concept',
                                  'source_file': str(source), 'source_location': f'L{line}',
                                  '_origin': 'semantic', 'coverage': 'heading-only'})
                    edges.append({'source': nid, 'target': heading, 'relation': 'contains',
                                  'confidence': 'EXTRACTED', 'confidence_score': 1.0,
                                  'source_file': str(source), 'source_location': f'L{line}', '_origin': 'semantic'})
    return nodes, edges, hyperedges, stale


def build(force=False, allow_pending=False):
    (OUT / '.needs_update').write_text('Rebuild in progress; cleared only after map and vault verify.', encoding='utf-8')
    from graphify.extract import extract
    from graphify.build import build_from_json
    from graphify.cluster import cluster, score_all
    from graphify.analyze import god_nodes, surprising_connections, suggest_questions
    from graphify.export import to_json
    from graphify.report import generate
    from graphify.detect import save_manifest
    detection = corpus()
    initial_hashes = hashes(detection)
    initial_scope = {f: digest(ROOT / f) for f in SCOPE_FILES}
    sem_nodes, sem_edges, sem_hyperedges, pending = semantic(detection, allow_pending)
    code_hashes = {relative(f): initial_hashes[relative(f)] for f in detection['files']['code']}
    ast_cache = OUT / '.graphify_ast.json'
    ast = json.loads(ast_cache.read_text(encoding='utf-8')) if ast_cache.exists() else {}
    snapshot = {'version': PIN, 'root': str(ROOT), 'files': code_hashes}
    if ast.get('_snapshot') == snapshot:
        print(f'AST snapshot reused: {len(code_hashes)} unchanged code files; no parsing.')
    else:
        ast = extract([Path(f) for f in detection['files']['code']], cache_root=ROOT, root=ROOT, max_workers=4)
        if ast.get('failed_sources'):
            raise RuntimeError('AST extraction failed for: ' + ', '.join(ast['failed_sources']))
        ast['_snapshot'] = snapshot
        write(ast_cache, ast)
    nodes = ast['nodes'] + sem_nodes
    represented = {relative(n['source_file']) for n in nodes if n.get('source_file')}
    # Some executable scripts/top-level tests contain no AST symbols. Represent
    # them honestly as file nodes; do not fabricate function/call relationships.
    fallback = []
    for f in detection['files']['code']:
        rel = relative(f)
        if rel not in represented:
            fallback.append(rel)
            nodes.append({'id': 'file_' + re.sub('[^a-z0-9]', '_', rel.lower()),
                          'label': rel, 'file_type': 'code', 'source_file': f,
                          'source_location': None, '_origin': 'ast', 'coverage': 'file-only'})
    for f in detection['files']['code']:
        rel = relative(f)
        owned = [n for n in nodes if n.get('source_file') and relative(n['source_file']) == rel]
        if len(owned) == 1 and owned[0]['label'] == Path(f).name and rel not in fallback:
            fallback.append(rel)
            owned[0]['coverage'] = 'file-only'
    extraction = {'nodes': nodes, 'edges': ast['edges'] + sem_edges, 'hyperedges': sem_hyperedges}
    from graphify.diagnostics import diagnose_extraction
    diagnostics = diagnose_extraction(extraction, directed=True, root=ROOT)
    graph = build_from_json(extraction, root=ROOT, directed=True)
    if not graph.number_of_nodes():
        raise RuntimeError('Empty extraction; existing map preserved.')
    communities = cluster(graph)
    cohesion = score_all(graph, communities)
    # Deterministic names grounded in the dominant source file of each community.
    labels = {}
    for cid, members in communities.items():
        files = Counter(graph.nodes[n].get('source_file', '') for n in members)
        dominant = files.most_common(1)[0][0]
        labels[cid] = Path(dominant).stem.replace('-', ' ').replace('_', ' ').title() or f'Community {cid}'
    if not to_json(graph, communities, str(OUT / 'graph.json'), force=force, community_labels=labels):
        raise RuntimeError('Graph shrink guard refused the rebuild. Inspect deletions; use build --force only for intentional shrink.')
    gods = god_nodes(graph)
    surprises = surprising_connections(graph, communities)
    questions = suggest_questions(graph, communities, labels)
    report = generate(graph, communities, cohesion, labels, gods, surprises, detection,
                      {'input': 0, 'output': 0}, '.', suggested_questions=questions)
    report += '\n\n## Coverage and cost limits\n\n'
    report += 'AST extraction and cached rebuilds make no model calls. Initial document/image extraction used the host Codex session; exact token counts are unavailable. The zero counters above are placeholders, not a claim that semantic extraction cost zero tokens.\n\n'
    report += 'This is a directed navigation map, not proof of runtime behavior. Unsupported syntax, dynamic dispatch and runtime IPC may need targeted source inspection. Community detection uses Graphify\'s available local backend.\n\n'
    report += 'Files with only file-level coverage (no symbols returned by the parser):\n' + ''.join(f'- `{f}`\n' for f in fallback)
    report += '\nRaw extraction diagnostics: ' + json.dumps({k: diagnostics.get(k, 0) for k in
               ('dangling_endpoint_edges', 'missing_endpoint_edges', 'self_loop_edges', 'directed_same_endpoint_collapsed_edges')}) + '\n'
    report += 'Self-loops and same-endpoint relationship aggregation are upstream navigation-graph limitations; see the retained diagnostics.json for raw counts.\n'
    if pending:
        report += '\n## Pending semantic extraction\n\nCurrent source is mirrored to Obsidian. Prior semantic claims for these changed files were removed; only current file/headings are mapped until an agent re-extracts them:\n' + ''.join(f'- `{f}`\n' for f in pending)
    write(OUT / 'diagnostics.json', diagnostics)
    (OUT / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
    write(OUT / '.graphify_labels.json', {str(k): v for k, v in labels.items()})
    write(OUT / '.graphify_analysis.json', {'communities': communities, 'cohesion': cohesion, 'gods': gods, 'surprises': surprises, 'questions': questions})
    save_manifest(detection['files'], manifest_path=str(OUT / 'manifest.json'), root=ROOT,
                  scan_corpus={f for files in detection['files'].values() for f in files})
    metadata = {'graphify_version': PIN, 'built_at': datetime.now(timezone.utc).isoformat(),
                                     'files': initial_hashes, 'file_only': fallback,
                                     'pending_semantic': pending,
                                     'scope_hashes': initial_scope}
    (OUT / '.graphify_python').write_text(sys.executable, encoding='utf-8')
    (OUT / '.graphify_root').write_text(str(ROOT), encoding='utf-8')
    subprocess.run([sys.executable, '-m', 'graphify', 'export', 'html'], cwd=ROOT, check=True)
    subprocess.run([sys.executable, '-m', 'graphify', 'export', 'obsidian', '--dir', str(VAULT)], cwd=ROOT, check=True)
    mirror_documents(detection, pending)
    # Certify freshness only after both visualization exports succeed.
    write(VAULT / '.graphify-sync.json', {'graph_sha256': digest(OUT / 'graph.json')})
    check(allow_pending=allow_pending, metadata=metadata)
    write(OUT / 'source-hashes.json', metadata)
    (OUT / '.needs_update').unlink(missing_ok=True)


def mirror_documents(detection, pending):
    folder = VAULT / 'SourceDocuments'
    folder.mkdir(parents=True, exist_ok=True)
    manifest = folder / '.graphify-owned.json'
    previous = set(json.loads(manifest.read_text()) if manifest.exists() else [])
    owned = set()
    for kind, files in detection['files'].items():
        if kind == 'code':
            continue
        for filename in files:
            source = Path(filename)
            rel = relative(filename)
            stem = re.sub('[^a-zA-Z0-9_-]', '_', rel)
            target = folder / (stem + '.md')
            owned.add(target.name)
            content = f'# {rel}\n\nSource: `{rel}`\n\n'
            if kind == 'image':
                image = folder / (stem + source.suffix)
                owned.add(image.name)
                if not image.exists() or digest(image) != digest(source):
                    shutil.copyfile(source, image)
                content += f'![[{image.name}]]\n'
            else:
                content += source.read_text(encoding='utf-8', errors='replace')
            if not target.exists() or target.read_text(encoding='utf-8') != content:
                target.write_text(content, encoding='utf-8')
    for name in previous - owned:
        target = folder / name
        if target.parent == folder and target.is_file():
            target.unlink()
    write(manifest, sorted(owned))
    (VAULT / 'START_HERE.md').write_text(
        '# MYMIND codebase vault\n\nOpen this folder as an Obsidian vault. Use **Graph view** for linked symbols or open the generated `.canvas` file for communities.\n\n'
        'Graphify refreshes generated notes after source edits. Keep personal notes in a separate folder; generated notes are managed exports. `SourceDocuments/` mirrors current docs and images.\n\n'
        + ('Semantic extraction pending for: ' + ', '.join(pending) + '\n' if pending else 'No pending semantic extraction.\n'), encoding='utf-8')


def status(recorded=None):
    if recorded is None:
        recorded = json.loads((OUT / 'source-hashes.json').read_text(encoding='utf-8'))
    current = hashes(corpus())
    changed = sorted(f for f in current if current[f] != recorded['files'].get(f))
    deleted = sorted(set(recorded['files']) - set(current))
    scope_changed = [f for f, value in recorded.get('scope_hashes', {}).items() if digest(ROOT / f) != value]
    print(json.dumps({'changed_or_new': changed, 'deleted_or_excluded': deleted, 'scope_changed': scope_changed,
                     'pending_semantic': recorded.get('pending_semantic', [])}, indent=2))
    return not (changed or deleted or scope_changed)


def check(allow_pending=False, metadata=None):
    if metadata is None and (OUT / '.needs_update').exists():
        raise RuntimeError('Last rebuild incomplete; watcher will retry. Map/vault are not certified current.')
    data = json.loads((OUT / 'graph.json').read_text(encoding='utf-8'))
    nodes = data['nodes']
    edges = data.get('links', data.get('edges', []))
    ids = {n['id'] for n in nodes}
    if not nodes or not edges or len(ids) != len(nodes):
        raise RuntimeError('Graph must have nodes, edges, and unique node IDs.')
    if any(e['source'] not in ids or e['target'] not in ids for e in edges):
        raise RuntimeError('Graph has dangling edge endpoints.')
    expected = set(hashes(corpus()))
    represented = {relative(n['source_file']) for n in nodes if n.get('source_file')}
    missing = sorted(expected - represented)
    if missing:
        raise RuntimeError('Detected files missing from map: ' + ', '.join(missing))
    unexpected = {f for f in represented - expected if not f.startswith('__')}
    if unexpected:
        raise RuntimeError('Excluded/deleted files still mapped: ' + ', '.join(sorted(unexpected)))
    if not data.get('directed'):
        raise RuntimeError('Directed relationships lost.')
    for name in ('GRAPH_REPORT.md', 'graph.html', 'manifest.json'):
        if not (OUT / name).exists() or not (OUT / name).stat().st_size:
            raise RuntimeError('Missing/empty output: ' + name)
    if not status(metadata):
        raise RuntimeError('Map is stale. Run npm run graphify:build; changed docs/images need semantic extraction first.')
    pending = (metadata or json.loads((OUT / 'source-hashes.json').read_text(encoding='utf-8'))).get('pending_semantic', [])
    if pending and not allow_pending:
        raise RuntimeError('Source map/vault current, but semantic extraction pending: ' + ', '.join(pending))
    if not (VAULT / 'START_HERE.md').exists() or not list(VAULT.glob('*.canvas')):
        raise RuntimeError('Missing Obsidian vault/canvas export.')
    sync = json.loads((VAULT / '.graphify-sync.json').read_text(encoding='utf-8'))
    if sync['graph_sha256'] != digest(OUT / 'graph.json'):
        raise RuntimeError('Obsidian vault is out of sync with graph.json.')
    canvas = json.loads((VAULT / 'graph.canvas').read_text(encoding='utf-8'))
    canvas_ids = {n['id'] for n in canvas['nodes']}
    if len(canvas_ids) != len(canvas['nodes']) or any(e['fromNode'] not in canvas_ids or e['toNode'] not in canvas_ids for e in canvas['edges']):
        raise RuntimeError('Obsidian canvas has duplicate nodes or dangling connections.')
    for node in canvas['nodes']:
        if node.get('type') == 'file':
            target = (VAULT / node['file']).resolve()
            if not target.is_relative_to(VAULT.resolve()) or not target.is_file():
                raise RuntimeError('Obsidian canvas points to a missing/out-of-vault note: ' + node['file'])
    if pending:
        print('Pending semantic extraction: ' + ', '.join(pending))
    print(f'Graph verified: {len(nodes)} nodes, {len(edges)} edges; all {len(expected)} detected files represented; hashes current.')


@contextmanager
def lock(name):
    runtime = HUB / 'runtime'
    runtime.mkdir(exist_ok=True)
    handle = (runtime / (name + '.lock')).open('a+b')
    try:
        if os.name == 'nt':
            import msvcrt
            if handle.tell() == 0:
                handle.write(b'0')
                handle.flush()
            handle.seek(0)
            for attempt in range(61 if name == 'build' else 1):
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if name != 'build' or attempt == 60:
                        raise
                    time.sleep(0.5)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        handle.close()


def signature():
    return {'files': hashes(corpus()), 'scope': {f: digest(ROOT / f) for f in SCOPE_FILES}}


def refresh_if_needed():
    def needs_refresh():
        missing = (OUT / '.needs_update').exists() or any(not (OUT / f).exists() for f in ('graph.json', 'source-hashes.json', 'GRAPH_REPORT.md', 'graph.html')) or not (VAULT / 'graph.canvas').exists() or not (VAULT / '.graphify-sync.json').exists()
        if not missing:
            missing = json.loads((VAULT / '.graphify-sync.json').read_text(encoding='utf-8'))['graph_sha256'] != digest(OUT / 'graph.json')
        return missing or not status()
    if needs_refresh():
        # The watcher waits for a stable snapshot before accepting deletions.
        with lock('build'):
            # Another builder may have finished while this caller waited.
            if needs_refresh():
                build(force=True, allow_pending=True)


def watch():
    with lock('watch'):
        (HUB / 'runtime/watch.pid').write_text(str(os.getpid()), encoding='utf-8')
        print('Graphify watcher running; polling every 3 seconds with stable-change debounce.', flush=True)
        previous = None
        refreshed = None
        while True:
            try:
                current = signature()
                incomplete = (OUT / '.needs_update').exists()
                if current == previous and (current != refreshed or incomplete):
                    refresh_if_needed()
                    refreshed = current
                previous = current
                state = 'debouncing' if current != refreshed or (OUT / '.needs_update').exists() else 'running'
                write(HUB / 'runtime/watch-status.json', {'pid': os.getpid(), 'last_check': datetime.now(timezone.utc).isoformat(), 'state': state})
            except Exception as error:
                write(HUB / 'runtime/watch-status.json', {'pid': os.getpid(), 'last_check': datetime.now(timezone.utc).isoformat(), 'state': 'retrying', 'error': str(error)})
                print(f'Watcher retry: {error}', flush=True)
            time.sleep(3)


def stop_hook():
    payload = json.load(sys.stdin)
    result = subprocess.run([sys.executable, str(HUB / 'project.py'), 'hook'], cwd=ROOT,
                            capture_output=True, text=True, encoding='utf-8')
    if result.returncode:
        print(json.dumps({'decision': 'block', 'reason': 'Graphify refresh failed: ' + result.stderr[-1500:]}))
        return
    pending = json.loads((OUT / 'source-hashes.json').read_text(encoding='utf-8')).get('pending_semantic', [])
    if pending and not payload.get('stop_hook_active'):
        print(json.dumps({'decision': 'block', 'reason': 'Refresh semantic extraction in .graphify/output/semantic.json for ' + ', '.join(pending) + ', then run npm run graphify:build and npm run graphify:check. See .graphify/AGENT_GUIDE.md.'}))
    else:
        print('{}')


if __name__ == '__main__':
    os.chdir(ROOT)
    os.environ['GRAPHIFY_NO_AUTO_REFRESH'] = '1'
    try:
        if version('graphifyy') != PIN:
            raise RuntimeError(f'Expected graphifyy=={PIN}; reinstall the pinned environment.')
        command = sys.argv[1]
        if command == 'build':
            with lock('build'):
                build(force='--force' in sys.argv[2:], allow_pending='--allow-pending' in sys.argv[2:])
        elif command == 'check':
            with lock('build'):
                check()
        elif command == 'status':
            sys.exit(0 if status() else 1)
        elif command == 'watch':
            watch()
        elif command == 'hook':
            refresh_if_needed()
        elif command == 'stop-hook':
            stop_hook()
        else:
            raise RuntimeError('Expected build, check, or status.')
    except (RuntimeError, OSError, KeyError, ValueError) as error:
        print(f'Graphify: {error}', file=sys.stderr)
        sys.exit(1)
