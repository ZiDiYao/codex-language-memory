"""FSRS adapter. Evidence classification belongs to Codex; scheduling is deterministic."""

from datetime import datetime

from fsrs import Card, Rating, Scheduler


SCHEDULER = Scheduler(enable_fuzzing=False)
ALGORITHM = {
    "name": "FSRS-6",
    "implementation": "fsrs 6.3.2",
    "desired_retention": 0.9,
    "parameter_source": "population_defaults",
    "personal_parameters_trained": False,
}


def recall_rating(result: str, assisted: bool, effort: str) -> Rating | None:
    # Hard is a successful recall, never a partial or failed answer.
    if assisted or result == "skipped":
        return None
    if result in ("partial", "incorrect"):
        return Rating.Again
    return {"standard": Rating.Good, "hard": Rating.Hard, "easy": Rating.Easy}[effort]


def advance(record_id: int, serialized: str | None, rating: Rating, timestamp: str):
    instant = datetime.fromisoformat(timestamp)
    card = Card.from_json(serialized) if serialized else Card(card_id=record_id, due=instant)
    if card.last_review and instant < card.last_review:
        raise ValueError("clock_moved_backwards")
    prediction = SCHEDULER.get_card_retrievability(card, instant) if card.last_review else None
    updated, log = SCHEDULER.review_card(card, rating, review_datetime=instant)
    return updated, log, prediction


def memory_snapshot(serialized: str | None, timestamp: str, rated_reviews: int = 0) -> dict:
    if not serialized:
        return {"assessed": False, "rated_reviews": 0, "estimated_recall": None,
                "due_at": None, "estimate_calibrated": False}
    card = Card.from_json(serialized)
    return {
        "assessed": True,
        "rated_reviews": rated_reviews,
        "estimated_recall": SCHEDULER.get_card_retrievability(card, datetime.fromisoformat(timestamp)),
        "stability_days": card.stability,
        "difficulty": card.difficulty,
        "due_at": card.due.isoformat(timespec="microseconds"),
        "estimate_calibrated": False,
    }
