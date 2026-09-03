"""Train byte-level BPE on the committed corpus and measure what vocabulary
size, training domain, and script actually do to token counts — and
therefore to cost, since API usage is priced per token.

Everything here is deterministic: no randomness, pinned tie-breaks.
"""

from pathlib import Path

from baselines import CharTokenizer, WordTokenizer
from bpe import ByteBPE
from metrics import bytes_per_token, cost_usd, tokens_per_char, utf8_bytes

DATA = Path(__file__).parent / "data"

MAX_VOCAB = 2048
VOCAB_SWEEP = [256, 512, 1024, 2048]

# Assumed example rate for the cost section. Not any provider's real price:
# the ratios between rows are the measurement, the absolute rate is an input.
PRICE_PER_MTOK = 3.00


def load(relpath):
    return (DATA / relpath).read_text(encoding="utf-8")


def check_round_trip(tokenizer, texts):
    return all(tokenizer.decode(tokenizer.encode(t)) == t for t in texts)


def main():
    train_prose = load("train/prose.txt")
    train_code = load("train/code.txt")
    heldout = {
        "prose": load("heldout/prose.txt"),
        "code": load("heldout/code.txt"),
        "unicode": load("heldout/unicode.txt"),
    }

    print("=== corpus ===")
    print(f"train prose:  {utf8_bytes(train_prose):>6} bytes")
    print(f"train code:   {utf8_bytes(train_code):>6} bytes")
    for name, text in heldout.items():
        print(f"heldout {name + ':':<9}{utf8_bytes(text):>5} bytes")

    prose_bpe = ByteBPE.train(train_prose, MAX_VOCAB)
    mixed_bpe = ByteBPE.train(train_prose + "\n" + train_code, MAX_VOCAB)
    print(f"\nprose-trained bpe: {len(prose_bpe.merges)} merges "
          f"(vocab {prose_bpe.vocab_size})")
    print(f"mixed-trained bpe: {len(mixed_bpe.merges)} merges "
          f"(vocab {mixed_bpe.vocab_size})")
    for name, bpe in [("prose", prose_bpe), ("mixed", mixed_bpe)]:
        if bpe.vocab_size < MAX_VOCAB:
            print(f"note: {name} training stopped early — no pair left with "
                  f"count >= 2 after {len(bpe.merges)} merges")

    print("\n=== vocab size vs compression (prose-trained, heldout prose) ===")
    print(f"{'vocab':>6} {'tokens':>7} {'bytes/token':>12} {'vs raw bytes':>13}")
    raw = utf8_bytes(heldout["prose"])
    for size in VOCAB_SWEEP:
        sub = prose_bpe.truncated(size)
        n = len(sub.encode(heldout["prose"]))
        print(f"{sub.vocab_size:>6} {n:>7} {bytes_per_token(heldout['prose'], n):>12.2f} "
              f"{(1 - n / raw) * 100:>12.1f}%")

    # The mixed corpus is bigger, so it supports more merges before the
    # count >= 2 floor. The third column truncates the mixed tokenizer to
    # the prose tokenizer's vocab so the domain effect is not confounded
    # with the vocab-size effect.
    mixed_matched = mixed_bpe.truncated(prose_bpe.vocab_size)
    print("\n=== domain transfer (bytes/token, higher = cheaper) ===")
    print(f"{'heldout':>8} {'prose@' + str(prose_bpe.vocab_size):>12} "
          f"{'mixed@' + str(mixed_bpe.vocab_size):>12} "
          f"{'mixed@' + str(mixed_matched.vocab_size):>12}")
    domain_tokens = {}
    for name, text in heldout.items():
        row = {label: len(bpe.encode(text))
               for label, bpe in [("prose", prose_bpe), ("mixed", mixed_bpe),
                                  ("matched", mixed_matched)]}
        domain_tokens[name] = row
        print(f"{name:>8} {bytes_per_token(text, row['prose']):>12.2f} "
              f"{bytes_per_token(text, row['mixed']):>12.2f} "
              f"{bytes_per_token(text, row['matched']):>12.2f}")

    # The matched column is the only controlled comparison here, and it cuts
    # both ways: at one fixed vocab budget, the slots code merges take are
    # slots prose merges do not get. The mixed@full column hides that, because
    # its extra slots pay for both domains at once.
    code_cut = 1 - domain_tokens["code"]["matched"] / domain_tokens["code"]["prose"]
    prose_cost = domain_tokens["prose"]["matched"] / domain_tokens["prose"]["prose"] - 1
    print(f"at a matched {mixed_matched.vocab_size} vocab, adding code to training "
          f"cuts code tokens {code_cut * 100:.1f}% and costs prose "
          f"{prose_cost * 100:.1f}% — one budget, two domains, already crowding")

    print("\n=== script cost (mixed-trained, tokens per character) ===")
    print(f"{'text':>18} {'tokens/char':>12}")
    prose_tpc = tokens_per_char(heldout["prose"], domain_tokens["prose"]["mixed"])
    print(f"{'english prose':>18} {prose_tpc:>12.3f}")
    for line in heldout["unicode"].splitlines():
        if ": " not in line:
            continue
        label, _, body = line.partition(": ")
        tpc = tokens_per_char(body, len(mixed_bpe.encode(body)))
        print(f"{label.lower():>18} {tpc:>12.3f}  ({tpc / prose_tpc:>4.1f}x english)")

    # The word tokenizer gets the same budget as the mixed bpe, but it cannot
    # spend it: the training text holds fewer word types than the budget has
    # slots, so it takes every type it saw and stops. The vocabs are not
    # matched, and the oov rates below are the ceiling for a closed word
    # vocabulary on this corpus rather than a budget handicap.
    word_vocab = mixed_bpe.vocab_size
    word = WordTokenizer.train(train_prose + "\n" + train_code, word_vocab)
    char = CharTokenizer.train(train_prose + "\n" + train_code)
    print(f"\n=== baselines (word tokenizer, vocab {word.vocab_size}) ===")
    print(f"budget was {word_vocab} slots to match the mixed bpe; "
          f"{word_vocab - word.vocab_size} went unspent — the training text "
          f"has only {word.vocab_size - 1} word types, so the oov rates below "
          f"are the best a closed word vocab does here, not a smaller budget")
    for name, text in heldout.items():
        oov, total = word.oov_stats(text)
        print(f"word tokenizer, heldout {name}: {oov}/{total} tokens are OOV "
              f"({oov / total * 100:.1f}%) — each one decodes to <unk>")
    print(f"char tokenizer: vocab {char.vocab_size}, "
          f"{len(char.unseen_chars(heldout['unicode']))} distinct heldout-unicode "
          f"chars unseen in training")

    all_texts = list(heldout.values()) + [train_prose, train_code]
    bpe_ok = all(check_round_trip(b, all_texts) for b in (prose_bpe, mixed_bpe))
    word_lossy = any(word.decode(word.encode(t)) != t for t in heldout.values())
    print(f"\nbpe round-trips every file exactly: {bpe_ok}")
    print(f"word baseline is lossy on heldout: {word_lossy}")
    if not bpe_ok:
        raise SystemExit("bpe round-trip failed — tokenizer is broken")

    print(f"\n=== cost (assumed ${PRICE_PER_MTOK:.2f} per million tokens — "
          f"example rate, not a real price) ===")
    per_mb = {}
    for label in ["prose", "mixed"]:
        n = domain_tokens["code"][label]
        scale = 1_000_000 / utf8_bytes(heldout["code"])
        per_mb[label] = cost_usd(round(n * scale), PRICE_PER_MTOK)
        print(f"1 MB of code through {label}-trained bpe: "
              f"~{round(n * scale):,} tokens = ${per_mb[label]:.2f}")
    ratio = per_mb["prose"] / per_mb["mixed"]
    print(f"the prose-only tokenizer pays {(ratio - 1) * 100:.1f}% more for the "
          f"same code — training on code too cuts the bill "
          f"{(1 - 1 / ratio) * 100:.1f}%")
    n_base = len(prose_bpe.truncated(256).encode(heldout["prose"]))
    n_full = domain_tokens["prose"]["prose"]
    print(f"vocab 256 -> {prose_bpe.vocab_size} on heldout prose: "
          f"{n_base} -> {n_full} tokens, "
          f"{n_base / n_full:.1f}x cost difference at any price")


if __name__ == "__main__":
    main()
