"""Build a self-contained offline speech runtime; downloads happen only here."""
import hashlib
import json
import shutil
import importlib.metadata
import sys
import urllib.request
from pathlib import Path
from huggingface_hub import snapshot_download

root = Path(__file__).resolve().parent.parent
output = root/'speech-runtime'
files = ['model.bin','config.json','tokenizer.json','vocabulary.json','vocabulary.txt','preprocessor_config.json']
models = [('vokasug/faster-whisper-large-v3-turbo-int8','model','955eeeca9313352edb2ee4857ac836e599722da0'), ('Systran/faster-whisper-base','preview-model','ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66')]
manifest = {'models':[], 'kokoro_onnx':'0.6.1','kokoro_model_release':'model-files-v1.1','voice':'bm_george'}
for repo, folder, revision in models:
    model = Path(snapshot_download(repo,revision=revision,allow_patterns=files))
    destination = output/folder
    destination.mkdir(parents=True,exist_ok=True)
    for name in files:
        if (model/name).is_file():
            shutil.copyfile(model/name,destination/name)
    manifest['models'].append({'repo':repo,'revision':model.name})
tts = output/'tts'
tts.mkdir(parents=True,exist_ok=True)
asset_hashes={'kokoro-v1.0.onnx':'beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a','voices-v1.0.bin':'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d'}
for name,expected_hash in asset_hashes.items():
    url = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/'+name
    if not (tts/name).exists():
        print('Downloading '+name,flush=True)
        urllib.request.urlretrieve(url,tts/name)
    digest=hashlib.sha256((tts/name).read_bytes()).hexdigest()
    if digest!=expected_hash:raise RuntimeError(f'{name} does not match the tested asset hash.')
    manifest[name]={'url':url,'sha256':digest}
shutil.copytree(root/'assets'/'third-party',output/'licenses',dirs_exist_ok=True)
(output/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
# Preserve the signed upstream Python executable rather than modifying a bootloader.
# Everything needed by the worker remains inside this offline runtime.
def remove_runtime_directory(path):
    target = path.resolve()
    if not target.is_relative_to(output.resolve()) or not target.is_relative_to(root.resolve()):
        raise RuntimeError('Runtime cleanup must remain inside this workspace.')
    if target.exists():
        shutil.rmtree(target)

remove_runtime_directory(output/'mymind-whisper')
remove_runtime_directory(output/'python')
python_root = Path(sys.base_prefix)
bundled_python = output/'python'
bundled_python.mkdir(parents=True, exist_ok=True)
for name in ['python.exe', 'LICENSE.txt']:
    shutil.copyfile(python_root/name, bundled_python/name)
for library in python_root.glob('*.dll'):
    shutil.copyfile(library, bundled_python/library.name)
shutil.copytree(python_root/'DLLs', bundled_python/'DLLs', ignore=shutil.ignore_patterns('__pycache__'))
shutil.copytree(python_root/'Lib', bundled_python/'Lib', ignore=shutil.ignore_patterns('site-packages','__pycache__','test','tests','idlelib','tkinter','ensurepip','venv'))
site_packages = Path(sys.prefix)/'Lib'/'site-packages'
for requirement in (root/'speech'/'requirements.lock.txt').read_text(encoding='utf-8').splitlines():
    if not requirement.strip() or requirement.startswith('#'):
        continue
    name, version = requirement.split('==')
    distribution = importlib.metadata.distribution(name)
    if distribution.version != version:
        raise RuntimeError(f'{name} does not match the pinned runtime version.')
    for entry in distribution.files or []:
        source = Path(distribution.locate_file(entry)).resolve()
        if not source.is_relative_to(site_packages.resolve()) or '__pycache__' in source.parts or source.suffix=='.pyc':
            continue
        destination = bundled_python/'Lib'/'site-packages'/source.relative_to(site_packages.resolve())
        destination.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source,destination)
version_tag = f'python{sys.version_info.major}{sys.version_info.minor}'
(bundled_python/f'{version_tag}._pth').write_text('Lib\nDLLs\nLib/site-packages\n..\nimport site\n',encoding='utf-8')
shutil.copyfile(root/'speech'/'worker.py', output/'worker.py')
manifest['python'] = {'version':sys.version.split()[0], 'executable_sha256':hashlib.sha256((bundled_python/'python.exe').read_bytes()).hexdigest()}
(output/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print('Built offline speech with the unmodified upstream Python runtime.',flush=True)
