from retrieval_eval.tokenizer import tokenize


def test_lowercases_and_splits_on_punctuation():
    assert tokenize("Git-Revert creates a new commit!") == [
        "git", "revert", "creates", "a", "new", "commit",
    ]


def test_empty_and_whitespace_input():
    assert tokenize("") == []
    assert tokenize("   \n\t  ") == []


def test_punctuation_only_input():
    assert tokenize("... --- !!! <<<<<<< =======") == []


def test_keeps_numbers_and_alphanumerics():
    assert tokenize("HTTP 429 retry-after k1=1.5") == ["http", "429", "retry", "after", "k1", "1", "5"]


def test_unicode_text_survives():
    assert tokenize("Café naïve résumé") == ["café", "naïve", "résumé"]
    assert tokenize("日本語のテスト") == ["日本語のテスト"]


def test_underscores_split_tokens():
    assert tokenize("snake_case_name") == ["snake", "case", "name"]
