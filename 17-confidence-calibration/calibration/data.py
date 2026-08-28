"""Seeded synthetic support-ticket corpus for intent classification.

Every ticket is assembled from phrase banks: mostly phrases from its own
intent's bank, some class-neutral filler, and, at a controlled rate,
phrases borrowed from a *different* intent. The borrow rate is the
ambiguity knob: a borrowed phrase makes the ticket genuinely look like
two intents at once, so the corpus has irreducible uncertainty by
construction and a perfectly calibrated classifier should NOT be 100%
confident everywhere. A ticket can even draw more borrowed phrases than
own-class ones, which acts as label noise; that is deliberate.

The drifted variant swaps the filler bank for vocabulary the training
set has never seen and raises the borrow rate, modeling the workload
shifting under a deployed model.
"""

from dataclasses import dataclass

import numpy as np

LABELS = ("auth", "billing", "integrations", "performance")

_BANKS: dict[str, tuple[str, ...]] = {
    "auth": (
        "password reset link never arrives",
        "locked out after too many failed attempts",
        "two factor codes are rejected",
        "sso login loops back to the signin page",
        "session expires every few minutes",
        "api key returns unauthorized",
        "oauth token refresh fails silently",
        "cannot revoke a leaked token",
        "saml assertion is rejected by the provider",
        "new team member cannot log in",
        "magic link opens an expired page",
        "permissions look wrong after the role change",
        "the admin console rejects my credentials",
        "password policy rejects every password we try",
    ),
    "billing": (
        "invoice charged twice this month",
        "refund for the annual plan",
        "credit card was declined at renewal",
        "downgrade to the free tier",
        "receipt shows the wrong amount",
        "sales tax missing on the latest invoice",
        "update the billing email address",
        "proration after the seat change looks off",
        "coupon code did not apply at checkout",
        "overage charges on the usage bill",
        "cancel the subscription before renewal",
        "payment failed but we were still charged",
        "the plan price changed without notice",
        "need a copy of last months invoice",
    ),
    "integrations": (
        "the slack integration stopped posting",
        "webhook signatures fail validation",
        "zapier trigger fires twice per event",
        "csv import drops the header row",
        "the salesforce sync writes to the wrong field",
        "calendar events duplicate after reconnecting",
        "github status checks never report back",
        "the export to s3 is missing objects",
        "jira issues are created without labels",
        "api pagination skips records in the connector",
        "the sdk crashes on null metadata",
        "import mapping forgets custom fields",
        "the connected app lost its scopes",
        "email notifications stopped syncing to the crm",
    ),
    "performance": (
        "dashboard takes thirty seconds to load",
        "search queries time out under load",
        "p99 latency doubled since tuesday",
        "exports run slower every week",
        "the api throttles our batch jobs",
        "webhooks arrive minutes late",
        "report generation pegs the cpu",
        "autocomplete lags behind typing",
        "sync takes hours for large workspaces",
        "uploads stall at ninety percent",
        "the mobile app freezes on the activity feed",
        "queries slow down every afternoon",
        "pagination crawls past page fifty",
        "cold starts add seconds to every request",
    ),
}

FILLER = (
    "hoping someone can take a look",
    "this started earlier this week",
    "we are on the enterprise plan",
    "happy to share more details",
    "our team is blocked on this",
    "let me know if logs would help",
    "we tried the steps in the docs",
    "this worked fine last month",
    "it reproduces on a colleagues account",
    "we have a naïve workaround for now",
    "screenshots attached below",
    "thanks in advance for the help",
)

DRIFT_FILLER = (
    "ticket opened from the new support portal",
    "we migrated regions over the weekend",
    "the beta workspace shows the same behavior",
    "reported by three customers today",
    "our msp manages this account",
    "the sev two bridge is still open",
    "compliance review flagged this yesterday",
    "we rolled back the terraform change",
    "observability dashboard linked in the thread",
    "the on call engineer escalated this",
    "reproduced in the staging tenant",
    "this blocks the quarterly launch",
)


@dataclass(frozen=True)
class Ticket:
    text: str
    label: int  # index into LABELS


def class_bank(label: str) -> tuple[str, ...]:
    return _BANKS[label]


def generate_tickets(
    n: int,
    seed: int,
    ambiguity: float = 0.25,
    filler_rate: float = 0.35,
    phrases_per_ticket: int = 6,
    filler_bank: tuple[str, ...] = FILLER,
) -> list[Ticket]:
    """Generate n tickets. Each phrase slot independently draws a
    borrowed phrase from one other intent (prob ambiguity), a neutral
    filler phrase (prob filler_rate), or an own-intent phrase."""
    if n < 0:
        raise ValueError("n must be >= 0")
    if not 0.0 <= ambiguity <= 1.0 or not 0.0 <= filler_rate <= 1.0:
        raise ValueError("rates must be in [0, 1]")
    if ambiguity + filler_rate > 1.0:
        raise ValueError("ambiguity + filler_rate must be <= 1")
    if phrases_per_ticket < 1:
        raise ValueError("phrases_per_ticket must be >= 1")
    rng = np.random.default_rng(seed)
    tickets: list[Ticket] = []
    for _ in range(n):
        label = int(rng.integers(len(LABELS)))
        phrases: list[str] = []
        for _ in range(phrases_per_ticket):
            u = rng.random()
            if u < ambiguity:
                other = int(rng.integers(len(LABELS) - 1))
                if other >= label:
                    other += 1
                bank = _BANKS[LABELS[other]]
            elif u < ambiguity + filler_rate:
                bank = filler_bank
            else:
                bank = _BANKS[LABELS[label]]
            phrases.append(bank[int(rng.integers(len(bank)))])
        tickets.append(Ticket(text=". ".join(phrases) + ".", label=label))
    return tickets


def labels_array(tickets: list[Ticket]) -> np.ndarray:
    return np.array([t.label for t in tickets], dtype=np.int64)
