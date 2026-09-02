"""Extraction pipeline: prompt -> parse -> validate -> retry with feedback.

The retry loop feeds the concrete parse or validation error back to the
model, which is the part that actually moves the success rate — a blind
retry re-rolls the dice, a feedback retry tells the model what to fix.

Hard failure policy: after max_retries the pipeline returns a failed
ExtractionResult. It never raises past this boundary and never returns
partially-validated data.
"""
from dataclasses import dataclass, field

from pydantic import ValidationError

from .parsing import ParseError, parse_lenient, parse_strict
from .schemas import TicketExtraction, schema_description


@dataclass
class ExtractionResult:
    ticket_id: str
    success: bool
    data: TicketExtraction | None = None
    attempts: int = 0
    parse_layers: list[str] = field(default_factory=list)
    error: str | None = None


def build_prompt(ticket: dict) -> str:
    return (
        "Extract structured data from this support ticket.\n\n"
        f"Ticket ID: {ticket['id']}\n"
        f"Email:\n{ticket['email']}\n\n"
        f"{schema_description()}"
    )


def build_repair_prompt(ticket: dict, raw_response: str, error: str) -> str:
    return (
        f"{build_prompt(ticket)}\n\n"
        f"Your previous response was rejected:\n{raw_response}\n\n"
        f"Problem: {error}\n"
        "Respond again, fixing exactly this problem."
    )


def _format_validation_error(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err["loc"]) or "(root)"
        parts.append(f"field '{loc}': {err['msg']}")
    return "; ".join(parts)


def extract_ticket(
    client,
    ticket: dict,
    max_retries: int = 2,
    lenient: bool = True,
    feedback: bool = True,
) -> ExtractionResult:
    """Run the full loop for one ticket. 1 + max_retries LLM calls at most.

    feedback=False is the blind-retry control: same loop, same call budget,
    but every attempt resends the original prompt instead of the error.
    """
    result = ExtractionResult(ticket_id=ticket["id"], success=False)
    prompt = build_prompt(ticket)

    for _ in range(1 + max_retries):
        raw = client.complete(prompt)
        result.attempts += 1

        try:
            if lenient:
                obj, layer = parse_lenient(raw)
            else:
                obj, layer = parse_strict(raw), "strict"
        except ParseError as exc:
            result.error = str(exc)
            result.parse_layers.append("parse_failed")
            if feedback:
                prompt = build_repair_prompt(ticket, raw, f"unparseable output: {exc}")
            continue

        result.parse_layers.append(layer)
        try:
            result.data = TicketExtraction.model_validate(obj)
            result.success = True
            result.error = None
            return result
        except ValidationError as exc:
            result.error = _format_validation_error(exc)
            if feedback:
                prompt = build_repair_prompt(ticket, raw, result.error)

    return result
