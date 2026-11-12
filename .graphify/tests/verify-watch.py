import json
import subprocess
import time
import hashlib
from pathlib import Path

root = Path(__file__).resolve().parents[2]
hub = root / '.graphify'
fixture = root / 'src/shared/graphify-watcher-fixture.ts'
document = root / 'docs/graphify-watcher-fixture.md'
stylesheet = root / 'src/shared/graphify-watcher-fixture.css'
results = []

def state():
    return json.loads((hub / 'output/graph.json').read_text(encoding='utf-8'))

def wait_for(predicate, description):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            if predicate():
                results.append(description)
                print(description, flush=True)
                return
        except (json.JSONDecodeError, OSError):
            pass
        time.sleep(0.5)
    raise AssertionError('Watcher timeout: ' + description)

def labels():
    return {n['label'] for n in state()['nodes']}

def source_nodes():
    return [n for n in state()['nodes'] if n.get('source_file') == 'src/shared/graphify-watcher-fixture.ts']

def vault_has(symbol):
    return any(symbol in p.read_text(encoding='utf-8') for p in (hub / 'obsidian').glob('*.md'))

assert not fixture.exists() and not document.exists() and not stylesheet.exists()
before_sem = {n['id'] for n in state()['nodes'] if n.get('_origin') == 'semantic'}
try:
    fixture.write_text('export function graphifyWatcherOriginal(){return 1;}\n', encoding='utf-8')
    wait_for(lambda: 'graphifyWatcherOriginal()' in labels() and vault_has('graphifyWatcherOriginal'), 'automatic insertion into graph and Obsidian without a build command')
    fixture.write_text('export function graphifyWatcherReplacement(){return 2;}\n', encoding='utf-8')
    wait_for(lambda: 'graphifyWatcherReplacement()' in labels() and 'graphifyWatcherOriginal()' not in labels() and vault_has('graphifyWatcherReplacement') and not vault_has('graphifyWatcherOriginal'), 'automatic replacement and old generated-note removal')
    fixture.unlink()
    wait_for(lambda: not source_nodes() and not vault_has('graphifyWatcherReplacement'), 'automatic deletion from graph and generated Obsidian notes')
    assert {n['id'] for n in state()['nodes'] if n.get('_origin') == 'semantic'} == before_sem
    results.append('semantic nodes preserved across automatic code updates')
    document.write_text('# Watcher semantic fixture\nCurrent document text.\n', encoding='utf-8')
    def doc_current():
        metadata = json.loads((hub / 'output/source-hashes.json').read_text(encoding='utf-8'))
        mirrored = hub / 'obsidian/SourceDocuments/docs_graphify-watcher-fixture_md.md'
        return 'docs/graphify-watcher-fixture.md' in metadata.get('pending_semantic', []) and mirrored.exists() and 'Current document text.' in mirrored.read_text()
    wait_for(doc_current, 'new document automatically mirrored; semantic extraction marked pending')
    check = subprocess.run(['node', str(hub / 'run.cjs'), 'check'], cwd=root, capture_output=True, text=True)
    assert check.returncode != 0 and 'semantic extraction pending' in check.stderr.lower()
    results.append('strict check rejects pending semantic extraction')
    stop = subprocess.run(['node', str(hub / 'run.cjs'), 'stop-hook'], cwd=root, input='{"stop_hook_active":false}', capture_output=True, text=True)
    assert stop.returncode == 0 and json.loads(stop.stdout)['decision'] == 'block'
    results.append('Claude Stop hook returns valid blocking JSON for pending semantic extraction')
    document.unlink()
    wait_for(lambda: 'docs/graphify-watcher-fixture.md' not in json.loads((hub / 'output/source-hashes.json').read_text()).get('files', {}), 'document deletion automatically cleared pending semantic extraction')
    stylesheet.write_text('.graphify-fixture { color: red; }\n', encoding='utf-8')
    style_rel = 'src/shared/graphify-watcher-fixture.css'
    wait_for(lambda: style_rel in json.loads((hub / 'output/source-hashes.json').read_text()).get('files', {}) and vault_has('graphify-watcher-fixture.css'), 'supplemental CSS file automatically mapped and exported to Obsidian')
    stylesheet.write_text('.graphify-fixture { color: blue; }\n', encoding='utf-8')
    style_hash = hashlib.sha256(stylesheet.read_bytes()).hexdigest()
    wait_for(lambda: json.loads((hub / 'output/source-hashes.json').read_text()).get('files', {}).get(style_rel) == style_hash, 'CSS edit automatically detected and certified')
    stylesheet.unlink()
    wait_for(lambda: style_rel not in json.loads((hub / 'output/source-hashes.json').read_text()).get('files', {}) and not vault_has('graphify-watcher-fixture.css'), 'CSS deletion removed graph and generated vault entries')
finally:
    fixture.unlink(missing_ok=True)
    document.unlink(missing_ok=True)
    stylesheet.unlink(missing_ok=True)
    wait_for(lambda: 'docs/graphify-watcher-fixture.md' not in json.loads((hub / 'output/source-hashes.json').read_text()).get('files', {}), 'fixture cleanup automatically reflected')
subprocess.run(['node', str(hub / 'run.cjs'), 'check'], cwd=root, check=True)
semantic_path = hub / 'output/semantic.json'
semantic_before = semantic_path.read_bytes()
graph_before = (hub / 'output/graph.json').read_bytes()
try:
    semantic_path.write_text('{ invalid fixture', encoding='utf-8')
    wait_for(lambda: json.loads((hub / 'runtime/watch-status.json').read_text()).get('state') == 'retrying', 'watcher records and retries an invalid semantic snapshot')
    assert (hub / 'output/graph.json').read_bytes() == graph_before
finally:
    semantic_path.write_bytes(semantic_before)
wait_for(lambda: json.loads((hub / 'runtime/watch-status.json').read_text()).get('state') == 'running', 'watcher recovers after transient error; original map preserved')
subprocess.run(['node', str(hub / 'run.cjs'), 'check'], cwd=root, check=True)
(hub / 'runtime/verification-watcher.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print('Watcher lifecycle verified.', flush=True)
