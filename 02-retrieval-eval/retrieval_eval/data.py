import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Query:
    text: str
    relevant: tuple[str, ...]


def _read_jsonl(path: Path) -> list[tuple[int, dict]]:
    records = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as err:
            raise ValueError(f"{path.name} line {line_number}: invalid json ({err})") from err
        if not isinstance(record, dict):
            raise ValueError(f"{path.name} line {line_number}: expected an object")
        records.append((line_number, record))
    return records


def load_corpus(path: Path) -> dict[str, str]:
    """Load corpus.jsonl into {doc_id: 'title\\ntext'}."""
    docs: dict[str, str] = {}
    for line_number, record in _read_jsonl(path):
        for field in ("id", "title", "text"):
            if not isinstance(record.get(field), str) or not record[field].strip():
                raise ValueError(
                    f"{path.name} line {line_number}: missing or empty field {field!r}"
                )
        if record["id"] in docs:
            raise ValueError(f"{path.name} line {line_number}: duplicate doc id {record['id']!r}")
        docs[record["id"]] = f"{record['title']}\n{record['text']}"
    if not docs:
        raise ValueError(f"{path.name}: corpus is empty")
    return docs


def load_queries(path: Path, corpus: dict[str, str]) -> list[Query]:
    """Load queries.jsonl, validating every relevant id exists in the corpus."""
    queries: list[Query] = []
    for line_number, record in _read_jsonl(path):
        text = record.get("query")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"{path.name} line {line_number}: missing or empty field 'query'")
        relevant = record.get("relevant")
        if not isinstance(relevant, list) or not relevant:
            raise ValueError(
                f"{path.name} line {line_number}: 'relevant' must be a non-empty list"
            )
        for doc_id in relevant:
            if doc_id not in corpus:
                raise ValueError(
                    f"{path.name} line {line_number}: relevant id {doc_id!r} not in corpus"
                )
        queries.append(Query(text=text, relevant=tuple(relevant)))
    if not queries:
        raise ValueError(f"{path.name}: no queries found")
    return queries
