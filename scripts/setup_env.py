"""Create a local environment file without printing the private signing key."""
import base64
import secrets
from pathlib import Path

root=Path(__file__).resolve().parents[1]
target=root/'.env'
if target.exists():
    print('.env already exists; left it unchanged.')
else:
    content=(root/'.env.example').read_text(encoding='utf8')
    content=content.replace('COMPLETION_PRIVATE_KEY=\n','COMPLETION_PRIVATE_KEY='+base64.b64encode(secrets.token_bytes(32)).decode()+'\n')
    target.write_text(content,encoding='utf8')
    print('Created .env with a private completion signing key. Keep this file out of version control.')
