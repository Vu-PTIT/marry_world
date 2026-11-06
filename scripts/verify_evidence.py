"""Verify a locally saved keepsake JSON; no network request or history lookup.

python -m scripts.verify_evidence path/to/evidence.json --public-key TRUSTED_KEY
Get the trusted public key from /api/config during the ceremony. A key inside
the same downloaded file alone is not an independent proof of issuer identity.
"""
import argparse
import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from backend.app.evidence import DISCLAIMER

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('evidence',type=Path)
parser.add_argument('--public-key',required=True,help='Independently trusted Wedding World Ed25519 public key, base64')
args=parser.parse_args()
evidence=json.loads(args.evidence.read_text(encoding='utf8'))
canonical=json.dumps(evidence['payload'],ensure_ascii=False,sort_keys=True,separators=(',',':'))
assert evidence['algorithm']=='Ed25519' and evidence['publicKey']==args.public_key,'Issuer key does not match'
assert evidence['payload']['disclaimer']==DISCLAIMER and evidence['canonical']==canonical,'Payload does not match'
Ed25519PublicKey.from_public_bytes(base64.b64decode(args.public_key)).verify(base64.b64decode(evidence['signature']),canonical.encode())
print('Verified signed virtual ceremony completion. This keepsake has no legal marriage status.')
