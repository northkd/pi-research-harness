"""Offline Pi RPC fixture. Keep Pi's stdin open until every dialog resolves."""
import base64
import hashlib
import json
import os
import pathlib
import selectors
import subprocess
import sys
import time

cli, root, session_file, extension = sys.argv[1:]
root = pathlib.Path(root)
command = [os.environ.get('PI_QUESTION_NODE', '/usr/bin/node'), cli, '--offline', '--no-mcp', '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--mode', 'rpc', '--session', session_file, '-e', extension]
child = subprocess.Popen(command, cwd=root, env={'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'PI_CODING_AGENT_DIR': str(root / 'agent'), 'PI_OFFLINE': '1'}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
selector = selectors.DefaultSelector()
selector.register(child.stdout, selectors.EVENT_READ)
selector.register(child.stderr, selectors.EVENT_READ)
buffers = {}
events = []
diagnostics = ''

def send(value):
    child.stdin.write((json.dumps(value) + '\n').encode())
    child.stdin.flush()

def wait(predicate):
    global diagnostics
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        for event in events:
            if predicate(event):
                return event
        if child.poll() is not None:
            raise RuntimeError('offline-pi-exited:' + str(child.returncode) + ':' + diagnostics)
        for key, _ in selector.select(0.1):
            chunk = os.read(key.fileobj.fileno(), 65536)
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            data = buffers.get(key.fd, b'') + chunk
            lines = data.split(b'\n')
            buffers[key.fd] = lines.pop()
            for line in lines:
                try:
                    events.append(json.loads(line))
                except (ValueError, UnicodeDecodeError):
                    diagnostics = (diagnostics + line.decode(errors='replace'))[-3000:]
    raise RuntimeError('offline-pi-fixture-timeout:' + diagnostics)

try:
    send({'id': 'offline-state', 'type': 'get_state'})
    assert wait(lambda e: e.get('id') == 'offline-state')['success']
    send({'id': 'offline-question', 'type': 'prompt', 'message': '/__question_rpc_fixture'})
    prompt = wait(lambda e: e.get('type') == 'extension_ui_request' and e.get('method') == 'select')
    assert prompt['options'] == ['First', 'Second'] and not prompt.get('timeout')
    send({'type': 'extension_ui_response', 'id': prompt['id'], 'value': 'Second'})
    assert wait(lambda e: e.get('id') == 'offline-question')['success']

    send({'id': 'offline-image', 'type': 'prompt', 'message': '/__question_image_fixture'})
    pending = wait(lambda e: e.get('fixtureContext', {}).get('toolCallId') == 'synthetic-image-tool' and e['fixtureContext'].get('phase') == 'pending')['fixtureContext']
    header = json.loads(pathlib.Path(session_file).read_text().splitlines()[0])
    session_id = header['id']
    encoded = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    image = base64.b64decode(encoded)
    digest = hashlib.sha256(image).hexdigest()
    target = root / 'question-attachments' / session_id / pending['contextId']
    target.mkdir(mode=0o700, parents=True)
    os.chmod(root / 'question-attachments', 0o700)
    os.chmod(root / 'question-attachments' / session_id, 0o700)
    asset = target / (digest + '.png')
    asset.write_bytes(image)
    asset.chmod(0o600)
    receipt = {'version': 1, 'sessionId': session_id, 'promptId': pending['contextId'], 'sha256': digest, 'mimeType': 'image/png', 'bytes': len(image)}
    response = {'sessionId': session_id, 'response': {'type': 'extension_ui_response', 'id': pending['contextId'], 'value': 'Synthetic image answer', 'attachments': [receipt]}}
    argument = base64.urlsafe_b64encode(json.dumps(response).encode()).decode().rstrip('=')
    send({'id': 'offline-image-answer', 'type': 'prompt', 'message': '/__question_image_answer ' + argument})
    assert wait(lambda e: e.get('id') == 'offline-image')['success']
    assert wait(lambda e: e.get('id') == 'offline-image-answer')['success']
    persisted = [json.loads(line) for line in pathlib.Path(session_file).read_text().splitlines()]
    text = next(entry['data'] for entry in persisted if entry.get('customType') == 'synthetic-question-result')
    output = next(entry['data'] for entry in persisted if entry.get('customType') == 'synthetic-question-image-result')
    assert text['details']['result'] == 'Second'
    assert text['content'][0]['text'] == 'User responded: "Second"'
    assert next(block for block in output['content'] if block['type'] == 'image')['data'] == encoded
    assert output['details']['result']['value'] == 'Synthetic image answer'
    assert pathlib.Path(output['details']['result']['attachments'][0]['path']).read_bytes() == image
    assert any(entry.get('customType') == 'pi-research-question-response' and entry['data'].get('status') == 'accepted' and entry['data'].get('response', {}).get('attachments') for entry in persisted)
    print(json.dumps({'nativeSelect': True, 'modelImage': True, 'persistedReceipt': True, 'imageBytes': len(image)}))
finally:
    if child.poll() is None:
        child.terminate()
        child.wait(timeout=5)
    selector.close()
