import pytest
from backend.app.evidence import EvidenceSigner
from backend.app.map import MAP, local_to_world
from backend.app.world import World


class Clock:
    def __init__(self):
        self.value = 1_799_000_000.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


@pytest.fixture
def world():
    game = World(EvidenceSigner(), max_guests=1000)
    game.clock = Clock()
    game.now = game.clock
    return game


def guest(world, name="Lan Nguyễn"):
    player = world.create_guest(name)
    world.connect(player.token)
    return player


def couple(world, district="vietnam"):
    a, b = guest(world, "Lan Nguyễn"), guest(world, "Minh Trần")
    a.x, a.z = MAP["registrar"]
    proposal = world.command(a, "propose", {"partnerCode": b.code, "district": district})
    result = world.command(b, "consent", {"proposalId": proposal["proposalId"], "accept": True})
    return a, b, world.weddings[result["eventId"]]


def active_couple(world, district="vietnam"):
    a, b, event = couple(world, district)
    world.tick_events()
    world.tick_events()
    a.x, a.z = b.x, b.z = local_to_world(district, *MAP["readyPoint"])
    for player in (a, b):
        world.command(player, "ready", {"eventId": event.id})
    world.tick_events()
    assert event.state == "CEREMONY_ACTIVE"
    return a, b, event
