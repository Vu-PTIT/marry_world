import base64
import json
from datetime import datetime, timezone
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

DISCLAIMER = "Virtual ceremony keepsake. For entertainment only. Not a legal marriage certificate."


class EvidenceSigner:
    def __init__(self, private_key: str = ""):
        self.key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(private_key, validate=True)) if private_key else Ed25519PrivateKey.generate()
        self.public_key = base64.b64encode(self.key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()

    def issue(self, event_id: str, names: list[str], district: str, now: float) -> dict:
        payload = {
            "version": 1, "issuer": "Wedding World", "eventReference": event_id,
            "couple": names, "district": district,
            "completedAt": datetime.fromtimestamp(now, timezone.utc).isoformat(),
            "disclaimer": DISCLAIMER,
        }
        canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return {"payload": payload, "canonical": canonical,
                "signature": base64.b64encode(self.key.sign(canonical.encode("utf-8"))).decode(),
                "publicKey": self.public_key, "algorithm": "Ed25519"}
