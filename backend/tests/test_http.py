import json

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from .conftest import couple


@pytest.fixture
def client(world):
    app=create_app(world)
    app.state.game.lock_local_authority=lambda:None
    with TestClient(app) as client:
        yield client


def receive_kind(socket,kind):
    for _ in range(40):
        message=socket.receive()
        if message.get("text"):
            data=json.loads(message["text"])
            if data.get("type")==kind:return data
    raise AssertionError(f"Did not receive {kind}")


def test_http_temporary_session_and_origin_check(client):
    response=client.post("/api/guests",json={"nickname":"HTTP Guest"})
    assert response.status_code==201
    assert response.headers["cache-control"]=="no-store"
    token=response.json()["token"]
    with client.websocket_connect("/ws",headers={"origin":"http://127.0.0.1:5173"}) as socket:
        socket.send_json({"v":1,"type":"hello","token":token})
        data=receive_kind(socket,"welcome")
        assert data["state"]["self"]["nickname"]=="HTTP Guest"
        assert "token" not in json.dumps(data)
        socket.send_json(["malformed command"])
        assert receive_kind(socket,"command_error")["message"]=="Invalid world command."
    assert client.post("/api/guests",json={"nickname":"Bad Guest","role":"father"}).status_code==422
    assert client.get("/api/health").json()["status"]=="ok"


def test_invitation_server_metadata_and_generic_expiry(client,world):
    a,b,event=couple(world)
    response=client.get(f"/api/invitations/{event.slug}")
    assert response.status_code==200 and response.json()["couple"]==[a.nickname,b.nickname]
    page=client.get(f"/w/{event.slug}")
    assert page.status_code==200
    assert 'property="og:title"' in page.text
    assert 'property="og:image"' in page.text and '/art/vietnam.png' in page.text
    assert a.token not in page.text and b.token not in page.text
    slug=event.slug
    world.finalize(event,"CANCELLED","Cancelled")
    assert client.get(f"/api/invitations/{slug}").status_code==410
    expired=client.get(f"/w/{slug}")
    assert expired.status_code==410 and a.nickname not in expired.text


def test_unicode_validation_and_asset_routes(client):
    assert client.post("/api/guests",json={"nickname":"A\nB"}).status_code==400
    assert client.get("/models/lantern.glb").content[:4]==b"glTF"
    assert client.get("/art/india.png").content[:8]==b"\x89PNG\r\n\x1a\n"
    config=client.get("/api/config").json()
    assert config["protocol"]==1 and config["evidenceRecovery"] is False


def test_guest_appearance_is_validated_and_survives_reconnect(client, world):
    for gender, color in [("female", "#BB626F"), ("male", "#405366")]:
        response = client.post("/api/guests", json={"nickname": "Style Guest", "gender": gender, "clothingColor": color})
        assert response.status_code == 201
        guest = world.guests[response.json()["id"]]
        assert guest.gender == gender and guest.clothing_color == color.lower()
        for _ in range(2):
            with client.websocket_connect("/ws", headers={"origin": "http://127.0.0.1:5173"}) as socket:
                socket.send_json({"v": 1, "type": "hello", "token": guest.token})
                state = receive_kind(socket, "welcome")["state"]
                assert state["self"]["gender"] == gender
                assert state["self"]["clothingColor"] == color.lower()
                nearby = receive_kind(socket, "world")["nearby"]
                appearance = next(p for p in nearby if p["id"] == guest.id)
                assert appearance["gender"] == gender and appearance["clothingColor"] == color.lower()
    for invalid in [{"gender": "unknown"}, {"gender": 1}, {"clothingColor": "red"}, {"clothingColor": "#ffffff00"}, {"clothingColor": "#fff<script>"}]:
        assert client.post("/api/guests", json={"nickname": "Invalid Guest", **invalid}).status_code == 422
    assert client.get("/models/guest-dress.glb").content[:4] == b"glTF"
