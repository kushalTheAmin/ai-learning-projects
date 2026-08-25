"""Compression and cost metrics for tokenizer comparisons."""


def utf8_bytes(text):
    return len(text.encode("utf-8"))


def bytes_per_token(text, n_tokens):
    """UTF-8 bytes represented per token — higher means better compression.
    Empty text (zero tokens) has no meaningful ratio, so it reports 0.0."""
    if n_tokens == 0:
        return 0.0
    return utf8_bytes(text) / n_tokens


def tokens_per_char(text, n_tokens):
    """Tokens spent per character — lower is cheaper. The fair unit for
    cross-script comparisons, where bytes per character already differ."""
    if len(text) == 0:
        return 0.0
    return n_tokens / len(text)


def cost_usd(n_tokens, price_per_mtok):
    """Dollar cost of n_tokens at a price per million tokens."""
    if n_tokens < 0:
        raise ValueError("token count cannot be negative")
    if price_per_mtok < 0:
        raise ValueError("price cannot be negative")
    return n_tokens * price_per_mtok / 1_000_000
