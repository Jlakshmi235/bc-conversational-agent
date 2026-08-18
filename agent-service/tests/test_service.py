from src.pipeline import build_room_options


def test_room_options_can_be_constructed():
    options = build_room_options(participant_identity="client")
    assert options.participant_identity == "client"
