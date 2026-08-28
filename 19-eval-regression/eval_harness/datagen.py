"""Templated builder for the golden dataset.

Six task categories, each with a parameter space large enough that
items never collide, and every item carrying both the right answer and
the wrong answer a failing model gives (the distractor is a realistic
error for the category: off-by-one weekday, wrong conversion factor,
swapped day and month, flipped yes/no). The committed data/golden.jsonl
is exactly build_golden_items() with the defaults; a test holds that
equality so the file and the builder cannot drift apart.
"""

import random
from datetime import date, timedelta

from .data import GoldenItem, validate_items

DEFAULT_SEED = 118
DEFAULT_PER_CATEGORY = 40

_MAX_DRAW_ATTEMPTS = 1000

WEEKDAYS = (
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
)

MONTHS = (
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
)

SERVICES = (
    "auth-gateway", "billing-api", "search-indexer", "payment-router",
    "email-dispatch", "user-profile", "rate-limiter", "session-store",
    "audit-logger", "export-worker", "webhook-relay", "media-resizer",
    "notification-hub", "invoice-builder", "catalog-sync", "fraud-scorer",
    "feature-flags", "geo-resolver", "report-runner", "queue-broker",
    "token-minter", "backup-agent", "metrics-collector", "schema-registry",
)

INCIDENT_TEMPLATES = (
    "after the morning deploy, {svc} started timing out while {other} stayed healthy. which service degraded?",
    "on-call report: {svc} is returning 500s; {other} looks normal. which service is failing?",
    "latency alarms fired for {svc} at 09:40 but {other} held its p99. which service regressed?",
    "the incident channel says {svc} dropped requests during the migration and {other} was unaffected. which service dropped requests?",
    "dashboards show error budget burn on {svc}; {other} is green. which service is burning error budget?",
    "customers reported failures traced to {svc}, not to {other}. which service caused the failures?",
    "the rollback fixed {svc} while {other} never changed behavior. which service needed the rollback?",
    "pager history: three pages for {svc} overnight, zero for {other}. which service paged?",
)

NEGATION_VERBS = (
    "restart", "delete", "scale", "deploy", "modify", "access",
    "export", "archive", "rotate", "merge", "publish", "suspend",
    "truncate", "clone", "reindex", "throttle",
)

NEGATION_OBJECTS = (
    "the production database", "user records", "the payment queue",
    "api keys", "the audit log", "customer exports",
    "the staging cluster", "service accounts", "billing data",
    "the search index", "session tokens", "the release branch",
    "the secrets vault", "retention policies",
)

NEGATION_FRAMES = (
    "the policy states that engineers {rule} {verb} {obj} without approval.",
    "the runbook says the on-call engineer {rule} {verb} {obj} without approval.",
)

UNIT_CONVERSIONS = (
    # (source unit, target unit, true factor, wrong factor a sloppy model uses)
    ("minutes", "seconds", 60, 100),
    ("hours", "minutes", 60, 100),
    ("kilobytes", "bytes", 1024, 1000),
)

_DATE_START = date(2005, 1, 1)
_DATE_SPAN_DAYS = (date(2035, 12, 31) - _DATE_START).days


def _arithmetic(rng: random.Random) -> tuple[str, str, str]:
    op = rng.choice(("+", "-", "*"))
    if op == "*":
        a, b = rng.randrange(2, 41), rng.randrange(2, 41)
        value = a * b
    else:
        a, b = rng.randrange(12, 997), rng.randrange(7, 899)
        value = a + b if op == "+" else a - b
    text = f"compute {a} {op} {b}. answer with the number only."
    wrong = value + rng.choice((-10, -1, 1, 10))
    return text, str(value), str(wrong)


def _date(rng: random.Random) -> tuple[str, str, str]:
    d = _DATE_START + timedelta(days=rng.randrange(_DATE_SPAN_DAYS + 1))
    text = f"what day of the week was {d.isoformat()}?"
    return text, WEEKDAYS[d.weekday()], WEEKDAYS[(d.weekday() + 1) % 7]


def _entity(rng: random.Random) -> tuple[str, str, str]:
    svc, other = rng.sample(SERVICES, 2)
    text = rng.choice(INCIDENT_TEMPLATES).format(svc=svc, other=other)
    return text, svc, other


def _format(rng: random.Random) -> tuple[str, str, str]:
    month = rng.randrange(1, 13)
    day = rng.choice([d for d in range(1, 13) if d != month])
    year = rng.randrange(1990, 2036)
    text = (
        f"rewrite {MONTHS[month - 1]} {day}, {year} "
        "as an iso 8601 date (yyyy-mm-dd)."
    )
    expected = f"{year:04d}-{month:02d}-{day:02d}"
    swapped = f"{year:04d}-{day:02d}-{month:02d}"
    return text, expected, swapped


def _negation(rng: random.Random) -> tuple[str, str, str]:
    verb = rng.choice(NEGATION_VERBS)
    obj = rng.choice(NEGATION_OBJECTS)
    forbidden = rng.random() < 0.5
    rule = "may not" if forbidden else "may"
    frame = rng.choice(NEGATION_FRAMES).format(rule=rule, verb=verb, obj=obj)
    text = (
        f"{frame} is it allowed to {verb} {obj} without approval? answer yes or no."
    )
    expected = "no" if forbidden else "yes"
    distractor = "yes" if forbidden else "no"
    return text, expected, distractor


def _unit(rng: random.Random) -> tuple[str, str, str]:
    source, target, factor, wrong_factor = rng.choice(UNIT_CONVERSIONS)
    amount = rng.randrange(2, 2400)
    text = f"convert {amount} {source} to {target}. answer with the number only."
    return text, str(amount * factor), str(amount * wrong_factor)


_BUILDERS = {
    "arithmetic": _arithmetic,
    "date": _date,
    "entity": _entity,
    "format": _format,
    "negation": _negation,
    "unit": _unit,
}


def build_golden_items(
    per_category: int = DEFAULT_PER_CATEGORY, seed: int = DEFAULT_SEED
) -> list[GoldenItem]:
    """Deterministic golden set: per_category items for each category."""
    if per_category < 1:
        raise ValueError(f"per_category must be >= 1, got {per_category}")
    rng = random.Random(seed)
    items: list[GoldenItem] = []
    for category in sorted(_BUILDERS):
        build = _BUILDERS[category]
        seen: set[str] = set()
        for index in range(per_category):
            for _ in range(_MAX_DRAW_ATTEMPTS):
                text, expected, distractor = build(rng)
                if text not in seen:
                    break
            else:
                raise RuntimeError(
                    f"could not draw a fresh {category} item after "
                    f"{_MAX_DRAW_ATTEMPTS} attempts; parameter space exhausted"
                )
            seen.add(text)
            items.append(
                GoldenItem(
                    item_id=f"{category}-{index:04d}",
                    category=category,
                    input_text=text,
                    expected=expected,
                    distractor=distractor,
                    difficulty=round(rng.uniform(-0.08, 0.08), 4),
                )
            )
    validate_items(items)
    return items
