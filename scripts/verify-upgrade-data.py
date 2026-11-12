"""Back up and fingerprint the installed planner without reporting its contents."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

mode, folder = sys.argv[1], Path(sys.argv[2]).resolve()
folder.mkdir(parents=True, exist_ok=True)
source = Path(os.environ['LOCALAPPDATA']) / 'MYMIND' / 'planner.sqlite'
assert source.is_file(), 'The installed planner database is missing.'
dictation_source = source.with_name('dictation.sqlite')
if dictation_source.is_file():
    with sqlite3.connect(dictation_source.resolve().as_uri()+'?mode=ro',uri=True) as dictation:
        names = [row[0] for row in dictation.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        records = {name: sorted(dictation.execute('SELECT * FROM "'+name.replace('"','""')+'"').fetchall()) for name in names}
        # Audio is binary; hash the canonical rows without exporting contents.
        dictation_hash = hashlib.sha256(repr(records).encode()).hexdigest()
        if mode == 'before':
            with sqlite3.connect(folder / 'dictation-before.sqlite') as backup:dictation.backup(backup)
            (folder / 'dictation-before.json').write_text(json.dumps({'hash':dictation_hash}))
        elif mode == 'after':
            assert dictation_hash == json.loads((folder / 'dictation-before.json').read_text())['hash'], 'Recoverable dictation drafts changed during upgrade.'
            (folder / 'dictation-preserved.json').write_text(json.dumps({'passed':True,'hash':dictation_hash}))
with sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True) as connection:
    tables = ['meta', 'events', 'tasks', 'projects', 'sections', 'categories', 'history', 'requests']
    values = {table: sorted(connection.execute(f'SELECT * FROM {table}').fetchall()) for table in tables}
    fingerprint = hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    summary = {'hash': fingerprint, 'counts': {table: len(rows) for table, rows in values.items()}}
    if mode == 'before':
        with sqlite3.connect(folder / 'planner-before.sqlite') as backup:
            connection.backup(backup)
        (folder / 'before.json').write_text(json.dumps(summary, indent=2))
    elif mode == 'after':
        expected = json.loads((folder / 'before.json').read_text())
        migrated = False
        if summary == expected:
            with sqlite3.connect((folder / 'planner-before.sqlite').resolve().as_uri()+'?mode=ro',uri=True) as previous:
                previous_version = previous.execute('PRAGMA user_version').fetchone()[0]
            current_version = connection.execute('PRAGMA user_version').fetchone()[0]
            if current_version != previous_version:
                assert 2 <= previous_version < current_version <= 4
                migrated = True
        if summary != expected:
            with sqlite3.connect((folder / 'planner-before.sqlite').resolve().as_uri()+'?mode=ro',uri=True) as previous:
                previous_version = previous.execute('PRAGMA user_version').fetchone()[0]
                current_version = connection.execute('PRAGMA user_version').fetchone()[0]
                assert 2 <= previous_version < current_version <= 4
                original = {table: sorted(previous.execute(f'SELECT * FROM {table}').fetchall()) for table in tables}
            for index, row in enumerate(original['tasks']):
                item=json.loads(row[-1])
                if previous_version < 3:item['scheduledDate']=item.get('scheduledDate',item.get('dueDate'))
                if previous_version < 4 and current_version >= 4:item.update(steps=item.get('steps',[]),dependsOnIds=item.get('dependsOnIds',[]))
                original['tasks'][index]=(*row[:-1],json.dumps(item))
            for index, row in enumerate(original['history']):
                state=json.loads(row[2])
                for item in state['tasks']:
                    if previous_version < 3:item['scheduledDate']=item.get('scheduledDate',item.get('dueDate'))
                    if previous_version < 4 and current_version >= 4:item.update(steps=item.get('steps',[]),dependsOnIds=item.get('dependsOnIds',[]))
                original['history'][index]=(*row[:2],json.dumps(state),*row[3:])
            def canonical(value):
                if isinstance(value,str) and value[:1] in ['{','[']:
                    try:return canonical(json.loads(value))
                    except (ValueError,TypeError):pass
                if isinstance(value,(list,tuple)):return [canonical(item) for item in value]
                if isinstance(value,dict):return {key:canonical(item) for key,item in value.items()}
                return value
            assert canonical(values)==canonical(original), 'Planner content changed beyond the expected schema migration.'
            assert summary['counts']==expected['counts']
            migrated=True
        (folder / 'data-preserved.json').write_text(json.dumps({'passed': True, 'schemaMigrationVerified':migrated, **summary}, indent=2))
    else:
        raise ValueError('Expected before or after.')
    print(json.dumps({'mode': mode, 'passed': True, **summary}))
