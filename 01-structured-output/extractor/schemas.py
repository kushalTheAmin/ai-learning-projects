"""Target schema for support-ticket extraction.

extra="forbid" is deliberate: models love to add a "reasoning" or "notes"
field, and silently accepting it hides drift between prompt and schema.
"""
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Category(str, Enum):
    BILLING = "billing"
    BUG = "bug"
    ACCOUNT = "account"
    FEATURE_REQUEST = "feature_request"
    OTHER = "other"


class Priority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


class TicketExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: Category
    priority: Priority
    sentiment: Literal["positive", "neutral", "negative"]
    summary: str = Field(min_length=1, max_length=200)
    product_areas: list[str]


def schema_description() -> str:
    """Plain-text schema block for the prompt."""
    return (
        "Return ONLY a JSON object with exactly these fields:\n"
        '  "category": one of "billing", "bug", "account", "feature_request", "other"\n'
        '  "priority": one of "low", "medium", "high", "urgent"\n'
        '  "sentiment": one of "positive", "neutral", "negative"\n'
        '  "summary": string, 1-200 characters\n'
        '  "product_areas": array of strings\n'
        "No other fields. No prose. No markdown fences."
    )
